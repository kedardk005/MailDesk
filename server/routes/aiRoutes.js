const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
  summarizeEmail,
  getSummarizeJobStatus,
  extractActions,
  getExtractJobStatus
} = require('../controllers/aiController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const { extractActionsSchema } = require('../middleware/schemas');

// A dedicated limiter: this route is an unmetered LLM proxy, and the shared
// 300/15min general limiter is far too permissive for it.
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.AI_RATE_LIMIT_PER_MINUTE || 10),
  message: { message: 'Too many AI requests. Please wait a moment and try again.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/summarize-email', protect, authorizeRoles('Admin', 'Head'), aiLimiter, summarizeEmail);

// POST /api/ai/extract-actions - F-3 action-item extraction.
//
// `protect` only, deliberately: authorization is the OBJECT-level check, the
// same rule GET /api/gmail/emails/:id enforces, so an Employee may extract from
// a message assigned to them and from nothing else. A blanket Admin/Head role
// gate here would be both wider (any Head, any mailbox) and narrower (never an
// Employee) than the rule that actually governs reading the message.
router.post(
  '/extract-actions',
  protect,
  aiLimiter,
  validate(extractActionsSchema),
  extractActions
);

// GET /api/ai/extract-actions/:jobId - poll an extraction that overran
// AI_INLINE_WAIT_MS.
//
// A SEPARATE endpoint from /jobs/:jobId, and this is not cosmetic. Under
// BullMQ a job id is a small incrementing integer, so a pollable-by-role
// endpoint is enumerable: any Head could read the extraction another Head ran
// on a mailbox they cannot see. This route resolves the job only for the user
// who created it, and answers 404 — never 403 — for anyone else, so it is not
// an existence oracle either.
router.get('/extract-actions/:jobId', protect, getExtractJobStatus);

// Poll a summarization that did not finish inside the request window.
router.get('/jobs/:jobId', protect, authorizeRoles('Admin', 'Head'), getSummarizeJobStatus);

module.exports = router;
