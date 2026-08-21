const { getAppTimezone } = require('./dateHelper');
const { taskAssigned, taskAssignedDigest } = require('./emailTemplates');
const { log } = require('./logger');

const logger = log('task-mail');

/**
 * "A task was assigned to you" mail.
 *
 * The Profile page has had an email toggle for `task_assigned` since the
 * notification-preference work landed, but nothing ever called the template —
 * the switch controlled nothing. Every assignment path now goes through here,
 * so there is exactly one place that decides who gets mailed and when.
 *
 * Three rules live in this module rather than at the call sites, because a rule
 * duplicated across four controllers is a rule that will diverge:
 *
 *   1. NEVER mail someone about a task they assigned to themselves. For an
 *      Admin writing down their own work that is every single task they create,
 *      and it is the fastest way to train someone to filter the sender.
 *   2. A reassignment notifies the NEW assignee only. The person who lost the
 *      task did not gain a to-do.
 *   3. Mail must never break the operation that triggered it. Nothing here
 *      throws; a failure is logged and reported in the return value.
 *
 * `sendEmail` is required lazily inside the send so the module-load graph stays
 * acyclic (emailHelper -> queue -> jobs/index -> emailHelper) and so a test can
 * substitute it.
 */

// How many tasks one batch-assignment email lists before it says "and N more".
const MAX_ROWS = Number(process.env.ASSIGNED_DIGEST_MAX_ROWS || 25);

const { primaryAppUrl } = require('./frontendUrl');

// FRONTEND_URL may list several allowed origins; a link needs exactly one.
const appUrl = () => primaryAppUrl();
const taskUrl = (id) => `${appUrl()}/tasks?task=${id}`;
const taskListUrl = () => `${appUrl()}/tasks`;

/**
 * Render an instant as wall-clock time in APP_TIMEZONE.
 * @param {Date|String|null} value
 * @returns {String}
 */
const formatWhen = (value) => {
  if (!value) return 'No deadline';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'No deadline';
  return date.toLocaleString('en-GB', {
    timeZone: getAppTimezone(),
    dateStyle: 'medium',
    timeStyle: 'short'
  });
};

/**
 * The supporting facts shown under a task title in a digest row.
 * @param {Object} task
 * @returns {String[]}
 */
const taskMeta = (task) =>
  [
    task.clientName ? `Client: ${task.clientName}` : null,
    task.priority ? `Priority: ${task.priority}` : null,
    `Due ${formatWhen(task.deadline)}`
  ].filter(Boolean);

/**
 * Resolve the display name of whoever performed the assignment.
 * @param {String|Object|null} actorId
 * @param {String|null} actorName
 * @returns {Promise<String>}
 */
const resolveActorName = async (actorId, actorName) => {
  if (actorName) return actorName;
  if (!actorId) return 'Your team';
  try {
    const User = require('../models/User');
    const actor = await User.findById(actorId).select('name').lean();
    return actor?.name || 'Your team';
  } catch {
    return 'Your team';
  }
};

/**
 * Queue the assignment email for one batch of tasks handed to one person.
 *
 * @param {Object} o
 * @param {Array<Object>} o.tasks - task documents or lean objects
 * @param {String|Object} o.assigneeId
 * @param {String|Object} [o.actorId] - who performed the assignment
 * @param {String} [o.actorName] - saves a lookup; resolved from actorId otherwise
 * @returns {Promise<{queued: Boolean, reason: String|null, count: Number}>}
 */
const sendTasksAssignedEmail = async ({ tasks, assigneeId, actorId = null, actorName = null }) => {
  const list = (tasks || []).filter(Boolean);
  try {
    if (!assigneeId) return { queued: false, reason: 'no-assignee', count: 0 };
    if (list.length === 0) return { queued: false, reason: 'no-tasks', count: 0 };

    // Rule 1. Self-assignment is noise, and for an Admin it is the common case.
    if (actorId && String(actorId) === String(assigneeId)) {
      return { queued: false, reason: 'self-assignment', count: list.length };
    }

    const User = require('../models/User');
    const assignee = await User.findOne({ _id: assigneeId, deletedAt: null })
      .select('name email')
      .lean();
    if (!assignee || !assignee.email) {
      return { queued: false, reason: 'no-recipient', count: list.length };
    }

    const assignedBy = await resolveActorName(actorId, actorName);
    const shown = list.slice(0, MAX_ROWS);

    const mail =
      list.length === 1
        ? taskAssigned({
            recipientName: assignee.name || 'there',
            taskTitle: list[0].title,
            assignedBy,
            deadline: formatWhen(list[0].deadline),
            priority: list[0].priority || 'Medium',
            clientName: list[0].clientName,
            taskUrl: taskUrl(list[0]._id)
          })
        : taskAssignedDigest({
            recipientName: assignee.name || 'there',
            assignedBy,
            tasks: shown.map((task) => ({
              title: task.title,
              meta: taskMeta(task),
              url: taskUrl(task._id)
            })),
            totalCount: list.length,
            listUrl: taskListUrl()
          });

    // `event` is what makes the recipient's preferences and quiet hours govern
    // this message; without it sendEmail treats it as transactional.
    const { sendEmail } = require('./emailHelper');
    const handle = await sendEmail(assignee.email, mail.subject, mail.text, mail.html, {
      event: 'task_assigned',
      userId: String(assigneeId)
    });

    // sendEmail returns null when the recipient has muted the event, when quiet
    // hours are in force, or when the queue refused the job. None of those are
    // failures of the caller's operation.
    if (!handle) return { queued: false, reason: 'suppressed', count: list.length };
    return { queued: true, reason: null, count: list.length };
  } catch (err) {
    logger.error(
      { err: err.message, assigneeId: String(assigneeId), tasks: list.length },
      'failed to queue task assignment email'
    );
    return { queued: false, reason: 'error', count: list.length };
  }
};

/**
 * Single-task convenience wrapper.
 *
 * @param {Object} o
 * @param {Object} o.task
 * @param {String|Object} o.assigneeId
 * @param {String|Object} [o.actorId]
 * @param {String} [o.actorName]
 * @returns {Promise<{queued: Boolean, reason: String|null, count: Number}>}
 */
const sendTaskAssignedEmail = ({ task, assigneeId, actorId = null, actorName = null }) =>
  sendTasksAssignedEmail({ tasks: [task], assigneeId, actorId, actorName });

module.exports = {
  sendTaskAssignedEmail,
  sendTasksAssignedEmail,
  // exported for the digest builder and for tests
  formatWhen,
  taskMeta,
  taskUrl,
  taskListUrl
};
