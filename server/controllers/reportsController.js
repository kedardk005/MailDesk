const mongoose = require('mongoose');
const Task = require('../models/Task');
const User = require('../models/User');
const Email = require('../models/Email');
const Client = require('../models/Client');
const SlaPolicy = require('../models/SlaPolicy');
const cache = require('../utils/cache');
const {
  getTaskCountsByClient,
  getMailCountsByClient,
  getUnattributedCounts,
  unattributedRow
} = require('../utils/clientService');
const { getEffectivePolicies, targetMsExpr } = require('../utils/slaPolicy');
const { businessWindows, elapsedMsExpr } = require('../utils/slaCalendar');
const { toObjectId } = require('../utils/threadHelper');
const { taskScopeFor, ownedByScope } = require('../utils/taskScope');
const { firstString } = require('../utils/paginate');
const { zonedWallClockToUtc } = require('../utils/dateHelper');
const { log } = require('../utils/logger');

const logger = log('reports');

/**
 * Reports are read-heavy, expensive and tolerant of being slightly stale, so
 * every handler here is cache-aside. Invalidation is explicit: task, email,
 * user and client writes all call `cache.invalidateStats()` /
 * `cache.invalidateClients()`, which drop the whole `report:` and `dash:`
 * prefixes.
 *
 * The HTTP cache headers matter too: without them the browser re-asks on every
 * dashboard mount even when the payload has not moved.
 */
const setReportCacheHeaders = (res, maxAge = 30) => {
  res.set('Cache-Control', `private, max-age=${maxAge}, stale-while-revalidate=60`);
};

/**
 * A stable cache discriminator for the caller. Head users see only their own
 * slice, so their report must never be served from an Admin's cache entry.
 * @param {Object} user
 * @returns {String}
 */
const scopeKey = (user) => (user.role === 'Head' ? String(user._id) : 'all');

// @desc    Get Employee Performance Report
// @route   GET /api/reports/employee
// @access  Private (Admin, Head — Head sees only tasks THEY created)
//
// WAVE2 gap S-17, DECIDED: **serve Head, scoped**.
//
// Every sibling report route already served Head with a `createdBy` /
// `fetchedBy` scope, and `scopeKey()` below existed specifically so a Head's
// slice could never be served from an Admin's cache entry. Leaving this one
// route Admin-only was the inconsistency, not the scoping.
//
// A Head sees performance over the tasks THEY created — the same boundary
// `getOverallStats` and `getTaskTimeline` already use. Employees with no tasks
// from that Head are omitted entirely rather than shown as rows of zeros,
// because a zero row here reads as "did nothing" rather than "not mine".
// Admin behaviour is unchanged.
exports.getEmployeeReport = async (req, res) => {
  try {
    const { filter, userId } = req.query;
    const range = filter === 'weekly' ? 'weekly' : 'monthly';

    const now = new Date();
    const startDate = new Date();
    startDate.setDate(now.getDate() - (range === 'weekly' ? 7 : 30));
    startDate.setHours(0, 0, 0, 0);

    const targetUserId = typeof userId === 'string' && /^[0-9a-fA-F]{24}$/.test(userId) ? userId : null;
    const isHead = req.user.role === 'Head';

    const payload = await cache.wrap(
      // The scope is part of the key. Without it a Head's narrowed report would
      // be served to the Admin (or the reverse) for the whole 15-minute TTL.
      cache.KEYS.report('employee', range, `${targetUserId || 'all'}:${scopeKey(req.user)}`),
      cache.TTL.report,
      async () => {
        const userQuery = { role: { $in: ['Employee', 'Head'] }, deletedAt: null };
        if (targetUserId) userQuery._id = new mongoose.Types.ObjectId(targetUserId);

        const users = await User.find(userQuery).select('name email role').lean();
        if (users.length === 0) return [];

        const userIds = users.map((u) => u._id);

        const match = { createdAt: { $gte: startDate }, assignedTo: { $in: userIds } };
        // toObjectId: `aggregate()` does not cast, and `req.user._id` is a
        // STRING whenever req.user came from the `user:<id>` JSON cache — an
        // uncoerced id matches nothing and reports an empty scope as if it were
        // real data.
        if (isHead) match.createdBy = toObjectId(req.user._id);

        // Was: load every task in the window as a full document, then
        // `users.map(u => tasks.filter(...))` — O(users x tasks) in JS, 150,000
        // array scans for 30 employees and 5,000 tasks, and the response
        // embedded EVERY task for EVERY employee.
        const grouped = await Task.aggregate([
          { $match: match },
          {
            $group: {
              _id: '$assignedTo',
              totalAssigned: { $sum: 1 },
              totalCompleted: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
              totalPending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
              totalLate: { $sum: { $cond: [{ $eq: ['$status', 'Late'] }, 1, 0] } }
            }
          }
        ]);

        const byUser = new Map(grouped.map((row) => [String(row._id), row]));

        // A Head's report lists only the people they actually delegated to.
        const visible = isHead ? users.filter((u) => byUser.has(String(u._id))) : users;

        return visible.map((user) => {
          const stats = byUser.get(String(user._id)) || {
            totalAssigned: 0,
            totalCompleted: 0,
            totalPending: 0,
            totalLate: 0
          };

          return {
            employeeId: user._id,
            employeeName: user.name,
            employeeEmail: user.email,
            employeeRole: user.role,
            totalAssigned: stats.totalAssigned,
            totalCompleted: stats.totalCompleted,
            totalPending: stats.totalPending,
            totalLate: stats.totalLate,
            completionRate:
              stats.totalAssigned > 0 ? Math.round((stats.totalCompleted / stats.totalAssigned) * 100) : 0,
            // Kept for shape compatibility. The full per-employee task list is
            // no longer embedded here — it was the bulk of the payload and is
            // available from the paginated GET /api/tasks?assignedTo=<id>.
            tasks: []
          };
        });
      }
    );

    setReportCacheHeaders(res, 60);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getEmployeeReport failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve employee reports.' });
  }
};

// @desc    Get Overall System Stats
// @route   GET /api/reports/overall
// @access  Private (Admin, Head only)
exports.getOverallStats = async (req, res) => {
  try {
    const payload = await cache.wrap(
      cache.KEYS.dashboard(scopeKey(req.user), req.user.role),
      cache.TTL.dashboard,
      async () => {
        // F-1: outbound replies are now persisted as Email rows. Every
        // pre-existing counter means RECEIVED mail, so they are excluded here —
        // otherwise sending a reply would silently inflate "total emails" on
        // the dashboard.
        const emailQuery = { deletedAt: null, direction: { $ne: 'outbound' } };
        if (req.user.role === 'Head') {
          // See the toObjectId note in getEmployeeReport.
          emailQuery.fetchedBy = toObjectId(req.user._id);
        }

        /*
         * H-4 — this line used to be `taskQuery.createdBy = <head>`, i.e.
         * created-by ONLY, while `GET /api/tasks` scoped a Head to
         * `createdBy OR assignedTo`. Same Head, same instant: this tile said
         * 48 tasks / 16 overdue / 6 pending and their own Tasks page said
         * 55 / 17 / 7. Nothing errored; the manager simply read the smaller
         * number. Both surfaces now read utils/taskScope.js.
         */
        const taskQuery = taskScopeFor(req.user);

        // Was: EIGHT sequential `countDocuments`, none parallel, none cached,
        // two of them full collection scans. Now three parallel round-trips,
        // with the three task-status counts collapsed into one $group.
        const [taskAgg, emailAgg, totalUsers, totalClients] = await Promise.all([
          Task.aggregate([
            { $match: taskQuery },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                pending: { $sum: { $cond: [{ $eq: ['$status', 'Pending'] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] } },
                late: { $sum: { $cond: [{ $eq: ['$status', 'Late'] }, 1, 0] } }
              }
            }
          ]),
          Email.aggregate([
            { $match: emailQuery },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                unassigned: { $sum: { $cond: [{ $eq: ['$status', 'unassigned'] }, 1, 0] } }
              }
            }
          ]),
          User.countDocuments({ deletedAt: null }),
          // O(1) metadata read: an exact count is not meaningful on a tile.
          Client.estimatedDocumentCount()
        ]);

        const tasks = taskAgg[0] || { total: 0, pending: 0, completed: 0, late: 0 };
        const emails = emailAgg[0] || { total: 0, unassigned: 0 };

        return {
          totalUsers,
          totalEmails: emails.total,
          totalTasks: tasks.total,
          totalPending: tasks.pending,
          totalCompleted: tasks.completed,
          totalLate: tasks.late,
          totalUnassignedEmails: emails.unassigned,
          totalClients
        };
      }
    );

    setReportCacheHeaders(res, 30);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getOverallStats failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve system statistics.' });
  }
};

// Day bucketing must agree between the JS key list and MongoDB's
// `$dateToString`, or boundary days silently read as zero. Both are pinned to
// APP_TIMEZONE — the same zone utils/dateHelper uses for deadlines.
const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata';

/**
 * UTC instant of local midnight (start of day) in APP_TIMEZONE for the day
 * containing `ms`. Used to pin the aggregation `$match` window to the exact
 * span the bucket keys cover.
 * @param {Number} ms - epoch milliseconds of any instant in the target day
 * @returns {Date}
 */
const startOfZonedDay = (ms) => {
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [year, month, day] = keyFormatter.format(new Date(ms)).split('-').map(Number);
  return zonedWallClockToUtc(year, month, day, 0, 0, 0, 0, TIMEZONE);
};

/**
 * Build a zero-filled day bucket list in APP_TIMEZONE, newest last.
 *
 * `startDate`/`endDate` delimit EXACTLY the instants whose APP_TIMEZONE day
 * key is one of `dates` — `[startDate, endDate)`. The `$match` in every
 * consumer must use both bounds, or rows just outside the key list are counted
 * by the aggregation and then silently dropped when the JS mapping finds no
 * bucket for their key (audit D7: 7 boundary-day emails vanished from the
 * 90-day timeline because the lower bound was `now - (days+1) * 24h`, a
 * partial day before the first bucket's local midnight).
 *
 * @param {Number} days
 * @returns {{dates: String[], labels: Object, startDate: Date, endDate: Date}}
 */
const buildDayBuckets = (days) => {
  // 'en-CA' formats as YYYY-MM-DD, matching $dateToString's '%Y-%m-%d'.
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric'
  });

  const now = Date.now();
  const dates = [];
  const labels = {};

  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(now - i * 86400000);
    const key = keyFormatter.format(d);
    dates.push(key);
    labels[key] = labelFormatter.format(d);
  }

  // The exact instants the keys above cover: local midnight (APP_TIMEZONE) of
  // the OLDEST bucket day, up to but not including local midnight of the day
  // AFTER the newest bucket day. The previous lower bound ("one day of slack",
  // `now - days * 24h`) let the aggregation match a partial day whose key was
  // not in the list, so those rows were counted and then dropped.
  const startDate = startOfZonedDay(now - (days - 1) * 86400000);
  const endDate = startOfZonedDay(now + 86400000);

  return { dates, labels, startDate, endDate };
};

/**
 * Zero-filled day buckets covering an explicit [from, to] range, in
 * APP_TIMEZONE. `buildDayBuckets` above is anchored to "today"; the SLA
 * endpoints accept an arbitrary historical window.
 *
 * @param {Date} from
 * @param {Date} to
 * @returns {{dates: String[], labels: Object}}
 */
const buildRangeBuckets = (from, to) => {
  const keyFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'short',
    day: 'numeric'
  });

  const dates = [];
  const labels = {};
  // Hard ceiling mirroring the range clamp, so a bad `to` cannot spin here.
  for (let t = from.getTime(), guard = 0; t <= to.getTime() && guard <= 400; t += 86400000, guard += 1) {
    const d = new Date(t);
    const key = keyFormatter.format(d);
    if (labels[key]) continue;
    dates.push(key);
    labels[key] = labelFormatter.format(d);
  }

  // A range shorter than a day still gets its single bucket.
  if (dates.length === 0) {
    const key = keyFormatter.format(to);
    dates.push(key);
    labels[key] = labelFormatter.format(to);
  }

  return { dates, labels };
};

// @desc    Get Task Timeline (Created last 30 days)
// @route   GET /api/reports/timeline
// @access  Private (Admin, Head only)
exports.getTaskTimeline = async (req, res) => {
  try {
    const payload = await cache.wrap(
      cache.KEYS.report('task-timeline', '30d', scopeKey(req.user)),
      cache.TTL.report,
      async () => {
        const { dates, startDate, endDate } = buildDayBuckets(30);

        // Both bounds, so the match window is exactly the bucket key span
        // (see buildDayBuckets — audit D7).
        const match = { createdAt: { $gte: startDate, $lt: endDate } };
        if (req.user.role === 'Head') match.createdBy = toObjectId(req.user._id);

        // Was: `Task.find(taskQuery)` returning full documents (including
        // `description`, which taskHelper fills with an email excerpt) for 30
        // days, then bucketed in JS. Now 30 rows come back from the database.
        const rows = await Task.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: TIMEZONE } },
              count: { $sum: 1 }
            }
          }
        ]);

        const counts = Object.fromEntries(rows.map((r) => [r._id, r.count]));
        return dates.map((date) => ({ date, count: counts[date] || 0 }));
      }
    );

    setReportCacheHeaders(res, 60);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getTaskTimeline failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve timeline logs.' });
  }
};

// @desc    Get Client-wise statistics
// @route   GET /api/reports/client-stats
// @access  Private (Admin, Head only)
exports.getClientStats = async (req, res) => {
  try {
    const payload = await cache.wrap(
      // Scoped per caller (audit D5): a Head's numbers are their own slice, so
      // the cache entry must be theirs too — `scopeKey` is 'all' for Admin.
      cache.KEYS.report('client-stats', 'all', scopeKey(req.user)),
      cache.TTL.report,
      async () => {
        // Was: THREE `countDocuments` PER CLIENT, every one an unindexed regex
        // scan. At 50 clients, 100k emails and 20k tasks that is 150 sequential
        // queries and roughly 7 million document examinations per request.
        //
        // Now: two cached `$group` aggregations shared with the client list,
        // scoped to what the caller may actually access (audit D5).
        const [clients, taskCounts, mailCounts, unattributed] = await Promise.all([
          Client.find({}).select('name associatedEmails').sort({ name: 1 }).limit(1000).lean(),
          getTaskCountsByClient(req.user),
          getMailCountsByClient(req.user),
          getUnattributedCounts(req.user)
        ]);

        const rows = clients.map((client) => {
          const key = String(client.name || '').toLowerCase();
          const tasks = taskCounts[key] || { total: 0, completed: 0 };
          return {
            _id: client._id,
            name: client.name,
            isUnattributed: false,
            associatedEmails: client.associatedEmails || [],
            emailCount: mailCounts[String(client._id)] || 0,
            taskCount: tasks.total,
            completedTaskCount: tasks.completed,
            // S-9: same derivation as the client list, so the two surfaces
            // cannot report different "open" numbers.
            openTaskCount: Math.max(0, tasks.total - tasks.completed)
          };
        });

        /*
         * H-5 — the honest residual row.
         *
         * These 25 rows summed to 353 tasks and 1,185 emails on a page whose
         * own tiles read 427 and 1,397: 17% of tasks and 15% of mail were
         * discarded by a lowercased-name join, silently, on the screen an owner
         * prices work from. Appended only when it is non-empty, so a workspace
         * where everything IS attributed gains no phantom row.
         *
         * `_id` is the string sentinel '__unattributed__' and `isUnattributed`
         * is true, so the UI can key it safely and render it inert.
         */
        if (unattributed.taskCount > 0 || unattributed.emailCount > 0) {
          rows.push(unattributedRow(unattributed));
        }

        return rows;
      }
    );

    setReportCacheHeaders(res, 120);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getClientStats failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve client statistics.' });
  }
};

// @desc    Get Email Timeline (Received day-wise for last N days)
// @route   GET /api/reports/email-timeline
// @access  Private (Admin, Head only)
exports.getEmailTimeline = async (req, res) => {
  try {
    // Clamp the caller-supplied window. Unbounded, this loop allocates one Date
    // and one map entry per day, so `?days=100000000` stalls the event loop for
    // the whole process — a DoS reachable by any authenticated Head.
    const requestedDays = parseInt(req.query.days, 10);
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 365) : 14;

    const payload = await cache.wrap(
      cache.KEYS.report('email-timeline', `${days}d`, scopeKey(req.user)),
      cache.TTL.report,
      async () => {
        const { dates, labels, startDate, endDate } = buildDayBuckets(days);

        // "Emails received", so outbound replies (F-1) are excluded and this
        // chart reports exactly what it reported before threading existed.
        // Both date bounds, so the match window is exactly the bucket key span
        // and every matched email lands in exactly one bucket (audit D7).
        const match = { date: { $gte: startDate, $lt: endDate }, deletedAt: null, direction: { $ne: 'outbound' } };
        if (req.user.role === 'Head') match.fetchedBy = toObjectId(req.user._id);

        const rows = await Email.aggregate([
          { $match: match },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: TIMEZONE } },
              count: { $sum: 1 },
              assignedCount: { $sum: { $cond: [{ $eq: ['$status', 'assigned'] }, 1, 0] } }
            }
          }
        ]);

        const byDate = Object.fromEntries(rows.map((r) => [r._id, r]));

        return dates.map((date) => ({
          date,
          label: labels[date],
          count: byDate[date]?.count || 0,
          assignedCount: byDate[date]?.assignedCount || 0
        }));
      }
    );

    setReportCacheHeaders(res, 60);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getEmailTimeline failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve email timeline.' });
  }
};

// ===========================================================================
// F-2 — SLA / response-time analytics
//
// Every number here is a MEDIAN or a p90, never a mean. One week-old outlier
// (a mail answered after a holiday) drags a mean far enough to make the metric
// useless for the thing it exists to prove. Both are computed by the
// aggregation pipeline — `$median` / `$percentile`, MongoDB 7.0 — so no
// endpoint ever materialises the full value set in JS.
// ===========================================================================

// Longest reporting window a caller may ask for. Unbounded, the day-bucket loop
// and the business-window list are both a DoS reachable by any authenticated
// Head, exactly like the `?days=` clamp on the email timeline.
const SLA_MAX_RANGE_DAYS = Number(process.env.SLA_MAX_RANGE_DAYS || 366);
const SLA_DEFAULT_RANGE_DAYS = Number(process.env.SLA_DEFAULT_RANGE_DAYS || 30);

/**
 * Parse and clamp the reporting window.
 * @param {Object} req
 * @returns {{from: Date, to: Date, days: Number, key: String}}
 */
const parseRange = (req) => {
  const rawFrom = firstString(req.query.dateFrom, 40);
  const rawTo = firstString(req.query.dateTo, 40);

  const to = rawTo && !Number.isNaN(Date.parse(rawTo)) ? new Date(rawTo) : new Date();
  let from =
    rawFrom && !Number.isNaN(Date.parse(rawFrom))
      ? new Date(rawFrom)
      : new Date(to.getTime() - SLA_DEFAULT_RANGE_DAYS * 86400000);

  if (from > to) from = new Date(to.getTime() - SLA_DEFAULT_RANGE_DAYS * 86400000);

  const maxMs = SLA_MAX_RANGE_DAYS * 86400000;
  if (to - from > maxMs) from = new Date(to.getTime() - maxMs);

  const days = Math.max(1, Math.ceil((to - from) / 86400000));
  return {
    from,
    to,
    days,
    // Minute granularity in the cache key: a second-granularity key would make
    // every request a miss.
    key: `${from.toISOString().slice(0, 16)}_${to.toISOString().slice(0, 16)}`
  };
};

/**
 * Resolve the SLA scope for the caller.
 *
 * A Head is ALWAYS narrowed to their own mailbox and their own tasks — the
 * `scope` parameter can only ever narrow further, never widen. The returned
 * `discriminator` is part of every cache key, because the trap this codebase
 * already hit once is a Head's narrowed slice being served to an Admin for the
 * whole TTL.
 *
 * @param {Object} req
 * @returns {{emailScope: Object, taskScope: Object, scope: String, discriminator: String}}
 */
const resolveSlaScope = (req) => {
  const requested = firstString(req.query.scope, 20).toLowerCase();
  const mine = req.user.role !== 'Admin' || requested === 'mine';
  // `aggregate()` does not cast, and `req.user._id` is a STRING on a cache hit
  // (req.user is served from the JSON `user:<id>` entry). An uncoerced id would
  // silently match nothing and report a clean, empty, wrong report.
  const userId = toObjectId(req.user._id);

  return {
    emailScope: mine ? { fetchedBy: userId } : {},
    // H-4 / M-8: the same `createdBy OR assignedTo` rule the Tasks page and the
    // dashboard now use. A Head's SLA "Resolution" panel was scoped to
    // created-by only, which is a third definition of a Head's tasks in one
    // product.
    taskScope: mine ? ownedByScope(userId) : {},
    scope: mine ? 'mine' : 'all',
    discriminator: mine ? `${req.user.role}:${String(req.user._id)}` : 'all'
  };
};

const MINUTE = 60000;
const toMinutes = (ms) =>
  ms === null || ms === undefined || Number.isNaN(ms) ? null : Math.round((ms / MINUTE) * 10) / 10;

/**
 * The percentile `$group` stage.
 *
 * `$median` and `$percentile` (MongoDB 7.0+) with `method: 'approximate'`: the
 * t-digest is computed by the server in bounded memory. The alternative —
 * `$push` + `$sortArray` — materialises every value into one 16 MB document and
 * falls over at exactly the volume where the metric starts to matter.
 *
 * @param {String} valueField - e.g. '$elapsedMs'
 * @returns {Object}
 */
const percentileGroup = (valueField) => ({
  $group: {
    _id: null,
    count: { $sum: 1 },
    breachCount: { $sum: { $cond: [{ $gt: [valueField, '$targetMs'] }, 1, 0] } },
    medianMs: { $median: { input: valueField, method: 'approximate' } },
    p90Ms: { $percentile: { input: valueField, p: [0.9], method: 'approximate' } },
    maxMs: { $max: valueField }
  }
});

/**
 * Shape a percentileGroup row into the documented metric object.
 * @param {Object|undefined} row
 * @param {Object} [extra]
 * @returns {Object}
 */
const shapeMetric = (row, extra = {}) => {
  const count = row?.count || 0;
  const breachCount = row?.breachCount || 0;
  return {
    median: toMinutes(row?.medianMs ?? null),
    p90: toMinutes(Array.isArray(row?.p90Ms) ? row.p90Ms[0] : row?.p90Ms ?? null),
    max: toMinutes(row?.maxMs ?? null),
    count,
    breachCount,
    breachRate: count > 0 ? Math.round((breachCount / count) * 1000) / 1000 : 0,
    ...extra
  };
};

/**
 * Thread-level grouping used by the first-response and backlog pipelines.
 * @returns {Object} a $group stage
 */
const slaThreadGroup = () => ({
  $group: {
    _id: '$threadId',
    // `$min`/`$max` ignore nulls, so the $cond acts as a direction filter
    // without a second pass over the collection.
    firstInboundAt: { $min: { $cond: [{ $eq: ['$direction', 'outbound'] }, null, '$date'] } },
    lastInboundAt: { $max: { $cond: [{ $eq: ['$direction', 'outbound'] }, null, '$date'] } },
    firstOutboundAt: { $min: { $cond: [{ $eq: ['$direction', 'outbound'] }, '$date', null] } },
    lastOutboundAt: { $max: { $cond: [{ $eq: ['$direction', 'outbound'] }, '$date', null] } },
    clientId: { $max: '$clientId' }
  }
});

/**
 * Build the three SLA pipelines for one request.
 * @param {Object} args
 * @returns {Promise<Object>} the payload documented in
 *          docs/audits/IMPL-features-threading-sla.md
 */
const computeSla = async ({ range, scope, policies }) => {
  const windows = businessWindows(range.from, range.to, policies.default);
  const now = new Date();

  const emailMatch = {
    deletedAt: null,
    threadId: { $nin: [null, ''] },
    ...scope.emailScope
  };

  const firstResponseTargets = targetMsExpr(policies, 'firstResponseMinutes');
  const resolutionTargets = targetMsExpr(policies, 'resolutionMinutes');

  // --- first response: earliest outbound minus first inbound, per thread ---
  const firstResponsePipeline = [
    { $match: emailMatch },
    slaThreadGroup(),
    // The window is applied to when the CONVERSATION started, so a thread is
    // reported in the period a client actually wrote in.
    { $match: { firstInboundAt: { $gte: range.from, $lte: range.to } } },
    {
      $project: {
        clientId: 1,
        answered: { $ne: ['$firstOutboundAt', null] },
        elapsedMs: elapsedMsExpr('$firstInboundAt', '$firstOutboundAt', windows),
        targetMs: firstResponseTargets
      }
    },
    {
      $facet: {
        answered: [{ $match: { elapsedMs: { $ne: null } } }, percentileGroup('$elapsedMs')],
        // Threads that have had no reply at all are NOT a zero-minute response
        // and must never be folded into the median; they are reported
        // separately as `pendingCount`.
        pending: [{ $match: { answered: false } }, { $count: 'value' }]
      }
    }
  ];

  // --- backlog: unanswered inbound, aged from the first inbound to NOW ---
  const backlogPipeline = [
    { $match: emailMatch },
    slaThreadGroup(),
    {
      $match: {
        firstInboundAt: { $gte: range.from, $lte: range.to },
        lastInboundAt: { $ne: null }
      }
    },
    {
      $match: {
        $expr: {
          $or: [{ $eq: ['$lastOutboundAt', null] }, { $lt: ['$lastOutboundAt', '$lastInboundAt'] }]
        }
      }
    },
    {
      $project: {
        clientId: 1,
        elapsedMs: elapsedMsExpr('$firstInboundAt', now, windows),
        targetMs: firstResponseTargets
      }
    },
    { $match: { elapsedMs: { $ne: null } } },
    percentileGroup('$elapsedMs')
  ];

  // --- resolution: linked task completedAt minus the thread's first inbound ---
  const resolutionPipeline = [
    {
      $match: {
        status: 'Completed',
        completedAt: { $gte: range.from, $lte: range.to },
        linkedEmail: { $ne: null },
        ...scope.taskScope
      }
    },
    {
      $lookup: {
        from: 'emails',
        localField: 'linkedEmail',
        foreignField: '_id',
        as: 'linked',
        // Projected INSIDE the lookup: `select: false` is a Mongoose-level
        // rule, so an unprojected $lookup would drag every multi-megabyte body
        // through the pipeline.
        pipeline: [{ $project: { threadId: 1, date: 1, clientId: 1, deletedAt: 1 } }]
      }
    },
    { $unwind: '$linked' },
    { $match: { 'linked.deletedAt': null } },
    {
      $lookup: {
        from: 'emails',
        let: { tid: '$linked.threadId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $ne: ['$$tid', null] },
                  { $eq: ['$threadId', '$$tid'] },
                  { $eq: ['$deletedAt', null] },
                  { $ne: ['$direction', 'outbound'] }
                ]
              }
            }
          },
          { $group: { _id: null, firstInboundAt: { $min: '$date' } } }
        ],
        as: 'thread'
      }
    },
    {
      $project: {
        clientId: '$linked.clientId',
        completedAt: 1,
        // Falls back to the linked message's own date for a task whose email
        // predates the threading backfill.
        startAt: { $ifNull: [{ $arrayElemAt: ['$thread.firstInboundAt', 0] }, '$linked.date'] }
      }
    },
    {
      $project: {
        clientId: 1,
        elapsedMs: elapsedMsExpr('$startAt', '$completedAt', windows),
        targetMs: resolutionTargets
      }
    },
    { $match: { elapsedMs: { $ne: null } } },
    percentileGroup('$elapsedMs')
  ];

  const [firstResponseResult, backlogRows, resolutionRows] = await Promise.all([
    Email.aggregate(firstResponsePipeline).allowDiskUse(true),
    Email.aggregate(backlogPipeline).allowDiskUse(true),
    Task.aggregate(resolutionPipeline).allowDiskUse(true)
  ]);

  const facet = firstResponseResult?.[0] || {};

  return {
    range: {
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      days: range.days,
      timezone: TIMEZONE
    },
    scope: scope.scope,
    unit: 'minutes',
    policy: {
      source: policies.default.scope,
      firstResponseMinutes: policies.default.firstResponseMinutes,
      resolutionMinutes: policies.default.resolutionMinutes,
      businessHours: policies.default.businessHours,
      clientOverrides: Object.keys(policies.byClient).length
    },
    firstResponse: shapeMetric(facet.answered?.[0], {
      pendingCount: facet.pending?.[0]?.value || 0
    }),
    resolution: shapeMetric(resolutionRows?.[0]),
    backlog: shapeMetric(backlogRows?.[0]),
    generatedAt: new Date().toISOString()
  };
};

// @desc    SLA summary — median/p90 first response, resolution and backlog
// @route   GET /api/reports/sla?dateFrom=&dateTo=&scope=
// @access  Private (Admin, Head — a Head is always scoped to their own mailbox)
exports.getSlaSummary = async (req, res) => {
  try {
    const range = parseRange(req);
    const scope = resolveSlaScope(req);
    const policies = await getEffectivePolicies();

    const payload = await cache.wrap(
      // The scope discriminator is part of the key. Without it a Head's
      // narrowed numbers would be served to the Admin for the whole TTL.
      cache.KEYS.report('sla', range.key, scope.discriminator),
      cache.TTL.sla,
      () => computeSla({ range, scope, policies })
    );

    setReportCacheHeaders(res, 60);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getSlaSummary failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve SLA statistics.' });
  }
};

/**
 * Day-bucketed SLA metrics.
 * @param {Object} args
 * @returns {Promise<Object>}
 */
const computeSlaTimeseries = async ({ range, scope, policies }) => {
  const windows = businessWindows(range.from, range.to, policies.default);

  const dayOf = (field) => ({
    $dateToString: { format: '%Y-%m-%d', date: field, timezone: TIMEZONE }
  });

  const firstResponsePipeline = [
    { $match: { deletedAt: null, threadId: { $nin: [null, ''] }, ...scope.emailScope } },
    slaThreadGroup(),
    { $match: { firstInboundAt: { $gte: range.from, $lte: range.to } } },
    {
      $project: {
        day: dayOf('$firstInboundAt'),
        elapsedMs: elapsedMsExpr('$firstInboundAt', '$firstOutboundAt', windows),
        targetMs: targetMsExpr(policies, 'firstResponseMinutes')
      }
    },
    { $match: { elapsedMs: { $ne: null } } },
    {
      $group: {
        _id: '$day',
        count: { $sum: 1 },
        breachCount: { $sum: { $cond: [{ $gt: ['$elapsedMs', '$targetMs'] }, 1, 0] } },
        medianMs: { $median: { input: '$elapsedMs', method: 'approximate' } },
        p90Ms: { $percentile: { input: '$elapsedMs', p: [0.9], method: 'approximate' } }
      }
    }
  ];

  const resolutionPipeline = [
    {
      $match: {
        status: 'Completed',
        completedAt: { $gte: range.from, $lte: range.to },
        linkedEmail: { $ne: null },
        ...scope.taskScope
      }
    },
    {
      $lookup: {
        from: 'emails',
        localField: 'linkedEmail',
        foreignField: '_id',
        as: 'linked',
        pipeline: [{ $project: { threadId: 1, date: 1, clientId: 1, deletedAt: 1 } }]
      }
    },
    { $unwind: '$linked' },
    { $match: { 'linked.deletedAt': null } },
    {
      $lookup: {
        from: 'emails',
        let: { tid: '$linked.threadId' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $ne: ['$$tid', null] },
                  { $eq: ['$threadId', '$$tid'] },
                  { $eq: ['$deletedAt', null] },
                  { $ne: ['$direction', 'outbound'] }
                ]
              }
            }
          },
          { $group: { _id: null, firstInboundAt: { $min: '$date' } } }
        ],
        as: 'thread'
      }
    },
    {
      $project: {
        day: dayOf('$completedAt'),
        clientId: '$linked.clientId',
        startAt: { $ifNull: [{ $arrayElemAt: ['$thread.firstInboundAt', 0] }, '$linked.date'] },
        completedAt: 1
      }
    },
    {
      $project: {
        day: 1,
        elapsedMs: elapsedMsExpr('$startAt', '$completedAt', windows),
        targetMs: targetMsExpr(policies, 'resolutionMinutes')
      }
    },
    { $match: { elapsedMs: { $ne: null } } },
    {
      $group: {
        _id: '$day',
        count: { $sum: 1 },
        breachCount: { $sum: { $cond: [{ $gt: ['$elapsedMs', '$targetMs'] }, 1, 0] } },
        medianMs: { $median: { input: '$elapsedMs', method: 'approximate' } },
        p90Ms: { $percentile: { input: '$elapsedMs', p: [0.9], method: 'approximate' } }
      }
    }
  ];

  const [frRows, resRows] = await Promise.all([
    Email.aggregate(firstResponsePipeline).allowDiskUse(true),
    Task.aggregate(resolutionPipeline).allowDiskUse(true)
  ]);

  // Zero-filled buckets, in the SAME timezone as `$dateToString` above — a
  // mismatch here silently reads boundary days as zero. Anchored to the
  // REQUESTED range, not to "today", so a historical window is bucketed where
  // the caller asked for it.
  const { dates, labels } = buildRangeBuckets(range.from, range.to);
  const byDayFr = Object.fromEntries(frRows.map((r) => [r._id, r]));
  const byDayRes = Object.fromEntries(resRows.map((r) => [r._id, r]));
  const p90 = (row) => (Array.isArray(row?.p90Ms) ? row.p90Ms[0] : row?.p90Ms ?? null);

  return {
    range: {
      dateFrom: range.from.toISOString(),
      dateTo: range.to.toISOString(),
      days: range.days,
      timezone: TIMEZONE
    },
    scope: scope.scope,
    unit: 'minutes',
    buckets: dates.map((date) => {
      const fr = byDayFr[date];
      const rs = byDayRes[date];
      return {
        date,
        label: labels[date],
        firstResponseMedian: toMinutes(fr?.medianMs ?? null),
        firstResponseP90: toMinutes(p90(fr)),
        firstResponseCount: fr?.count || 0,
        firstResponseBreachCount: fr?.breachCount || 0,
        resolutionMedian: toMinutes(rs?.medianMs ?? null),
        resolutionP90: toMinutes(p90(rs)),
        resolutionCount: rs?.count || 0,
        resolutionBreachCount: rs?.breachCount || 0
      };
    }),
    generatedAt: new Date().toISOString()
  };
};

// @desc    SLA daily buckets, for charting
// @route   GET /api/reports/sla/timeseries?dateFrom=&dateTo=&scope=
// @access  Private (Admin, Head — a Head is always scoped to their own mailbox)
exports.getSlaTimeseries = async (req, res) => {
  try {
    const range = parseRange(req);
    const scope = resolveSlaScope(req);
    const policies = await getEffectivePolicies();

    const payload = await cache.wrap(
      cache.KEYS.report('sla-timeseries', range.key, scope.discriminator),
      cache.TTL.sla,
      () => computeSlaTimeseries({ range, scope, policies })
    );

    setReportCacheHeaders(res, 60);
    return res.status(200).json(payload);
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getSlaTimeseries failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve the SLA timeseries.' });
  }
};

// @desc    Read the effective SLA policy set
// @route   GET /api/reports/sla/policy
// @access  Private (Admin, Head — read only)
exports.getSlaPolicyConfig = async (req, res) => {
  try {
    const policies = await getEffectivePolicies();
    const clients = await Client.find({ _id: { $in: Object.keys(policies.byClient) } })
      .select('name')
      .lean();
    const nameById = Object.fromEntries(clients.map((c) => [String(c._id), c.name]));

    setReportCacheHeaders(res, 60);
    return res.status(200).json({
      default: policies.default,
      clientOverrides: Object.entries(policies.byClient).map(([clientId, policy]) => ({
        clientId,
        clientName: nameById[clientId] || null,
        firstResponseMinutes: policy.firstResponseMinutes,
        resolutionMinutes: policy.resolutionMinutes,
        businessHours: policy.businessHours
      }))
    });
  } catch (error) {
    logger.error({ err: error.message }, 'getSlaPolicyConfig failed');
    return res.status(500).json({ message: 'Server error. Failed to read the SLA policy.' });
  }
};

// @desc    Upsert the global SLA policy, or one client override
// @route   PUT /api/reports/sla/policy
// @access  Private (Admin only)
exports.updateSlaPolicyConfig = async (req, res) => {
  try {
    const { clientId, firstResponseMinutes, resolutionMinutes, businessHours } = req.body;

    if (clientId) {
      const exists = await Client.exists({ _id: clientId });
      if (!exists) return res.status(404).json({ message: 'Client not found.' });
    }

    const update = { updatedAt: new Date(), updatedBy: req.user._id };
    if (firstResponseMinutes !== undefined) update.firstResponseMinutes = firstResponseMinutes;
    if (resolutionMinutes !== undefined) update.resolutionMinutes = resolutionMinutes;
    if (businessHours !== undefined) update.businessHours = businessHours;

    const filter = clientId
      ? { scope: 'client', client: new mongoose.Types.ObjectId(String(clientId)) }
      : { scope: 'global', client: null };

    const saved = await SlaPolicy.findOneAndUpdate(
      filter,
      { $set: update, $setOnInsert: filter },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    ).lean();

    // Changing a TARGET moves every breach count without any task or email
    // having changed, so the derived aggregates are dropped explicitly.
    await cache.invalidateSlaPolicies();

    return res.status(200).json({ message: 'SLA policy updated.', policy: saved });
  } catch (error) {
    logger.error({ err: error.message }, 'updateSlaPolicyConfig failed');
    return res.status(500).json({ message: 'Server error. Failed to update the SLA policy.' });
  }
};
