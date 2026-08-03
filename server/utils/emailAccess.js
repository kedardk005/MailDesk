/**
 * The single definition of "may this user read this email".
 *
 * It used to live as a module-local `const` inside `gmailController.js`, which
 * was fine while HTTP was the only transport. F-3 (AI extraction) and F-4
 * (socket presence) both need exactly the same rule, and a second, separately
 * maintained copy of an authorization predicate is how scoping bugs are born.
 * `gmailController.canAccessEmail` now delegates here, so there is one rule.
 *
 * Two shapes of the same rule are exported:
 *
 *   canAccessEmail(email, user)  — an object-level check on an already-loaded
 *                                  document (what `GET /emails/:id` does).
 *   emailAccessFilter(user)      — the equivalent as a Mongo filter fragment,
 *                                  so a scoped read can be applied INSIDE the
 *                                  query instead of after materialising rows a
 *                                  caller was never allowed to see.
 *
 * The two MUST stay equivalent. `scripts/smokeTest.js` asserts both directions
 * against the same fixtures.
 */

const mongoose = require('mongoose');

/**
 * Resolve an id that may arrive as an ObjectId, a string, or a populated
 * document. A bare `.toString()` on the populated form yields "[object Object]"
 * and would silently deny the legitimate owner.
 *
 * @param {*} value
 * @returns {String|null}
 */
const idOf = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
};

/**
 * Object-level authorization for a single Email.
 *
 * Admin may act on any email. Everyone else must own the mailbox it arrived on
 * (they fetched it). Employees additionally qualify when it is assigned to them.
 *
 * @param {Object} email - Email document (lean or hydrated)
 * @param {Object} user - req.user / socket.data.user
 * @returns {Boolean}
 */
const canAccessEmail = (email, user) => {
  if (!email || !user) return false;
  if (user.role === 'Admin') return true;

  const userId = String(user._id);
  if (idOf(email.fetchedBy) === userId) return true;
  if (user.role === 'Employee' && idOf(email.assignedTo) === userId) return true;

  return false;
};

/**
 * The query-level equivalent of `canAccessEmail`.
 *
 * `{}` for an Admin. An unknown or malformed user yields `{ _id: null }`, which
 * matches nothing — failing closed, never open.
 *
 * @param {Object} user
 * @returns {Object} a Mongo filter fragment
 */
const emailAccessFilter = (user) => {
  if (!user) return { _id: null };
  if (user.role === 'Admin') return {};

  const raw = String(user._id || '');
  if (!mongoose.Types.ObjectId.isValid(raw)) return { _id: null };
  const id = new mongoose.Types.ObjectId(raw);

  // Mirrors canAccessEmail exactly: a Head only owns what it fetched; an
  // Employee additionally owns what is assigned to them.
  if (user.role === 'Employee') return { $or: [{ fetchedBy: id }, { assignedTo: id }] };
  return { fetchedBy: id };
};

module.exports = { canAccessEmail, emailAccessFilter, idOf };
