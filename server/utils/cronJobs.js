const cron = require('node-cron');
const Task = require('../models/Task');
const User = require('../models/User');
const { createNotifications } = require('./notificationHelper');
const { withLock } = require('./lock');
const { runOverdueDigestIfDue } = require('./overdueDigest');
const queue = require('./queue');
const cache = require('./cache');
const { log } = require('./logger');

const logger = log('cron');

const scheduled = [];

// A one-minute overdue SLA is not a product requirement, and the job used to
// run every 60 seconds forever, logging a line on each tick.
const OVERDUE_PATTERN = process.env.CRON_OVERDUE_PATTERN || '*/5 * * * *';
const SYNC_PATTERN = process.env.CRON_SYNC_PATTERN || '*/10 * * * *';
const OVERDUE_BATCH = Number(process.env.CRON_OVERDUE_BATCH || 1000);
// The overdue EMAIL digest is a once-a-day message, but the schedule that
// drives it ticks hourly: node-cron holds no state across a restart, so a
// `0 9 * * *` schedule missed by a deploy at 09:05 is lost for the day. The job
// itself decides whether the local hour has arrived and claims the day exactly
// once — see utils/overdueDigest.js.
const OVERDUE_DIGEST_PATTERN = process.env.CRON_OVERDUE_DIGEST_PATTERN || '0 * * * *';

/**
 * Flip newly overdue tasks to Late and notify once.
 * @param {Object} io - socket.io server
 * @returns {Promise<void>}
 */
const runOverdueScan = async (io) => {
  const now = new Date();

  // Only tasks that have NOT already been notified about. `overdueNotifiedAt`
  // makes the notification fire exactly once per task; it is re-armed by
  // updateTask when the deadline moves or the task leaves the Late state.
  //
  // Bounded and projected: an overnight backlog of thousands of tasks must not
  // materialise as thousands of full documents in one tick. The
  // { status, overdueNotifiedAt, deadline } index covers this exact shape.
  const overdueTasks = await Task.find({
    status: 'Pending',
    deadline: { $ne: null, $lt: now },
    overdueNotifiedAt: null
  })
    .select('_id title assignedTo')
    .limit(OVERDUE_BATCH)
    .populate('assignedTo', 'name')
    .lean();

  if (overdueTasks.length === 0) {
    // Still flip any already-notified stragglers to Late without notifying.
    await Task.updateMany(
      { status: 'Pending', deadline: { $ne: null, $lt: now } },
      { $set: { status: 'Late' } }
    );
    return;
  }

  logger.info({ count: overdueTasks.length }, 'flipping newly overdue tasks to Late');

  // The supervisor list is cached: this query ran EVERY MINUTE against an
  // unindexed `role` field, i.e. a full collection scan per tick. `role` is now
  // indexed as well.
  const supervisorIds = await cache.wrap('cron:supervisors', 300, async () => {
    const supervisors = await User.find({
      role: { $in: ['Admin', 'Head'] },
      deletedAt: null,
      status: 'Approved'
    })
      .select('_id')
      .lean();
    return supervisors.map((s) => String(s._id));
  });

  // One write for the whole batch instead of one save() per task.
  await Task.updateMany(
    { _id: { $in: overdueTasks.map((t) => t._id) } },
    { $set: { status: 'Late', overdueNotifiedAt: now } }
  );

  // Build every notification up front, then insert them in ONE write.
  const notifications = [];

  for (const task of overdueTasks) {
    if (task.assignedTo) {
      notifications.push({
        userId: task.assignedTo._id,
        message: `Your task is overdue: ${task.title}`,
        taskId: task._id,
        // Was untyped while the supervisor digest below set `task_overdue`, so
        // the person who actually owns the task got a row the bell rendered as
        // a generic "Update" — and, worse, one that per-type preference
        // suppression skipped entirely, making the Profile toggle a no-op for
        // exactly the user it matters most to.
        type: 'task_overdue'
      });
    }
  }

  // Notify each Admin/Head ONCE with a digest, rather than once per task. The
  // original nested loop was O(tasks x supervisors) SEQUENTIAL writes: 500
  // overdue tasks and 10 supervisors meant 5,000 individual notification saves
  // and 5,500 socket emits inside a single tick.
  const digestLines = overdueTasks
    .map((t) => `"${t.title}" (${t.assignedTo ? t.assignedTo.name : 'Unassigned'})`)
    .slice(0, 10)
    .join(', ');
  const extra = overdueTasks.length > 10 ? ` and ${overdueTasks.length - 10} more` : '';
  const digestMessage =
    overdueTasks.length === 1
      ? `Task overdue: ${digestLines}`
      : `${overdueTasks.length} tasks are overdue: ${digestLines}${extra}`;

  for (const supervisorId of supervisorIds) {
    notifications.push({
      userId: supervisorId,
      message: digestMessage,
      taskId: overdueTasks.length === 1 ? overdueTasks[0]._id : null,
      // S-12: typed so a supervisor can mute the overdue digest specifically.
      type: 'task_overdue'
    });
  }

  await createNotifications(notifications, io);
  await cache.invalidateStats();

  logger.info({ tasks: overdueTasks.length, notifications: notifications.length }, 'overdue scan complete');
};

/**
 * Queue an automatic sync for every mailbox-owning user.
 * @returns {Promise<Number>} number of jobs enqueued
 */
const runAutoSyncScan = async () => {
  const users = await User.find({
    // Do not keep syncing mailboxes for deleted or deactivated accounts.
    deletedAt: null,
    status: 'Approved',
    $or: [
      { gmailAccessToken: { $exists: true, $nin: [null, ''] } },
      { 'linkedGmailAccounts.0': { $exists: true } }
    ]
  })
    .select('_id email')
    .lean();

  if (users.length === 0) return 0;

  // ENQUEUE rather than run. The cron tick used to call syncUserEmails inline
  // and sequentially for every user — about 30 s per mailbox — inside a timer
  // that does not skip overlapping executions, so the next tick fired while the
  // previous one was still running.
  for (const user of users) {
    await queue.enqueueUnique(
      queue.QUEUES.GMAIL_SYNC,
      String(user._id),
      { userId: String(user._id), isManual: false },
      { attempts: Number(process.env.GMAIL_JOB_ATTEMPTS || 3), backoffMs: 10000 }
    );
  }

  logger.info({ users: users.length }, 'auto-sync jobs queued');
  return users.length;
};

/**
 * Start the schedulers.
 *
 * Every job body runs under a distributed lock. `node-cron` is an in-process
 * timer with no coordination, so with three replicas the overdue job fired
 * three times per interval (three sets of duplicate notification rows) and
 * three workers raced to insert the same Gmail messageId. With Redis the lock
 * is cluster-wide; without it, it still prevents a slow tick from overlapping
 * the next one — which the old code did not do either.
 *
 * @param {Object} io - Socket.io server instance
 * @returns {void}
 */
const startCronJobs = (io) => {
  logger.info(
    { overdue: OVERDUE_PATTERN, sync: SYNC_PATTERN, overdueDigest: OVERDUE_DIGEST_PATTERN },
    'starting cron scheduler'
  );

  scheduled.push(
    cron.schedule(OVERDUE_PATTERN, async () => {
      try {
        // The lease is slightly shorter than the interval so a crashed holder
        // does not block the next tick for long.
        await withLock('cron:overdue', 4 * 60 * 1000, () => runOverdueScan(io));
      } catch (error) {
        logger.error({ err: error.message, stack: error.stack }, 'overdue task evaluation failed');
      }
    })
  );

  scheduled.push(
    cron.schedule(SYNC_PATTERN, async () => {
      try {
        await withLock('cron:gmail-sync', 9 * 60 * 1000, () => runAutoSyncScan());
      } catch (error) {
        logger.error({ err: error.message, stack: error.stack }, 'automatic email sync scheduling failed');
      }
    })
  );

  scheduled.push(
    cron.schedule(OVERDUE_DIGEST_PATTERN, async () => {
      try {
        // No withLock() here on purpose: the job's own once-a-day claim is the
        // lock, and it is held for the rest of the day rather than the length
        // of one tick, so it also prevents a slow run overlapping the next.
        const result = await runOverdueDigestIfDue();
        if (result && result.queued > 0) {
          logger.info(
            { recipients: result.recipients, tasks: result.tasks, queued: result.queued },
            'overdue digest queued'
          );
        }
      } catch (error) {
        logger.error({ err: error.message, stack: error.stack }, 'overdue email digest failed');
      }
    })
  );
};

/**
 * Stop every scheduled job, so a tick cannot fire while the process is
 * draining.
 * @returns {void}
 */
const stopCronJobs = () => {
  for (const job of scheduled) {
    if (job && typeof job.stop === 'function') job.stop();
  }
  scheduled.length = 0;
};

module.exports = {
  startCronJobs,
  stopCronJobs,
  runOverdueScan,
  runAutoSyncScan,
  // Re-exported so the daily digest is reachable from the same module as the
  // scan it deliberately does NOT live inside.
  runOverdueDigestIfDue
};
