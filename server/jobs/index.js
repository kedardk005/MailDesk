const queue = require('../utils/queue');
const { log } = require('../utils/logger');

const logger = log('jobs');

/**
 * Register every background job processor.
 *
 * Called once at boot, BEFORE `queue.startWorkers()`. Handlers are required
 * lazily inside this function so that requiring `utils/queue` from a controller
 * (which is how a job gets enqueued) does not pull the whole controller graph
 * back in as a require cycle.
 *
 * @returns {void}
 */
const registerJobHandlers = () => {
  // --- Gmail sync -----------------------------------------------------------
  // 150 sequential messages.get per account (~30 s) x N accounts. An Admin
  // fetch across ten accounts was a four-to-six minute HTTP request.
  queue.registerHandler(queue.QUEUES.GMAIL_SYNC, async (data, context) => {
    const { runGmailSyncJob } = require('../controllers/gmailController');
    return runGmailSyncJob(data, context);
  });

  // --- Outbound email -------------------------------------------------------
  // Was inline in the request path with no timeout and no retry.
  queue.registerHandler(queue.QUEUES.EMAIL_SEND, async (data) => {
    const { sendEmailNow } = require('../utils/emailHelper');
    const info = await sendEmailNow(data);
    return { messageId: info?.messageId || null, to: data.to };
  });

  // --- Gemini summarisation -------------------------------------------------
  // p99 for this model exceeds 30 s and it had no timeout, no retry and no
  // cache; twenty users clicking Summarize held twenty request contexts open.
  queue.registerHandler(queue.QUEUES.AI_SUMMARIZE, async (data) => {
    const { runSummarizeJob } = require('../controllers/aiController');
    return runSummarizeJob(data);
  });

  // --- F-3 Gemini action-item extraction ------------------------------------
  // Same reasoning as summarisation: the inference runs off the request path,
  // and the request only WAITS on it for AI_INLINE_WAIT_MS.
  queue.registerHandler(queue.QUEUES.AI_EXTRACT, async (data) => {
    const { runExtractActionsJob } = require('../controllers/aiController');
    return runExtractActionsJob(data);
  });

  // --- Retroactive keyword scan --------------------------------------------
  // Creating a keyword rule used to regex-scan the `body` of every unassigned
  // email inline inside the POST, then save() each match one at a time.
  queue.registerHandler(queue.QUEUES.KEYWORD_BACKFILL, async (data, context) => {
    const { runKeywordBackfillJob } = require('../controllers/keywordRuleController');
    return runKeywordBackfillJob(data, context);
  });

  logger.info({ queues: Object.values(queue.QUEUES), backend: queue.backend() }, 'job handlers registered');
};

module.exports = { registerJobHandlers };
