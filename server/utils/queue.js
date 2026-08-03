const crypto = require('crypto');
const { LRUCache } = require('lru-cache');
const { isRedisConfigured, createConnection } = require('./redis');
const { withTimeout } = require('./resilience');
const cache = require('./cache');
const { log } = require('./logger');

const logger = log('queue');

/**
 * Background job queue with two interchangeable backends.
 *
 *   REDIS_URL set   -> BullMQ (durable, shared across replicas, real workers)
 *   REDIS_URL unset -> an in-process runner: still asynchronous, still OFF the
 *                      request path, with the same retry/backoff/dead-letter
 *                      semantics, but not durable across a restart.
 *
 * The point of both backends is the same: nothing slow may run inside an HTTP
 * request. A Gmail sync of ten accounts used to hold one connection open for
 * four to six minutes, which every reverse proxy in existence kills at 30-60s.
 *
 * Job ids are namespaced `<queue>::<rawId>` so a single `GET /api/gmail/sync/:jobId`
 * can resolve a job without the caller knowing which queue it landed on.
 */

const CONCURRENCY = Number(process.env.QUEUE_CONCURRENCY || 3);
const DEFAULT_ATTEMPTS = Number(process.env.QUEUE_ATTEMPTS || 3);
const DEFAULT_BACKOFF_MS = Number(process.env.QUEUE_BACKOFF_MS || 5000);
const MAX_JOB_RECORDS = Number(process.env.QUEUE_MAX_RECORDS || 500);
const JOB_RECORD_TTL_MS = Number(process.env.QUEUE_RECORD_TTL_MS || 60 * 60 * 1000);
const MAX_DEAD_LETTERS = 100;
// BullMQ's connection needs `enableOfflineQueue: true` (it relies on blocking
// commands), which means a command issued while Redis is DOWN queues forever
// instead of failing. Every BullMQ call is therefore bounded, and a timeout
// falls back to the in-process runner rather than hanging the request.
const BULL_OP_TIMEOUT_MS = Number(process.env.QUEUE_REDIS_TIMEOUT_MS || 5000);

const STATES = {
  QUEUED: 'queued',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  FAILED: 'failed',
  UNKNOWN: 'unknown'
};

const handlers = new Map();
const bullQueues = new Map();
const bullWorkers = [];
let bullConnection = null;
let workersStarted = false;
let draining = false;

// ---------------------------------------------------------------------------
// In-process backend
// ---------------------------------------------------------------------------

const localQueues = new Map(); // name -> { pending: [], running: Number }
const localJobs = new LRUCache({ max: MAX_JOB_RECORDS, ttl: JOB_RECORD_TTL_MS, ttlAutopurge: true });
const deadLetters = [];

const useBull = () => isRedisConfigured();

const encodeJobId = (name, rawId) => `${name}::${rawId}`;

/**
 * @param {String} jobId
 * @returns {{name: String, rawId: String}|null}
 */
const decodeJobId = (jobId) => {
  if (typeof jobId !== 'string') return null;
  const index = jobId.indexOf('::');
  if (index <= 0) return null;
  return { name: jobId.slice(0, index), rawId: jobId.slice(index + 2) };
};

const getLocalQueue = (name) => {
  if (!localQueues.has(name)) localQueues.set(name, { pending: [], running: 0 });
  return localQueues.get(name);
};

const jitteredBackoff = (attempt, base) => {
  const ceiling = Math.min(base * 2 ** (attempt - 1), 5 * 60 * 1000);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
};

const recordDeadLetter = (entry) => {
  deadLetters.push(entry);
  while (deadLetters.length > MAX_DEAD_LETTERS) deadLetters.shift();
};

const runLocalJob = async (name, record) => {
  const handler = handlers.get(name);
  if (!handler) {
    record.state = STATES.FAILED;
    record.error = `No handler registered for queue "${name}"`;
    record.finishedAt = new Date().toISOString();
    recordDeadLetter({ queue: name, jobId: record.id, data: record.data, error: record.error });
    return;
  }

  record.state = STATES.ACTIVE;
  record.attemptsMade += 1;
  record.startedAt = new Date().toISOString();

  const context = {
    id: record.id,
    name,
    attempt: record.attemptsMade,
    updateProgress: async (progress) => {
      record.progress = progress;
    },
    log: logger.child({ queue: name, jobId: record.id })
  };

  try {
    const result = await handler(record.data, context);
    record.state = STATES.COMPLETED;
    record.result = result === undefined ? null : result;
    record.finishedAt = new Date().toISOString();
    logger.info({ queue: name, jobId: record.id, attempts: record.attemptsMade }, 'job completed');
  } catch (err) {
    record.error = err.message;
    if (record.attemptsMade < record.attempts) {
      record.state = STATES.QUEUED;
      const delay = jitteredBackoff(record.attemptsMade, record.backoffMs);
      logger.warn({ queue: name, jobId: record.id, attempt: record.attemptsMade, delay, err: err.message },
        'job failed; retrying with backoff');
      // NOT unref'd: a pending retry is real outstanding work, and an unref'd
      // timer would let the process exit with the job silently dropped.
      setTimeout(() => {
        if (draining) return;
        getLocalQueue(name).pending.push(record);
        pumpLocal(name);
      }, delay);
    } else {
      record.state = STATES.FAILED;
      record.finishedAt = new Date().toISOString();
      recordDeadLetter({
        queue: name,
        jobId: record.id,
        data: record.data,
        error: err.message,
        failedAt: record.finishedAt
      });
      logger.error({ queue: name, jobId: record.id, err: err.message, stack: err.stack },
        'job moved to dead-letter after exhausting attempts');
    }
  }
};

const pumpLocal = (name) => {
  const queue = getLocalQueue(name);
  while (!draining && queue.running < CONCURRENCY && queue.pending.length > 0) {
    const record = queue.pending.shift();
    queue.running += 1;
    // setImmediate keeps the enqueueing request from paying any of the cost.
    setImmediate(() => {
      runLocalJob(name, record).finally(() => {
        queue.running -= 1;
        pumpLocal(name);
      });
    });
  }
};

// ---------------------------------------------------------------------------
// BullMQ backend
// ---------------------------------------------------------------------------

const getBullConnection = () => {
  if (bullConnection) return bullConnection;
  // BullMQ requires blocking commands, which is incompatible with
  // maxRetriesPerRequest / enableOfflineQueue tuned for the cache client.
  bullConnection = createConnection({ maxRetriesPerRequest: null, enableOfflineQueue: true }, 'bullmq');
  return bullConnection;
};

const getBullQueue = (name) => {
  if (bullQueues.has(name)) return bullQueues.get(name);
  const connection = getBullConnection();
  if (!connection) return null;
  try {
    const { Queue } = require('bullmq');
    const queue = new Queue(name, {
      connection,
      defaultJobOptions: {
        attempts: DEFAULT_ATTEMPTS,
        backoff: { type: 'exponential', delay: DEFAULT_BACKOFF_MS },
        // Kept (not deleted) so a completed/failed job stays pollable, and the
        // failed set doubles as the dead-letter queue.
        removeOnComplete: { count: 200, age: 24 * 3600 },
        removeOnFail: { count: 500, age: 7 * 24 * 3600 }
      }
    });
    queue.on('error', (err) => logger.warn({ queue: name, err: err.message }, 'BullMQ queue error'));
    bullQueues.set(name, queue);
    return queue;
  } catch (err) {
    logger.warn({ err: err.message }, 'BullMQ unavailable; falling back to the in-process runner');
    return null;
  }
};

const normalizeBullState = (state) => {
  switch (state) {
    case 'waiting':
    case 'waiting-children':
    case 'delayed':
    case 'prioritized':
      return STATES.QUEUED;
    case 'active':
      return STATES.ACTIVE;
    case 'completed':
      return STATES.COMPLETED;
    case 'failed':
      return STATES.FAILED;
    default:
      return STATES.UNKNOWN;
  }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register the processor for a queue. Must be called before workers start.
 * @param {String} name
 * @param {Function} handler - async (data, context) => result
 */
const registerHandler = (name, handler) => {
  handlers.set(name, handler);
};

/**
 * Enqueue a job. Returns immediately — the work happens off the request path
 * on both backends.
 *
 * @param {String} name - queue name
 * @param {Object} data - JSON-serialisable payload
 * @param {Object} [options] - { attempts, backoffMs, delayMs }
 * @returns {Promise<{jobId: String, queue: String, state: String, backend: String}>}
 */
const enqueue = async (name, data = {}, options = {}) => {
  const attempts = options.attempts || DEFAULT_ATTEMPTS;
  const backoffMs = options.backoffMs || DEFAULT_BACKOFF_MS;

  if (useBull()) {
    const queue = getBullQueue(name);
    if (queue) {
      try {
        const job = await withTimeout(
          queue.add(name, data, {
            attempts,
            backoff: { type: 'exponential', delay: backoffMs },
            delay: options.delayMs || 0
          }),
          BULL_OP_TIMEOUT_MS,
          'bullmq.add'
        );
        logger.info({ queue: name, jobId: job.id }, 'job enqueued (bullmq)');
        return { jobId: encodeJobId(name, job.id), queue: name, state: STATES.QUEUED, backend: 'bullmq' };
      } catch (err) {
        logger.warn({ queue: name, err: err.message }, 'BullMQ enqueue failed; using in-process runner');
      }
    }
  }

  const rawId = crypto.randomUUID();
  const record = {
    id: encodeJobId(name, rawId),
    queue: name,
    data,
    state: STATES.QUEUED,
    attempts,
    attemptsMade: 0,
    backoffMs,
    progress: 0,
    result: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null
  };
  localJobs.set(record.id, record);

  const push = () => {
    getLocalQueue(name).pending.push(record);
    pumpLocal(name);
  };
  if (options.delayMs) {
    setTimeout(push, options.delayMs);
  } else {
    push();
  }

  logger.info({ queue: name, jobId: record.id }, 'job enqueued (in-process)');
  return { jobId: record.id, queue: name, state: STATES.QUEUED, backend: 'in-process' };
};

/**
 * Enqueue at most one live job per `dedupeKey`.
 *
 * A user double-clicking "Fetch" used to start a second concurrent full sync
 * with no idempotency guard at all. The claim is held in the shared cache, so
 * it works across replicas when Redis is present and within the process when it
 * is not.
 *
 * @param {String} name
 * @param {String} dedupeKey
 * @param {Object} data
 * @param {Object} [options] - plus { dedupeTtlSeconds }
 * @returns {Promise<{jobId: String, deduped: Boolean, ...}>}
 */
const enqueueUnique = async (name, dedupeKey, data = {}, options = {}) => {
  const cacheKey = `jobclaim:${name}:${dedupeKey}`;
  const existingId = await cache.get(cacheKey);

  if (existingId) {
    const status = await getJobStatus(existingId);
    if (status && (status.state === STATES.QUEUED || status.state === STATES.ACTIVE)) {
      return { jobId: existingId, queue: name, state: status.state, deduped: true };
    }
  }

  const created = await enqueue(name, data, options);
  await cache.set(cacheKey, created.jobId, options.dedupeTtlSeconds || 1800);
  return { ...created, deduped: false };
};

/**
 * @param {String} jobId - as returned by enqueue()
 * @returns {Promise<Object|null>} normalized status, or null when unknown
 */
const getJobStatus = async (jobId) => {
  const decoded = decodeJobId(jobId);
  if (!decoded) return null;

  if (useBull()) {
    const queue = bullQueues.get(decoded.name) || getBullQueue(decoded.name);
    if (queue) {
      try {
        const job = await withTimeout(queue.getJob(decoded.rawId), BULL_OP_TIMEOUT_MS, 'bullmq.getJob');
        if (job) {
          const state = normalizeBullState(await withTimeout(job.getState(), BULL_OP_TIMEOUT_MS, 'bullmq.getState'));
          return {
            jobId,
            queue: decoded.name,
            state,
            progress: job.progress || 0,
            attemptsMade: job.attemptsMade || 0,
            attempts: job.opts?.attempts || DEFAULT_ATTEMPTS,
            result: state === STATES.COMPLETED ? job.returnvalue ?? null : null,
            error: job.failedReason || null,
            createdAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
            finishedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null
          };
        }
      } catch (err) {
        logger.debug({ err: err.message, jobId }, 'BullMQ getJob failed');
      }
    }
  }

  const record = localJobs.get(jobId);
  if (!record) return null;
  return {
    jobId: record.id,
    queue: record.queue,
    state: record.state,
    progress: record.progress,
    attemptsMade: record.attemptsMade,
    attempts: record.attempts,
    result: record.state === STATES.COMPLETED ? record.result : null,
    error: record.error,
    createdAt: record.createdAt,
    finishedAt: record.finishedAt
  };
};

/**
 * Wait (bounded) for a job to reach a terminal state. Used where the HTTP
 * contract needs the result but the work still must not run inline — the
 * request can give up and hand the caller a job id to poll.
 *
 * @param {String} jobId
 * @param {Number} timeoutMs
 * @param {Number} [pollMs=150]
 * @returns {Promise<Object|null>} the last known status
 */
const waitForJob = async (jobId, timeoutMs, pollMs = 150) => {
  const deadline = Date.now() + timeoutMs;
  let status = await getJobStatus(jobId);
  while (status && status.state !== STATES.COMPLETED && status.state !== STATES.FAILED) {
    if (Date.now() >= deadline) return status;
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
    status = await getJobStatus(jobId);
  }
  return status;
};

/**
 * Start the workers for every registered handler. No-op for the in-process
 * backend, where enqueue() already pumps the runner.
 * @returns {void}
 */
const startWorkers = () => {
  if (workersStarted) return;
  workersStarted = true;

  if (!useBull()) {
    logger.info({ backend: 'in-process', queues: [...handlers.keys()] }, 'job runner ready');
    return;
  }

  const connection = getBullConnection();
  if (!connection) {
    logger.warn('REDIS_URL is set but no connection could be created; using the in-process runner');
    return;
  }

  let Worker;
  try {
    ({ Worker } = require('bullmq'));
  } catch (err) {
    logger.warn({ err: err.message }, 'bullmq is not installed; using the in-process runner');
    return;
  }

  for (const [name, handler] of handlers.entries()) {
    const worker = new Worker(
      name,
      async (job) => {
        const context = {
          id: encodeJobId(name, job.id),
          name,
          attempt: job.attemptsMade + 1,
          updateProgress: (progress) => job.updateProgress(progress),
          log: logger.child({ queue: name, jobId: job.id })
        };
        return handler(job.data, context);
      },
      { connection, concurrency: CONCURRENCY }
    );

    worker.on('failed', (job, err) => {
      const exhausted = job && job.attemptsMade >= (job.opts?.attempts || DEFAULT_ATTEMPTS);
      logger[exhausted ? 'error' : 'warn'](
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err?.message },
        exhausted ? 'job moved to the failed set (dead letter)' : 'job attempt failed; will retry'
      );
    });
    worker.on('error', (err) => logger.warn({ queue: name, err: err.message }, 'BullMQ worker error'));

    bullWorkers.push(worker);
  }

  logger.info({ backend: 'bullmq', queues: [...handlers.keys()], concurrency: CONCURRENCY }, 'workers started');
};

/**
 * Register a repeating job. With Redis this is a BullMQ repeatable job so ONE
 * instance runs it cluster-wide; without Redis the caller keeps using node-cron
 * guarded by utils/lock.
 * @param {String} name
 * @param {String} cronPattern
 * @param {Object} [data]
 * @returns {Promise<Boolean>} true when the repeatable job was registered
 */
const scheduleRepeatable = async (name, cronPattern, data = {}) => {
  if (!useBull()) return false;
  const queue = getBullQueue(name);
  if (!queue) return false;
  try {
    await withTimeout(
      queue.add(name, data, {
        repeat: { pattern: cronPattern },
        jobId: `repeat:${name}`,
        removeOnComplete: { count: 20 },
        removeOnFail: { count: 50 }
      }),
      BULL_OP_TIMEOUT_MS,
      'bullmq.repeat'
    );
    logger.info({ queue: name, cronPattern }, 'repeatable job registered');
    return true;
  } catch (err) {
    logger.warn({ queue: name, err: err.message }, 'failed to register repeatable job');
    return false;
  }
};

/** @returns {Array<Object>} the bounded in-process dead-letter list */
const getDeadLetters = () => [...deadLetters];

/**
 * Stop accepting work and close the BullMQ resources.
 * @returns {Promise<void>}
 */
const shutdownQueues = async () => {
  draining = true;
  await Promise.all(
    bullWorkers.map((w) => withTimeout(w.close(), BULL_OP_TIMEOUT_MS, 'worker.close').catch(() => {}))
  );
  await Promise.all(
    [...bullQueues.values()].map((q) => withTimeout(q.close(), BULL_OP_TIMEOUT_MS, 'queue.close').catch(() => {}))
  );
  bullWorkers.length = 0;
  bullQueues.clear();
};

module.exports = {
  QUEUES: {
    GMAIL_SYNC: 'gmail-sync',
    EMAIL_SEND: 'email-send',
    AI_SUMMARIZE: 'ai-summarize',
    // F-3. A separate queue from AI_SUMMARIZE so a burst of extractions cannot
    // starve summarisation (and vice versa) at QUEUE_CONCURRENCY.
    AI_EXTRACT: 'ai-extract',
    KEYWORD_BACKFILL: 'keyword-backfill'
  },
  STATES,
  registerHandler,
  enqueue,
  enqueueUnique,
  getJobStatus,
  waitForJob,
  startWorkers,
  scheduleRepeatable,
  getDeadLetters,
  shutdownQueues,
  backend: () => (useBull() ? 'bullmq' : 'in-process')
};
