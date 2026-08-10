const Task = require('../models/Task');
const User = require('../models/User');
const { acquire } = require('./lock');
const { isRedisConfigured } = require('./redis');
const { getAppTimezone, zonedDayKey, zonedHour } = require('./dateHelper');
const { taskOverdueDigest } = require('./emailTemplates');
const { formatWhen, taskUrl, taskListUrl } = require('./taskMailer');
const { log } = require('./logger');

const logger = log('overdue-digest');

/**
 * The DAILY overdue email digest.
 *
 * Deliberately separate from `runOverdueScan` in utils/cronJobs.js, which runs
 * every five minutes, flips tasks to Late and writes in-app notifications. That
 * job is tuned and is left exactly as it was; this one only sends mail.
 *
 * Why a digest and not one mail per task: the demo database alone carries well
 * over a hundred overdue tasks. Per-task mail would put three figures of
 * near-identical messages in one inbox every morning, which no one reads and
 * which is the quickest route to the sending domain being classified as spam.
 * One message per PERSON, listing everything they need to see.
 *
 * Who gets what:
 *   - an assignee gets THEIR overdue tasks;
 *   - an Admin/Head gets the office-wide list;
 *   - someone who is both gets ONE email — the office-wide one, which already
 *     contains their own tasks and says how many of them are theirs.
 *   - anyone with nothing overdue gets nothing. An empty digest is worse than
 *     no digest: it trains people that the message is never worth opening.
 */

// Local hour (in APP_TIMEZONE) at or after which the day's digest may go out.
const DIGEST_HOUR = (() => {
  const raw = Number(process.env.OVERDUE_DIGEST_HOUR);
  if (!Number.isFinite(raw)) return 9;
  return Math.min(23, Math.max(0, Math.trunc(raw)));
})();

// Set OVERDUE_DIGEST_ENABLED=false to keep the in-app overdue notifications
// while sending no mail at all.
const ENABLED = String(process.env.OVERDUE_DIGEST_ENABLED ?? 'true').toLowerCase() !== 'false';

// Ceiling on the tasks one run will read. An unbounded find here is the same
// OOM the five-minute scan already bounds itself against.
const MAX_TASKS = Number(process.env.OVERDUE_DIGEST_MAX_TASKS || 2000);

// Tasks listed in one message before it says "and N more".
const MAX_ROWS = Number(process.env.OVERDUE_DIGEST_MAX_ROWS || 25);

// The once-a-day claim outlives the local day it names. The key CONTAINS the
// day, so a stale one can never block the next day's run; the TTL exists only
// so the keys do not accumulate forever.
const CLAIM_TTL_MS = 26 * 60 * 60 * 1000;

/**
 * A recipient must be a live, approved account with an address.
 * @param {Object} user
 * @returns {Boolean}
 */
const isDeliverable = (user) =>
  Boolean(user && !user.deletedAt && user.status === 'Approved' && user.email);

/**
 * "3 days" / "5 hours" / "20 minutes" — coarse on purpose, since the exact
 * deadline is printed alongside it.
 *
 * @param {Date|String|null} deadline
 * @param {Date} now
 * @returns {String}
 */
const overdueBy = (deadline, now) => {
  if (!deadline) return 'unknown';
  const ms = now.getTime() - new Date(deadline).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 'just now';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};

/**
 * Group overdue tasks into ONE digest per recipient.
 *
 * Pure: no database, no clock beyond the `now` handed in, no sending. That is
 * what makes "does this group per user or per task" a question the smoke test
 * can answer for certain.
 *
 * @param {Array<Object>} tasks - lean overdue tasks, deadline-ascending
 * @param {Map<String, Object>} usersById - every referenced user, deliverable or not
 * @param {Array<String>} supervisorIds - Admin/Head ids
 * @param {Object} [options]
 * @param {Number} [options.maxRows]
 * @returns {Array<{userId: String, email: String, name: String, scope: String,
 *                  ownedCount: Number, totalCount: Number, tasks: Array<Object>}>}
 */
const buildOverdueDigests = (tasks, usersById, supervisorIds = [], options = {}) => {
  const maxRows = options.maxRows ?? MAX_ROWS;
  const list = tasks || [];

  // Nothing overdue means nobody is written to, supervisors included.
  if (list.length === 0) return [];

  const byAssignee = new Map();
  for (const task of list) {
    if (!task.assignedTo) continue;
    const id = String(task.assignedTo);
    if (!byAssignee.has(id)) byAssignee.set(id, []);
    byAssignee.get(id).push(task);
  }

  const digests = new Map();

  // Supervisors FIRST, so the office-wide digest wins for anyone who is both a
  // supervisor and an assignee. Claiming the slot here is what guarantees one
  // email rather than two.
  for (const rawId of supervisorIds) {
    const id = String(rawId);
    const user = usersById.get(id);
    if (!isDeliverable(user)) continue;
    digests.set(id, {
      userId: id,
      email: user.email,
      name: user.name || 'there',
      scope: 'office',
      ownedCount: (byAssignee.get(id) || []).length,
      totalCount: list.length,
      tasks: list.slice(0, maxRows)
    });
  }

  for (const [id, owned] of byAssignee) {
    if (digests.has(id)) continue; // already covered by the office-wide digest
    const user = usersById.get(id);
    // Tasks assigned to a deleted or unapproved account still appear in the
    // supervisors' office-wide list; there is simply nobody to mail directly.
    if (!isDeliverable(user)) continue;
    digests.set(id, {
      userId: id,
      email: user.email,
      name: user.name || 'there',
      scope: 'assignee',
      ownedCount: owned.length,
      totalCount: owned.length,
      tasks: owned.slice(0, maxRows)
    });
  }

  return [...digests.values()];
};

/**
 * Build the rendered rows for one digest.
 * @param {Array<Object>} tasks
 * @param {Map<String, Object>} usersById
 * @param {Boolean} withAssignee - office digests name the owner
 * @param {Date} now
 * @returns {Array<{title: String, meta: String[], url: String}>}
 */
const renderRows = (tasks, usersById, withAssignee, now) =>
  tasks.map((task) => {
    const owner = task.assignedTo ? usersById.get(String(task.assignedTo)) : null;
    return {
      title: task.title || 'Untitled task',
      meta: [
        task.clientName ? `Client: ${task.clientName}` : null,
        withAssignee ? `Assignee: ${owner?.name || 'Unassigned'}` : null,
        `Was due ${formatWhen(task.deadline)}`,
        `${overdueBy(task.deadline, now)} overdue`
      ].filter(Boolean),
      url: taskUrl(task._id)
    };
  });

/**
 * Read the overdue tasks, group them and queue one email per recipient.
 *
 * Sends nothing and touches no task document — the five-minute scan owns the
 * Late transition and the in-app rows.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<{tasks: Number, recipients: Number, queued: Number, skipped: String|null}>}
 */
const runOverdueDigest = async (options = {}) => {
  const now = options.now || new Date();

  // "Overdue" is the same predicate the five-minute scan uses to flip tasks to
  // Late, plus the tasks it has already flipped. Reading only `status: 'Late'`
  // would miss everything that went past its deadline since the last tick.
  const tasks = await Task.find({
    status: { $in: ['Pending', 'Late'] },
    deadline: { $ne: null, $lt: now }
  })
    .select('_id title clientName priority deadline assignedTo')
    .sort({ deadline: 1 })
    .limit(MAX_TASKS)
    .lean();

  if (tasks.length === 0) {
    logger.info('nothing overdue; no digest sent');
    return { tasks: 0, recipients: 0, queued: 0, skipped: null };
  }

  const supervisors = await User.find({
    role: { $in: ['Admin', 'Head'] },
    deletedAt: null,
    status: 'Approved'
  })
    .select('_id name email role status deletedAt')
    .lean();

  const assigneeIds = [...new Set(tasks.filter((t) => t.assignedTo).map((t) => String(t.assignedTo)))];
  // No status filter: the office-wide digest still has to NAME the owner of a
  // task whose assignee has since been deactivated. Deliverability is decided
  // separately, by isDeliverable.
  const assignees = await User.find({ _id: { $in: assigneeIds } })
    .select('_id name email role status deletedAt')
    .lean();

  const usersById = new Map();
  for (const user of [...supervisors, ...assignees]) usersById.set(String(user._id), user);

  const digests = buildOverdueDigests(
    tasks,
    usersById,
    supervisors.map((s) => String(s._id)),
    { maxRows: MAX_ROWS }
  );

  const listUrl = taskListUrl();
  let queued = 0;

  for (const digest of digests) {
    try {
      const mail = taskOverdueDigest({
        recipientName: digest.name,
        tasks: renderRows(digest.tasks, usersById, digest.scope === 'office', now),
        totalCount: digest.totalCount,
        scope: digest.scope,
        ownedCount: digest.ownedCount,
        listUrl
      });

      // Required at call time so the module graph stays acyclic and so a test
      // can substitute the transport.
      const { sendEmail } = require('./emailHelper');
      const handle = await sendEmail(digest.email, mail.subject, mail.text, mail.html, {
        event: 'task_overdue',
        userId: digest.userId
      });
      if (handle) queued += 1;
    } catch (err) {
      // One bad recipient must not cost everyone else their digest.
      logger.error({ err: err.message, userId: digest.userId }, 'failed to queue overdue digest');
    }
  }

  logger.info(
    { tasks: tasks.length, recipients: digests.length, queued },
    'overdue digest complete'
  );
  return { tasks: tasks.length, recipients: digests.length, queued, skipped: null };
};

/**
 * The cron entry point: send today's digest if it is due and has not gone out.
 *
 * Called HOURLY rather than once at the target hour, and gated on the local
 * clock instead. `node-cron` is an in-process timer with no persistence, so a
 * process that is restarted at 09:05 never fires a `0 9 * * *` schedule and the
 * digest is silently lost for the day; an hourly check plus a day claim catches
 * up instead.
 *
 * The claim is `lock.acquire()` on a key naming the LOCAL day, and it is
 * deliberately never released — that is what makes the job idempotent per day
 * across replicas and across restarts. With Redis the claim is cluster-wide;
 * without it, it is per-process, the same trade-off utils/lock.js already
 * documents for every other scheduled job.
 *
 * The claim is taken BEFORE the send. A crash mid-run therefore loses the rest
 * of that day's digest rather than re-mailing everyone who already received it,
 * which is the right way round: a missing summary is a nuisance, a duplicate
 * one is what gets the sender blocked.
 *
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @returns {Promise<{tasks: Number, recipients: Number, queued: Number, skipped: String|null}>}
 */
const runOverdueDigestIfDue = async (options = {}) => {
  const now = options.now || new Date();
  const empty = (skipped) => ({ tasks: 0, recipients: 0, queued: 0, skipped });

  if (!ENABLED) return empty('disabled');

  const timeZone = getAppTimezone();
  if (zonedHour(now, timeZone) < DIGEST_HOUR) return empty('before-digest-hour');

  const dayKey = zonedDayKey(now, timeZone);
  const claim = await acquire(`cron:overdue-digest:${dayKey}`, CLAIM_TTL_MS);
  if (!claim.acquired) return empty('already-sent-today');

  // The claim must be the CLUSTER-WIDE one when Redis is configured. lock.js
  // deliberately degrades to a per-process guard if Redis is unreachable, which
  // is right for a five-minute scan — running it twice costs a duplicate row —
  // but wrong here: two replicas both degrading would put two identical digests
  // in every inbox. A Redis client is created with `enableOfflineQueue: false`,
  // so the first attempt after a restart lands on the local guard even when
  // Redis is healthy; releasing it lets the next hourly tick claim properly
  // instead of burning the day.
  if (isRedisConfigured() && claim.via !== 'redis') {
    await claim.release();
    logger.warn({ day: dayKey }, 'overdue digest deferred: could not take the cluster-wide day claim');
    return empty('claim-unverified');
  }

  logger.info({ day: dayKey, hour: DIGEST_HOUR, timeZone }, 'running daily overdue digest');
  return runOverdueDigest({ now });
};

module.exports = {
  runOverdueDigest,
  runOverdueDigestIfDue,
  buildOverdueDigests,
  overdueBy,
  isDeliverable,
  DIGEST_HOUR,
  ENABLED
};
