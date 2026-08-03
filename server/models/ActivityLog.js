const mongoose = require('mongoose');

/**
 * Append-only audit trail.
 *
 * Until WAVE2 gap S-2 this held only `userId`, `action` and `details`, so the
 * before/after of a role or status change was embedded inside the `details`
 * SENTENCE and could be neither queried nor rendered. The structured columns
 * below are what the Admin ActivityLog page reads (it degrades to
 * "Not recorded on this entry" when a field is absent, so old rows need no
 * backfill).
 */
const ActivityLogSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  action: {
    type: String,
    required: true
  },
  // Human-readable summary. Still required — it is the fallback rendering.
  details: {
    type: String,
    required: true
  },

  // --- Request provenance (S-2) -------------------------------------------
  // Captured from the request, honouring `app.set('trust proxy')` so a value
  // behind a reverse proxy is the real client address rather than the proxy's.
  ip: {
    type: String,
    default: null
  },
  userAgent: {
    type: String,
    default: null
  },

  // --- Structured target (S-2) --------------------------------------------
  // `targetId` is a String rather than an ObjectId because not every target is
  // a Mongo document (a Gmail messageId, a keyword, a mailbox address).
  targetType: {
    type: String,
    enum: ['User', 'Task', 'Email', 'Client', 'KeywordRule', 'Notification', 'System', null],
    default: null
  },
  targetId: {
    type: String,
    default: null
  },
  // A display label so the log renders without a join (e.g. the user's email
  // address, the task title). Survives deletion of the target.
  targetLabel: {
    type: String,
    default: null
  },

  // --- Structured change (S-2) --------------------------------------------
  // Mixed so a change of any shape can be recorded. Both are run through
  // `sanitizeChange()` in utils/activityLogger.js, which strips credential-ish
  // keys and bounds the size, so a secret cannot land in the audit log.
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

ActivityLogSchema.index({ userId: 1 });
ActivityLogSchema.index({ createdAt: -1 });
// This is the fastest-growing collection in the system (a row per login, task
// write, Gmail fetch and comment), and the log view sorts by user + recency.
ActivityLogSchema.index({ userId: 1, createdAt: -1 });
ActivityLogSchema.index({ action: 1, createdAt: -1 });

// S-2: "show me everything that happened to THIS user/task/email". Without
// this, filtering by target is a collection scan of the largest collection.
ActivityLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
ActivityLogSchema.index({ targetType: 1, createdAt: -1 });

module.exports = mongoose.model('ActivityLog', ActivityLogSchema);
