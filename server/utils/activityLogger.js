const ActivityLog = require('../models/ActivityLog');
const { log } = require('./logger');

const logger = log('activity');

// Bounds. An audit row must never be able to grow into a storage problem, and a
// `User-Agent` header is attacker-controlled and unbounded.
const MAX_USER_AGENT = Number(process.env.ACTIVITY_MAX_USER_AGENT || 400);
const MAX_LABEL = Number(process.env.ACTIVITY_MAX_LABEL || 300);
const MAX_CHANGE_BYTES = Number(process.env.ACTIVITY_MAX_CHANGE_BYTES || 4000);

// Keys whose VALUE must never be persisted into the audit trail, even if a
// caller passes a whole document as `before`/`after`. Matched case-insensitively
// as a substring, so `gmailAccessToken` and `resetTokenHash` are both caught.
const REDACTED_KEY_PATTERN =
  /(password|token|secret|authorization|cookie|apikey|api_key|credential|refresh)/i;

/**
 * Recursively copy a value, replacing credential-ish values with '[redacted]'.
 * Arrays and objects are bounded in depth so a hostile payload cannot recurse.
 *
 * @param {*} value
 * @param {Number} [depth]
 * @returns {*}
 */
const redact = (value, depth = 0) => {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 4) return '[truncated]';

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    // Mongoose documents / ObjectIds are not plain objects.
    if (typeof value.toObject === 'function') return redact(value.toObject(), depth + 1);
    if (typeof value._bsontype === 'string') return String(value);

    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 60)) {
      out[key] = REDACTED_KEY_PATTERN.test(key) ? '[redacted]' : redact(item, depth + 1);
    }
    return out;
  }

  return value;
};

/**
 * Redact and size-bound one side of a before/after pair.
 * @param {*} value
 * @returns {*} null when absent
 */
const sanitizeChange = (value) => {
  if (value === undefined || value === null) return null;
  const cleaned = redact(value);
  try {
    const raw = JSON.stringify(cleaned);
    if (raw && raw.length > MAX_CHANGE_BYTES) {
      return { _truncated: true, _bytes: raw.length };
    }
  } catch {
    return { _unserialisable: true };
  }
  return cleaned;
};

/**
 * Pull the client IP and User-Agent off an Express request.
 *
 * `req.ip` already honours `app.set('trust proxy', 1)` (index.js), so behind a
 * reverse proxy this is the real client address and NOT the proxy's. Reading
 * `x-forwarded-for` directly would have been spoofable.
 *
 * @param {Object} [req] - express request
 * @returns {{ip: String|null, userAgent: String|null}}
 */
const requestContext = (req) => {
  if (!req) return { ip: null, userAgent: null };
  const ip = typeof req.ip === 'string' && req.ip ? req.ip : req.socket?.remoteAddress || null;
  const ua = req.get ? req.get('user-agent') : req.headers?.['user-agent'];
  return {
    ip: ip ? String(ip).slice(0, 60) : null,
    userAgent: ua ? String(ua).slice(0, MAX_USER_AGENT) : null
  };
};

/**
 * Append an audit entry.
 *
 * Backwards compatible: the historical three-argument call
 * `logActivity(userId, action, details)` still works and simply records no
 * structured fields.
 *
 * The `console.log` that ran on every single write is a debug-level pino line:
 * this is the hottest write path in the system (a row per login, task change,
 * Gmail fetch and comment) and a synchronous stdout write per row is pure
 * event-loop stall.
 *
 * @param {String} userId - the ACTOR
 * @param {String} action
 * @param {String} details - human-readable summary
 * @param {Object} [meta]
 * @param {Object} [meta.req] - express request; supplies ip + userAgent
 * @param {String} [meta.ip] - explicit override
 * @param {String} [meta.userAgent] - explicit override
 * @param {String} [meta.targetType] - 'User'|'Task'|'Email'|'Client'|'KeywordRule'|'Notification'|'System'
 * @param {String} [meta.targetId]
 * @param {String} [meta.targetLabel]
 * @param {*} [meta.before]
 * @param {*} [meta.after]
 * @returns {Promise<void>}
 */
const logActivity = async (userId, action, details, meta = {}) => {
  try {
    if (!userId) {
      logger.warn({ action }, 'activity log skipped: userId is missing');
      return;
    }

    const ctx = requestContext(meta.req);

    const entry = {
      userId,
      action,
      details,
      ip: meta.ip !== undefined ? meta.ip : ctx.ip,
      userAgent: meta.userAgent !== undefined ? meta.userAgent : ctx.userAgent,
      targetType: meta.targetType || null,
      targetId: meta.targetId !== undefined && meta.targetId !== null ? String(meta.targetId) : null,
      targetLabel: meta.targetLabel ? String(meta.targetLabel).slice(0, MAX_LABEL) : null,
      before: sanitizeChange(meta.before),
      after: sanitizeChange(meta.after)
    };

    await ActivityLog.create(entry);
    logger.debug(
      { userId: String(userId), action, targetType: entry.targetType },
      'activity logged'
    );
  } catch (error) {
    logger.error({ err: error.message, action }, 'failed to log activity');
  }
};

module.exports = { logActivity, requestContext, sanitizeChange };
