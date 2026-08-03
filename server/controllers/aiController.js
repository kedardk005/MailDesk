const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Email = require('../models/Email');
const cache = require('../utils/cache');
const queue = require('../utils/queue');
const { callResilient, getBreaker } = require('../utils/resilience');
const { log } = require('../utils/logger');
const { canAccessEmail } = require('../utils/emailAccess');
const extraction = require('../utils/aiExtraction');

const logger = log('ai');

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 15000);
// How long the HTTP request is willing to wait for the queued job before it
// hands the caller a job id to poll instead.
const AI_INLINE_WAIT_MS = Number(process.env.AI_INLINE_WAIT_MS || 20000);
// F-3: how many messages of a conversation are READ before the newest
// AI_EXTRACT_THREAD_MESSAGES of them are handed to the model. Shares the
// threading cap so a pathological conversation cannot be loaded whole.
const THREAD_READ_CAP = Number(process.env.THREAD_MESSAGE_CAP || 200);

// The client is stateless; it used to be constructed per request.
let client = null;
const getModel = () => {
  if (!client) client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return client.getGenerativeModel({ model: MODEL });
};

/**
 * Reduce an email to a bounded plain-text prompt input.
 *
 * The slice happens BEFORE the tag-stripping regex. The original stripped tags
 * across the entire multi-megabyte base64-laden body and only then took the
 * first 3000 characters — paying 10-200 ms of blocked event loop to throw 99%
 * of the work away.
 *
 * @param {String} body
 * @returns {String}
 */
const toPlainPrompt = (body) => {
  if (!body) return '';
  return body
    .slice(0, 20000)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000);
};

/**
 * Content-addressed cache key. Summaries of identical content are identical, so
 * the key needs no invalidation.
 * @param {String} subject
 * @param {String} plainBody
 * @returns {String}
 */
const summaryKey = (subject, plainBody) =>
  cache.KEYS.aiSummary(crypto.createHash('sha256').update(`${subject || ''}\n${plainBody}`).digest('hex'));

/**
 * The unit of work the `ai-summarize` queue processes.
 * @param {{subject: String, from: String, plainBody: String}} data
 * @returns {Promise<{summary: String}>}
 */
const runSummarizeJob = async ({ subject, from, plainBody }) => {
  const prompt = `You are a business email assistant. Summarize the following email in exactly 3-4 concise bullet points.
Each bullet must start with "• ".
Focus on: the main request or purpose, any action items, deadlines or urgency, and key information.
Keep each bullet under 20 words.

Email Subject: ${subject || '(No Subject)'}
From: ${from || 'Unknown'}
Body: ${plainBody || '(No body content)'}

Respond with only the bullet points, nothing else.`;

  // Timeout + retry on 429/5xx + circuit breaker, so a Gemini outage fails fast
  // instead of queueing a pile of 30-second hangs.
  const result = await callResilient('gemini', () => getModel().generateContent(prompt), {
    timeoutMs: AI_TIMEOUT_MS,
    attempts: Number(process.env.AI_RETRY_ATTEMPTS || 3),
    baseDelayMs: 1000,
    failureThreshold: 5,
    resetTimeoutMs: 30000
  });

  const summary = result.response.text().trim();
  await cache.set(summaryKey(subject, plainBody), { summary }, cache.TTL.aiSummary);
  return { summary };
};

// @desc    Summarize an email body using Gemini
// @route   POST /api/ai/summarize-email
// @access  Private (Admin, Head only)
exports.summarizeEmail = async (req, res) => {
  try {
    const { subject, from, body } = req.body;

    if (!body && !subject) {
      return res.status(400).json({ message: 'Email subject or body is required for summarization.' });
    }

    if (!process.env.GEMINI_API_KEY) {
      // 503, not the old 500/550: this is an unconfigured dependency.
      return res.status(503).json({ message: 'AI service is not configured. GEMINI_API_KEY is missing.' });
    }

    const plainBody = toPlainPrompt(body);
    const key = summaryKey(subject, plainBody);

    // Summarising the same email twice used to cost two full inference calls.
    const hit = await cache.get(key);
    if (hit && hit.summary) {
      res.set('Cache-Control', 'private, max-age=300');
      return res.status(200).json({ summary: hit.summary, cached: true });
    }

    // The inference runs in a worker, not in this request: the request only
    // WAITS on it, and can give up without cancelling the work.
    const job = await queue.enqueue(
      queue.QUEUES.AI_SUMMARIZE,
      { subject, from, plainBody },
      { attempts: Number(process.env.AI_JOB_ATTEMPTS || 2), backoffMs: 2000 }
    );

    // Bind the job to its requester before it can be polled — same claim the
    // extraction endpoint makes. Without it, GET /api/ai/jobs/:jobId served any
    // job to any Admin/Head, and BullMQ ids are small incrementing integers, so
    // one Head could walk the id space and read another Head's summary of a
    // mailbox they have no access to.
    await cache.set(jobOwnerKey(job.jobId), String(req.user._id), JOB_OWNER_TTL);

    const status = await queue.waitForJob(job.jobId, AI_INLINE_WAIT_MS);

    if (status && status.state === queue.STATES.COMPLETED && status.result?.summary) {
      return res.status(200).json({ summary: status.result.summary, cached: false });
    }

    if (status && status.state === queue.STATES.FAILED) {
      logger.warn({ err: status.error, jobId: job.jobId }, 'summarization job failed');
      return res.status(502).json({ message: 'AI summarization failed. Please try again.' });
    }

    // Still running: hand back a pollable job rather than holding the socket.
    return res.status(202).json({
      message: 'Summarization is still running. Poll GET /api/ai/jobs/:jobId.',
      status: status?.state || 'queued',
      jobId: job.jobId
    });
  } catch (error) {
    logger.error({ err: error.message }, 'summarizeEmail failed');
    return res.status(500).json({ message: 'AI summarization failed. Please try again.' });
  }
};

// @desc    Poll a queued summarization job
// @route   GET /api/ai/jobs/:jobId
// @access  Private (the user who created the job, and only them)
exports.getSummarizeJobStatus = async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').slice(0, 200);
    const owner = await cache.get(jobOwnerKey(jobId));

    // 404 — never 403 — for "no such job", "expired" and "someone else's job"
    // alike, so this cannot be used to confirm that a job id exists. Matches
    // GET /api/ai/extract-actions/:jobId.
    if (!owner || String(owner) !== String(req.user._id)) {
      return res.status(404).json({ message: 'Summarization job not found or expired.' });
    }

    const status = await queue.getJobStatus(jobId);
    if (!status) return res.status(404).json({ message: 'Summarization job not found or expired.' });

    return res.status(200).json({
      jobId: status.jobId,
      status: status.state,
      summary: status.result?.summary || null,
      error: status.error || null
    });
  } catch (error) {
    logger.error({ err: error.message }, 'getSummarizeJobStatus failed');
    return res.status(500).json({ message: 'Server error. Failed to read summarization status.' });
  }
};

// ---------------------------------------------------------------------------
// F-3 — action-item extraction
// ---------------------------------------------------------------------------

/**
 * Cache key for one extraction. Content-addressed, exactly like the summary
 * cache: see the note on `aiExtraction.documentHash` for why no role or user
 * component belongs in this key.
 *
 * @param {String} document
 * @returns {String}
 */
const extractionKey = (document) => cache.KEYS.aiActions(extraction.documentHash(document, MODEL));

// Who is allowed to poll a given extraction job. Not a KEYS entry because it is
// per-job ephemeral bookkeeping, not a cached read model.
const jobOwnerKey = (jobId) => `aijob:owner:${jobId}`;
const JOB_OWNER_TTL = Number(process.env.AI_JOB_OWNER_TTL || 3600);

/**
 * The unit of work the `ai-extract` queue processes.
 *
 * NOTE the ordering: the model output is parsed and sanitised BEFORE anything
 * is cached or returned, so an unbounded or hostile response can never be
 * stored for 30 days and replayed to every later caller.
 *
 * @param {{document: String}} data
 * @returns {Promise<{actions: Array<Object>, suggestedClient: String|null, model: String}>}
 */
const runExtractActionsJob = async ({ document }) => {
  const prompt = extraction.buildPrompt(document);

  const result = await callResilient('gemini', () => getModel().generateContent(prompt), {
    timeoutMs: AI_TIMEOUT_MS,
    attempts: Number(process.env.AI_RETRY_ATTEMPTS || 3),
    baseDelayMs: 1000,
    failureThreshold: 5,
    resetTimeoutMs: 30000
  });

  const raw = result.response.text();
  // The raw response is UNTRUSTED and may echo email content back at us. It is
  // never logged above debug, and never at all in production log levels.
  logger.debug({ length: raw?.length || 0 }, 'extraction response received');

  const sanitized = extraction.sanitizeExtraction(extraction.parseModelJson(raw));
  const payload = { actions: sanitized.actions, suggestedClient: sanitized.suggestedClient, model: MODEL };

  await cache.set(extractionKey(document), payload, cache.TTL.aiActions);
  return payload;
};

/**
 * Load the messages an extraction will read, enforcing the SAME ownership rule
 * as `GET /api/gmail/emails/:id`.
 *
 * @param {Object} req
 * @returns {Promise<{status: Number, message: String}|{messages: Array<Object>}>}
 */
const loadExtractionSource = async (req) => {
  const { emailId, threadId } = req.body;

  const projection =
    'subject from date snippet threadId direction toEmail fetchedBy assignedTo +body';

  if (emailId) {
    const email = await Email.findOne({ _id: emailId, deletedAt: null }).select(projection).lean();
    if (!email) return { status: 404, message: 'Email not found.' };
    if (!canAccessEmail(email, req.user)) {
      return { status: 403, message: 'Access denied. This email is not in your mailbox.' };
    }
    return { messages: [email] };
  }

  const messages = await Email.find({ threadId, deletedAt: null })
    .select(projection)
    .sort({ date: 1, _id: 1 })
    .limit(THREAD_READ_CAP)
    .lean();

  if (messages.length === 0) return { status: 404, message: 'Conversation not found.' };

  const visible = messages.filter((m) => canAccessEmail(m, req.user));
  if (visible.length === 0) {
    return { status: 403, message: 'Access denied. This conversation is not in your mailbox.' };
  }
  return { messages: visible };
};

// @desc    Extract suggested action items from an email or a conversation
// @route   POST /api/ai/extract-actions
// @access  Private (all roles, gated per email by the same object-level check
//          as GET /api/gmail/emails/:id)
exports.extractActions = async (req, res) => {
  try {
    // The request carries an ID, never a body payload: sending bodies is what
    // produced 413s against the express.json() limit.
    const source = await loadExtractionSource(req);
    if (source.status) return res.status(source.status).json({ message: source.message });

    if (!process.env.GEMINI_API_KEY) {
      // Explicit and renderable, not a 500: the UI shows "AI is not configured"
      // rather than a generic failure the user cannot act on.
      return res.status(503).json({
        message: 'AI action extraction is not configured. GEMINI_API_KEY is missing.',
        code: 'AI_NOT_CONFIGURED'
      });
    }

    // Fail fast while the breaker is open instead of enqueueing work that is
    // guaranteed to be rejected and then reporting it as a generic 502.
    const breaker = getBreaker('gemini').stats();
    if (breaker.state === 'open') {
      return res.status(503).json({
        message: 'The AI service is temporarily unavailable. Please try again shortly.',
        code: 'AI_UNAVAILABLE',
        retryInMs: Math.max(0, 30000 - (Date.now() - breaker.openedAt))
      });
    }

    const document = extraction.buildDocument(source.messages);
    if (!document) {
      return res.status(400).json({ message: 'This message has no readable content to analyse.' });
    }

    const key = extractionKey(document);
    const hit = await cache.get(key);
    if (hit && Array.isArray(hit.actions)) {
      res.set('Cache-Control', 'private, max-age=300');
      return res.status(200).json({
        actions: hit.actions,
        suggestedClient: hit.suggestedClient ?? null,
        model: hit.model || MODEL,
        cached: true
      });
    }

    const job = await queue.enqueue(
      queue.QUEUES.AI_EXTRACT,
      { document },
      { attempts: Number(process.env.AI_JOB_ATTEMPTS || 2), backoffMs: 2000 }
    );

    // Bind the job to its requester before it can possibly be polled. Under
    // BullMQ a job id is a small incrementing integer, so without this claim
    // the poll endpoint would be enumerable across mailboxes.
    await cache.set(jobOwnerKey(job.jobId), String(req.user._id), JOB_OWNER_TTL);

    const status = await queue.waitForJob(job.jobId, AI_INLINE_WAIT_MS);

    if (status && status.state === queue.STATES.COMPLETED && Array.isArray(status.result?.actions)) {
      // Never the document, never the model output — only counts.
      logger.info(
        { actionCount: status.result.actions.length, model: MODEL },
        'action extraction completed'
      );
      return res.status(200).json({
        actions: status.result.actions,
        suggestedClient: status.result.suggestedClient ?? null,
        model: status.result.model || MODEL,
        cached: false
      });
    }

    if (status && status.state === queue.STATES.FAILED) {
      const reason = String(status.error || '');
      logger.warn({ jobId: job.jobId, err: reason }, 'action extraction job failed');
      if (/circuit/i.test(reason)) {
        return res.status(503).json({
          message: 'The AI service is temporarily unavailable. Please try again shortly.',
          code: 'AI_UNAVAILABLE'
        });
      }
      return res.status(502).json({
        message: 'AI action extraction failed. Please try again.',
        code: 'AI_FAILED'
      });
    }

    // Still running: hand back a pollable job rather than holding the socket.
    return res.status(202).json({
      message: 'Action extraction is still running. Poll GET /api/ai/jobs/:jobId.',
      status: status?.state || 'queued',
      jobId: job.jobId
    });
  } catch (error) {
    logger.error({ err: error.message }, 'extractActions failed');
    return res.status(500).json({ message: 'AI action extraction failed. Please try again.' });
  }
};

// @desc    Poll a queued action-extraction job
// @route   GET /api/ai/extract-actions/:jobId
// @access  Private (the user who created the job, and only them)
exports.getExtractJobStatus = async (req, res) => {
  try {
    const jobId = String(req.params.jobId || '').slice(0, 200);
    const owner = await cache.get(jobOwnerKey(jobId));

    // 404 for "no such job", "expired" and "someone else's job" alike: a 403
    // here would confirm that a job id exists, which is exactly the oracle the
    // enumerable BullMQ id makes worth having.
    if (!owner || String(owner) !== String(req.user._id)) {
      return res.status(404).json({ message: 'Extraction job not found or expired.' });
    }

    const status = await queue.getJobStatus(jobId);
    if (!status) return res.status(404).json({ message: 'Extraction job not found or expired.' });

    return res.status(200).json({
      jobId: status.jobId,
      status: status.state,
      actions: Array.isArray(status.result?.actions) ? status.result.actions : null,
      suggestedClient: status.result?.suggestedClient ?? null,
      model: status.result?.model || MODEL,
      cached: false,
      error: status.error || null
    });
  } catch (error) {
    logger.error({ err: error.message }, 'getExtractJobStatus failed');
    return res.status(500).json({ message: 'Server error. Failed to read extraction status.' });
  }
};

exports.runSummarizeJob = runSummarizeJob;
exports.runExtractActionsJob = runExtractActionsJob;
exports.toPlainPrompt = toPlainPrompt;
