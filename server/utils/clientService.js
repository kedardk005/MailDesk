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
 * Per-client task counters, keyed by LOWERCASED client name.
 *
 * Deliberately groups the whole collection rather than `$match`ing the current
 * page's names: the original comparison was case-insensitive, and an exact
 * `$in` match would silently change the numbers for any task whose
 * `clientName` differs in case.
 *
 * @returns {Promise<Object>} { [lowercasedName]: { total, completed } }
 */
const getTaskCountsByClient = () =>
  cache.wrap(cache.KEYS.report('client-task-counts', 'all', 'all'), cache.TTL.clients, async () => {
    const rows = await Task.aggregate([
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
 * @returns {Promise<Object>} { [clientId]: Number }
 */
const getMailCountsByClient = () =>
  cache.wrap(cache.KEYS.report('client-mail-counts', 'all', 'all'), cache.TTL.clients, async () => {
    const rows = await Email.aggregate([
      // F-1: `mailCount` has always meant mail RECEIVED from the client, so the
      // outbound replies now persisted alongside it are excluded.
      { $match: { deletedAt: null, clientId: { $ne: null }, direction: { $ne: 'outbound' } } },
      { $group: { _id: '$clientId', total: { $sum: 1 } } }
    ]);
    return Object.fromEntries(rows.map((r) => [String(r._id), r.total]));
  });

/**
 * List clients with their task and mail counters.
 *
 * @param {Object} params - result of parseListParams
 * @param {Object} [options]
 * @param {Boolean} [options.withCounts=true]
 * @returns {Promise<{data: Array, pagination: Object|null}>}
 */
const listClients = async (params, options = {}) => {
  const { withCounts = true } = options;

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

  const [taskCounts, mailCounts] = await Promise.all([getTaskCountsByClient(), getMailCountsByClient()]);

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
  CLIENT_SORT_FIELDS,
  CLIENT_FIELDS
};
