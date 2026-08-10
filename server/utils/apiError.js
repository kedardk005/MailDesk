/**
 * M-13 — one error envelope for the whole API.
 *
 * The Zod-validated routes have always answered
 *
 *   { message, errors: [{ path, message }] }
 *
 * and `client/src/api/axios.js` leaves that payload intact for the form to read
 * (there is a regression test for it). Everything OUTSIDE those routes answered
 * a bare `{ message }` — sometimes `{ success: false, message }` — with no path
 * at all, so a client could not attach the failure to the input that caused it:
 *
 *   POST /api/clients      -> {"success":false,"message":"Client name is required"}
 *   POST /api/users        -> {"message":"User with this email already exists."}
 *   PUT  /api/users/:id    -> {"message":"Email address is already in use by another user."}
 *
 * Every one of those is a FIELD error. This module gives them the same shape as
 * the Zod routes, additively: `message` keeps its exact wording (existing
 * clients match on it), any `success: false` the endpoint already sent is
 * preserved, and `errors[]` is new.
 */

/**
 * Normalise one issue into the documented `{ path, message }` pair.
 *
 * @param {Object|String} issue - `{ path, message }`, or a bare message
 * @param {String} [fallbackMessage]
 * @returns {{path: String, message: String}}
 */
const toIssue = (issue, fallbackMessage = '') => {
  if (typeof issue === 'string') return { path: issue, message: fallbackMessage };
  return {
    path: Array.isArray(issue?.path) ? issue.path.join('.') : String(issue?.path ?? ''),
    message: String(issue?.message ?? fallbackMessage ?? '')
  };
};

/**
 * Build the documented error body.
 *
 * @param {String} message - the headline, unchanged from what the route sent
 * @param {Array<Object|String>} [issues] - field-level detail
 * @param {Object} [extra] - keys the endpoint already sends (e.g. `success`)
 * @returns {Object}
 */
const errorBody = (message, issues = [], extra = {}) => ({
  ...extra,
  message,
  errors: (Array.isArray(issues) ? issues : [issues]).filter(Boolean).map((i) => toIssue(i, message))
});

/**
 * Send a field-level error.
 *
 * @param {Object} res - Express response
 * @param {Number} status
 * @param {String} message
 * @param {Array<Object|String>} [issues] - `[{path, message}]`, or `['email']`
 *   to attach the headline message to one field
 * @param {Object} [extra] - additional top-level keys to preserve
 * @returns {Object} the Express response
 */
const fieldError = (res, status, message, issues = [], extra = {}) =>
  res.status(status).json(errorBody(message, issues, extra));

/**
 * The paths carried by a MongoDB duplicate-key error.
 *
 * A unique-index violation surfaces as `E11000` with `keyPattern`/`keyValue`,
 * which names the offending field exactly — the information the audit found
 * missing from every duplicate-key response in the product.
 *
 * @param {Error} err
 * @returns {String[]} field paths, empty when this is not a duplicate-key error
 */
const duplicateKeyPaths = (err) => {
  if (!err || err.code !== 11000) return [];
  const keys = Object.keys(err.keyPattern || err.keyValue || {});
  return keys.filter((k) => k && k !== '_id');
};

/**
 * True when `err` is a MongoDB duplicate-key error.
 * @param {Error} err
 * @returns {Boolean}
 */
const isDuplicateKeyError = (err) => Boolean(err && err.code === 11000);

module.exports = { fieldError, errorBody, toIssue, duplicateKeyPaths, isDuplicateKeyError };
