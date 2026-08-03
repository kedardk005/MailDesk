const mongoSanitize = require('express-mongo-sanitize');

/**
 * NoSQL operator-injection hardening.
 *
 * `express-mongo-sanitize` mutates objects in place. That works for `req.body`,
 * but under Express 5 `req.query` is a GETTER that re-parses `req.url` on every
 * access and returns a brand-new object each time, so the mutation is discarded
 * immediately and the protection everyone believes is in place does not exist.
 *
 * Rather than rely on silent stripping, this guard REJECTS any request carrying
 * a key that starts with `$` or contains `.` in its query, body or params. That
 * is loud, cheap, and cannot be defeated by a future `query parser` change.
 */

const MAX_DEPTH = 12;

const isForbiddenKey = (key) => typeof key === 'string' && (key.startsWith('$') || key.includes('.'));

/**
 * Walk a parsed request container looking for Mongo operator keys.
 * @param {*} value
 * @param {Number} depth
 * @returns {String|null} the offending key, or null
 */
const findForbiddenKey = (value, depth = 0) => {
  if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForbiddenKey(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value)) {
    if (isForbiddenKey(key)) return key;
    const found = findForbiddenKey(value[key], depth + 1);
    if (found) return found;
  }

  return null;
};

/**
 * Global middleware: reject operator-like keys, then apply the existing
 * body/params sanitization as a second layer.
 */
const mongoKeyGuard = (req, res, next) => {
  // req.query is re-parsed on each access under Express 5, so read it once.
  const query = req.query;

  for (const container of [query, req.body, req.params]) {
    const offending = findForbiddenKey(container);
    if (offending) {
      return res.status(400).json({
        message: `Invalid request. Parameter name '${offending}' is not allowed.`
      });
    }
  }

  // Keep the existing body sanitization as defence in depth.
  try {
    if (req.body) mongoSanitize.sanitize(req.body);
    if (req.params) mongoSanitize.sanitize(req.params);
  } catch (err) {
    require('../utils/logger').log('mongo-guard').error({ err: err.message }, 'mongoSanitize failed');
  }

  return next();
};

module.exports = mongoKeyGuard;
