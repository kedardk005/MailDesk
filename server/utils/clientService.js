const mongoose = require('mongoose');
const Client = require('../models/Client');
const Task = require('../models/Task');
const Email = require('../models/Email');
const cache = require('./cache');
const { escapeRegex } = require('./regexHelper');
const { paginate } = require('./paginate');

/**
 * The ONE implementation behind both client-list surfaces
 * (`GET /api/clients` and `GET /api/tasks/clients`), which had drifted into two
 * separate handlers with different response shapes and different bugs.
 *
 * The previous `GET /api/clients` loaded the ENTIRE Task collection and the
 * ENTIRE Email collection into memory and then ran a nested JS scan:
 * O(clients x tasks) + O(clients x emails x associatedEmails). At 50 clients,
 * 100k emails and 3 addresses each that is ~15 MILLION synchronous
 * `String.includes()` calls per request — a multi-second freeze during which the
 * process answers nothing at all, not even socket pings.
 *
 * Both counters are now `$group` aggregations, computed once for the whole
 * collection and cached.
 */

// Sortable fields, per docs/audits/API-LIST-CONTRACT.md.
const CLIENT_SORT_FIELDS = ['name', 'createdAt', 'status', 'contactPerson'];

const CLIENT_FIELDS = 'name associatedEmails contactPerson email phone notes status createdAt';

/**
 * Role scoping for the counters (audit defect D5).
 *
 * The counters used to be workspace-global for every caller while the
 * drill-down (client timeline, task/email lists) is role-scoped — a Head saw
 * `mailCount: 43` for a client but could open only their own 7 emails, and an
 * Employee saw workspace-wide volumes for clients they have no work on.
 *
 * The rules below are EXACTLY the ones the list endpoints already apply:
 *   - tasks:  Employee -> assignedTo; Head -> createdBy OR assignedTo
 *             (taskController.getAllTasks)
 *   - emails: Head -> fetchedBy (gmailController list scope); Employee ->
 *             assignedTo (the only mail an Employee may reach, and the same
 *             rule clientController.getClientTimeline applies)
 *   - Admin (or no user, for internal callers) -> unscoped
 */
const toId = (user) => new mongoose.Types.ObjectId(String(user._id));

// H-4: the task rule lives in utils/taskScope.js now. It was already correct
// here and wrong in reportsController; there is one copy so it cannot drift
// again.
const { taskScopeFor } = require('./taskScope');

const mailScopeFor = (user) => {
  if (!user || user.role === 'Admin') return {};
  if (user.role === 'Employee') return { assignedTo: toId(user) };
  return { fetchedBy: toId(user) };
};

// Cache key segment: Admin and internal callers share the global entry; every
// other caller gets an entry of their own, invalidated by the same `report:`
// prefix drops as before.
const counterScopeKey = (user) => (!user || user.role === 'Admin' ? 'all' : `${user.role}:${String(user._id)}`);

/**
 * Per-client task counters, keyed by LOWERCASED client name, scoped to what
 * `user` may actually access (see `taskScopeFor`).
 *
 * Deliberately groups the whole (scoped) collection rather than `$match`ing
 * the current page's names: the original comparison was case-insensitive, and
 * an exact `$in` match would silently change the numbers for any task whose
 * `clientName` differs in case.
 *
 * @param {Object} [user] - the requesting user; omitted = unscoped (Admin)
 * @returns {Promise<Object>} { [lowercasedName]: { total, completed } }
 */
const getTaskCountsByClient = (user = null) =>
  cache.wrap(cache.KEYS.report('client-task-counts', 'all', counterScopeKey(user)), cache.TTL.clients, async () => {
    const rows = await Task.aggregate([
      { $match: taskScopeFor(user) },
      {
        $group: {
          _id: { $toLower: { $ifNull: ['$clientName', ''] } },
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } }
        }
      }
    ]);
    return Object.fromEntries(rows.map((r) => [r._id || '', { total: r.total, completed: r.completed }]));
  });

/**
 * Per-client mail counters, keyed by client id.
 *
 * Uses the denormalised `Email.clientId` written at ingest, so this is an
 * indexed `$group` rather than N unanchored regex scans over `from`.
 *
 * NOTE: rows created before this change have `clientId: null` and are counted
 * as 0 until `scripts/backfillEmailSnippets.js` has been run.
 *
 * @param {Object} [user] - the requesting user; omitted = unscoped (Admin)
 * @returns {Promise<Object>} { [clientId]: Number }
 */
const getMailCountsByClient = (user = null) =>
  cache.wrap(cache.KEYS.report('client-mail-counts', 'all', counterScopeKey(user)), cache.TTL.clients, async () => {
    const rows = await Email.aggregate([
      // F-1: `mailCount` has always meant mail RECEIVED from the client, so the
      // outbound replies now persisted alongside it are excluded.
      { $match: { deletedAt: null, clientId: { $ne: null }, direction: { $ne: 'outbound' }, ...mailScopeFor(user) } },
      { $group: { _id: '$clientId', total: { $sum: 1 } } }
    ]);
    return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
  });

/**
 * Rows that belong to NO client, for the caller's scope (audit H-5).
 *
 * Client analytics join tasks to clients by lowercased NAME STRING, and
 * `POST /api/tasks` accepts any client name at all (`createTaskSchema` asks
 * only for a 1-200 character string). The consequence, on the same screen as
 * the totals they contradict:
 *
 *   Reports -> Clients tiles:  EMAILS 1,397   TASKS 427   COMPLETED 224
 *   the table's own columns:   EMAILS 1,185   TASKS 353   COMPLETED 186
 *
 * 74 of 427 tasks (17%) and 212 of 1,397 emails (15%) simply vanished between
 * the tile and the table: 70 tasks with an empty `clientName`, 3 with the
 * literal string "unassigned", 1 naming a client that does not exist, and every
 * email whose sender matched no client at ingest (`clientId: null`).
 *
 * Dropping them silently is the defect. This computes the residual explicitly —
 * always as TOTAL MINUS MATCHED, never by re-deriving it from a second rule —
 * so the bucket reconciles with the tile by construction, whatever new way a
 * row finds of belonging to nothing.
 *
 * @param {Object} [user] - the requesting user; omitted = unscoped (Admin)
 * @returns {Promise<{taskCount: Number, completedTaskCount: Number,
 *   openTaskCount: Number, emailCount: Number, totals: Object,
 *   matched: Object, orphanClientNames: String[]}>}
 */
const getUnattributedCounts = (user = null) =>
  cache.wrap(cache.KEYS.report('client-unattributed', 'all', counterScopeKey(user)), cache.TTL.clients, async () => {
    const taskScope = taskScopeFor(user);
    const mailScope = { deletedAt: null, direction: { $ne: 'outbound' }, ...mailScopeFor(user) };

    const [clients, taskCounts, mailCounts, totalTasks, totalCompleted, totalEmails] = await Promise.all([
      Client.find({}).select('_id name').lean(),
      getTaskCountsByClient(user),
      getMailCountsByClient(user),
      Task.countDocuments(taskScope),
      Task.countDocuments({ ...taskScope, status: 'Completed' }),
      Email.countDocuments(mailScope)
    ]);

    const knownNames = new Set(clients.map((c) => String(c.name || '').toLowerCase()));
    const knownIds = new Set(clients.map((c) => String(c._id)));

    let matchedTasks = 0;
    let matchedCompleted = 0;
    const orphanClientNames = [];
    for (const [key, counts] of Object.entries(taskCounts)) {
      if (knownNames.has(key)) {
        matchedTasks += counts.total;
        matchedCompleted += counts.completed;
      } else if (key) {
        // An empty key is "no client named at all"; a non-empty one names a
        // client that does not exist, which is worth being able to see.
        orphanClientNames.push(key);
      }
    }

    // A `clientId` pointing at a deleted client is unattributed too, so the
    // matched side is summed over ids that still exist rather than over the
    // whole aggregation.
    let matchedEmails = 0;
    for (const [id, total] of Object.entries(mailCounts)) {
      if (knownIds.has(id)) matchedEmails += total;
    }

    const taskCount = Math.max(0, totalTasks - matchedTasks);
    const completedTaskCount = Math.max(0, totalCompleted - matchedCompleted);

    return {
      taskCount,
      completedTaskCount,
      openTaskCount: Math.max(0, taskCount - completedTaskCount),
      emailCount: Math.max(0, totalEmails - matchedEmails),
      totals: { taskCount: totalTasks, completedTaskCount: totalCompleted, emailCount: totalEmails },
      matched: { taskCount: matchedTasks, completedTaskCount: matchedCompleted, emailCount: matchedEmails },
      orphanClientNames: orphanClientNames.sort().slice(0, 50)
    };
  });

/**
 * The synthetic table row that makes a client table reconcile with its own
 * tiles. `_id` is a stable STRING sentinel, not null, so it is safe as a React
 * key and can never collide with a real ObjectId; `isUnattributed` marks it as
 * not-a-client so the UI can render it inert (no drill-down link).
 *
 * @param {Object} counts - result of getUnattributedCounts
 * @returns {Object}
 */
const UNATTRIBUTED_ID = '__unattributed__';
const unattributedRow = (counts) => ({
  _id: UNATTRIBUTED_ID,
  name: 'Unattributed',
  isUnattributed: true,
  associatedEmails: [],
  emailCount: counts.emailCount,
  mailCount: counts.emailCount,
  taskCount: counts.taskCount,
  completedTaskCount: counts.completedTaskCount,
  openTaskCount: counts.openTaskCount,
  orphanClientNames: counts.orphanClientNames
});

/**
 * List clients with their task and mail counters.
 *
 * @param {Object} params - result of parseListParams
 * @param {Object} [options]
 * @param {Boolean} [options.withCounts=true]
 * @param {Object} [options.user] - requesting user; counters are scoped to
 *   what this user may access (Admin/omitted = workspace-wide)
 * @returns {Promise<{data: Array, pagination: Object|null}>}
 */
const listClients = async (params, options = {}) => {
  const { withCounts = true, user = null } = options;

  const filter = {};
  if (params.q) {
    const regex = new RegExp(escapeRegex(params.q), 'i');
    filter.$or = [{ name: regex }, { email: regex }, { contactPerson: regex }, { associatedEmails: regex }];
  }

  const { data, pagination } = await paginate(Client, filter, params, { select: CLIENT_FIELDS });

  if (!withCounts || data.length === 0) {
    return {
      data: data.map((c) => ({ ...c, taskCount: 0, completedTaskCount: 0, openTaskCount: 0, mailCount: 0 })),
      pagination
    };
  }

  const [taskCounts, mailCounts] = await Promise.all([getTaskCountsByClient(user), getMailCountsByClient(user)]);

  const withCounters = data.map((client) => {
    const key = String(client.name || '').toLowerCase();
    const total = taskCounts[key]?.total || 0;
    const completed = taskCounts[key]?.completed || 0;
    return {
      ...client,
      taskCount: total,
      completedTaskCount: completed,
      // WAVE2 gap S-9. "Open" is everything not Completed, i.e. Pending + Late,
      // derived from the SAME cached $group rather than a second aggregation.
      // The UI labels its column "Tasks" today; it can now label it accurately.
      openTaskCount: Math.max(0, total - completed),
      mailCount: mailCounts[String(client._id)] || 0
    };
  });

  return { data: withCounters, pagination };
};

module.exports = {
  listClients,
  getTaskCountsByClient,
  getMailCountsByClient,
  getUnattributedCounts,
  unattributedRow,
  UNATTRIBUTED_ID,
  CLIENT_SORT_FIELDS,
  CLIENT_FIELDS
};
