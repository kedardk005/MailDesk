/**
 * The single definition of "which tasks belong to this user" (audit H-4).
 *
 * Two definitions used to ship in the same product:
 *
 *   taskController.getAllTasks   -> Head: createdBy OR assignedTo
 *   reportsController.getOverallStats -> Head: createdBy ONLY
 *   utils/clientService taskScopeFor  -> Head: createdBy OR assignedTo
 *
 * so a Head's dashboard tile read 48/16/6 while their own Tasks page — one
 * click away, same instant — read 55/17/7. Nothing errored; the manager simply
 * saw a smaller number than the list would show them thirty seconds later.
 *
 * `createdBy OR assignedTo` is the correct rule, because it is the set of tasks
 * the user can actually OPEN: `getTaskById` refuses a Head anything they
 * neither created nor were assigned, so any wider or narrower headline number
 * describes a list the user cannot reproduce. Every surface now reads this
 * module; there is no second copy to drift.
 *
 * The mirror image for emails is `utils/emailAccess.js`.
 */

const mongoose = require('mongoose');

/**
 * Resolve an id that may arrive as an ObjectId, a string, or a populated doc.
 *
 * `$match` inside an aggregation pipeline does NOT cast strings to ObjectId the
 * way `find()` does, so a scope built from a raw string silently matches
 * nothing there. Always compare as an ObjectId.
 *
 * @param {*} value
 * @returns {mongoose.Types.ObjectId|null}
 */
const toObjectId = (value) => {
  const raw = String(value && value._id ? value._id : value ?? '');
  return mongoose.Types.ObjectId.isValid(raw) ? new mongoose.Types.ObjectId(raw) : null;
};

/**
 * The Mongo filter fragment for "tasks this user may see".
 *
 *   Admin (or an internal caller with no user) -> {} (whole workspace)
 *   Head                                       -> createdBy OR assignedTo
 *   Employee                                   -> assignedTo
 *
 * An unknown or malformed user yields `{ _id: null }`, which matches nothing —
 * failing closed, never open.
 *
 * NOTE for callers that also build a `$or` of their own (free-text search):
 * merge yours under `$and`, never by overwriting `$or`. `taskController`
 * already does this.
 *
 * @param {Object} [user] - req.user
 * @returns {Object} a Mongo filter fragment
 */
const taskScopeFor = (user) => {
  if (!user || user.role === 'Admin') return {};

  const id = toObjectId(user._id);
  if (!id) return { _id: null };

  if (user.role === 'Employee') return { assignedTo: id };
  return ownedByScope(id);
};

/**
 * The `createdBy OR assignedTo` fragment for one specific id, regardless of
 * role.
 *
 * Needed by the SLA report's `?scope=mine`, where an ADMIN deliberately asks
 * for their own slice: `taskScopeFor` would correctly answer `{}` for them, and
 * "mine" must not silently mean "everything".
 *
 * @param {*} userId
 * @returns {Object}
 */
const ownedByScope = (userId) => {
  const id = toObjectId(userId);
  if (!id) return { _id: null };
  return { $or: [{ createdBy: id }, { assignedTo: id }] };
};

/**
 * Object-level equivalent of `taskScopeFor`, for an already-loaded document.
 * Kept next to the filter so the two cannot drift.
 *
 * @param {Object} task
 * @param {Object} user
 * @returns {Boolean}
 */
const canAccessTask = (task, user) => {
  if (!task || !user) return false;
  if (user.role === 'Admin') return true;

  const idOf = (value) => (value && value._id ? String(value._id) : value ? String(value) : null);
  const userId = String(user._id);

  if (user.role === 'Employee') return idOf(task.assignedTo) === userId;
  return idOf(task.createdBy) === userId || idOf(task.assignedTo) === userId;
};

/**
 * Cache-key segment for a scoped aggregate. Admin and internal callers share
 * the global entry; everyone else gets one of their own.
 *
 * @param {Object} [user]
 * @returns {String}
 */
const taskScopeKey = (user) => (!user || user.role === 'Admin' ? 'all' : `${user.role}:${String(user._id)}`);

module.exports = { taskScopeFor, ownedByScope, canAccessTask, taskScopeKey, toObjectId };
