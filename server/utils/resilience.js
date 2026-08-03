const { log } = require('./logger');

const logger = log('resilience');

/**
 * Timeouts, retries and circuit breakers for outbound calls.
 *
 * Before this module NOTHING in the codebase had a timeout: googleapis (gaxios)
 * waits on a hung socket indefinitely, nodemailer inherits the ~2 minute OS TCP
 * default, and the Gemini SDK has no abort path. A single stalled upstream
 * therefore pinned a worker forever while the next cron tick started another.
 */

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT';
    this.timeout = ms;
  }
}

class CircuitOpenError extends Error {
  constructor(name, retryInMs) {
    super(`Circuit "${name}" is open; upstream is failing fast`);
    this.name = 'CircuitOpenError';
    this.code = 'ECIRCUITOPEN';
    this.retryInMs = retryInMs;
  }
}

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * Note this bounds the CALLER's wait, not the upstream socket; where the client
 * library supports a native timeout (googleapis `timeout`, nodemailer
 * socketTimeout) that is configured as well so the socket is actually released.
 *
 * @param {Promise} promise
 * @param {Number} ms
 * @param {String} label
 * @returns {Promise<*>}
 */
const withTimeout = (promise, ms, label = 'operation') => {
  if (!ms || ms <= 0) return promise;
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      // NOT unref'd. This timer IS the guarantee that a hung call rejects; an
      // unref'd one lets the event loop drain out from under it, so the caller
      // would neither resolve nor reject.
      timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    })
  ]);
};

// NOT unref'd: a backoff delay sits in the middle of an in-flight operation, so
// letting the event loop drain through it would abandon the retry.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is this error worth retrying? Network blips, 429 and 5xx are; 4xx is not
 * (retrying a 403 just burns quota).
 * @param {Error} err
 * @returns {Boolean}
 */
const isRetryable = (err) => {
  if (!err) return false;
  if (err.name === 'CircuitOpenError') return false;
  if (err.name === 'TimeoutError') return true;

  const status = err.status || err.statusCode || err.code || err.response?.status;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;

  const netCodes = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ESOCKETTIMEDOUT'];
  if (netCodes.includes(err.code)) return true;

  return false;
};

/**
 * Retry with full-jitter exponential backoff.
 *
 * @param {Function} fn - async (attemptNumber) => result
 * @param {Object} [options]
 * @param {Number} [options.attempts=3]
 * @param {Number} [options.baseDelayMs=500]
 * @param {Number} [options.maxDelayMs=10000]
 * @param {Function} [options.retryable]
 * @param {String} [options.label]
 * @returns {Promise<*>}
 */
const retry = async (fn, options = {}) => {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 10000,
    retryable = isRetryable,
    label = 'operation'
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt >= attempts || !retryable(err)) throw err;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.floor(Math.random() * ceiling);
      logger.warn({ label, attempt, attempts, delay, err: err.message }, 'retrying after failure');
      await sleep(delay);
    }
  }
  throw lastError;
};

/**
 * A minimal circuit breaker: closed -> open after `failureThreshold`
 * consecutive failures -> half-open after `resetTimeoutMs` -> closed on the
 * next success.
 *
 * Purpose: during an upstream outage, fail in microseconds instead of holding
 * N request contexts open for a full timeout each.
 */
class CircuitBreaker {
  /**
   * @param {String} name
   * @param {Object} [options]
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeoutMs = options.resetTimeoutMs || 30000;
    this.timeoutMs = options.timeoutMs || 0;
    this.state = 'closed';
    this.failures = 0;
    this.openedAt = 0;
  }

  /** @returns {Object} current breaker state, for /readyz and logging */
  stats() {
    return { name: this.name, state: this.state, failures: this.failures, openedAt: this.openedAt };
  }

  /**
   * @param {Function} fn - async () => result
   * @returns {Promise<*>}
   */
  async run(fn) {
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed < this.resetTimeoutMs) {
        throw new CircuitOpenError(this.name, this.resetTimeoutMs - elapsed);
      }
      this.state = 'half-open';
      logger.info({ circuit: this.name }, 'circuit half-open; probing upstream');
    }

    try {
      const result = this.timeoutMs ? await withTimeout(fn(), this.timeoutMs, this.name) : await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure(err);
      throw err;
    }
  }

  onSuccess() {
    if (this.state !== 'closed') logger.info({ circuit: this.name }, 'circuit closed');
    this.state = 'closed';
    this.failures = 0;
  }

  onFailure(err) {
    // A caller error (4xx) says nothing about upstream health.
    if (!isRetryable(err)) return;
    this.failures += 1;
    if (this.failures >= this.failureThreshold && this.state !== 'open') {
      this.state = 'open';
      this.openedAt = Date.now();
      logger.error({ circuit: this.name, failures: this.failures }, 'circuit OPEN; failing fast');
    }
  }
}

const breakers = new Map();

/**
 * Get (or lazily create) a named breaker.
 * @param {String} name
 * @param {Object} [options]
 * @returns {CircuitBreaker}
 */
const getBreaker = (name, options = {}) => {
  if (!breakers.has(name)) breakers.set(name, new CircuitBreaker(name, options));
  return breakers.get(name);
};

/**
 * The full package: circuit breaker + timeout + retry with backoff.
 *
 * @param {String} name - breaker name, e.g. 'gmail', 'gemini', 'smtp'
 * @param {Function} fn - async () => result
 * @param {Object} [options] - { timeoutMs, attempts, baseDelayMs, failureThreshold, resetTimeoutMs }
 * @returns {Promise<*>}
 */
const callResilient = (name, fn, options = {}) => {
  const breaker = getBreaker(name, {
    timeoutMs: options.timeoutMs,
    failureThreshold: options.failureThreshold,
    resetTimeoutMs: options.resetTimeoutMs
  });
  // The breaker owns the timeout so a hung call counts as a failure.
  breaker.timeoutMs = options.timeoutMs || breaker.timeoutMs;

  return retry(() => breaker.run(fn), {
    attempts: options.attempts || 3,
    baseDelayMs: options.baseDelayMs || 500,
    maxDelayMs: options.maxDelayMs || 10000,
    label: name
  });
};

/** @returns {Array<Object>} every breaker's current state */
const breakerStats = () => [...breakers.values()].map((b) => b.stats());

module.exports = {
  withTimeout,
  retry,
  isRetryable,
  callResilient,
  getBreaker,
  breakerStats,
  CircuitBreaker,
  TimeoutError,
  CircuitOpenError,
  sleep
};
