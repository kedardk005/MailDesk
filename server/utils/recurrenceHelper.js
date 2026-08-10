const Task = require('../models/Task');
const { createNotification } = require('./notificationHelper');
const { log } = require('./logger');

const logger = log('recurrence');

/**
 * Next deadline for a recurring task.
 *
 * `setMonth(getMonth() + 1)` OVERFLOWS: for a task due 31 January it produces
 * 3 March, because 31 February does not exist and JavaScript rolls it forward.
 * The day is now clamped to the last day of the target month, so 31 Jan -> 28
 * (or 29) Feb, which is what "monthly" means to a user.
 *
 * @param {Date|String|null} currentDeadline
 * @param {String} recurrence - 'Daily' | 'Weekly' | 'Monthly'
 * @returns {Date}
 */
const getNextDeadline = (currentDeadline, recurrence) => {
  const base = currentDeadline ? new Date(currentDeadline) : new Date();
  const next = new Date(base);

  if (recurrence === 'Daily') {
    next.setDate(next.getDate() + 1);
  } else if (recurrence === 'Weekly') {
    next.setDate(next.getDate() + 7);
  } else if (recurrence === 'Monthly') {
    const day = next.getDate();
    // Move to the 1st first so the day-of-month cannot overflow the addition.
    next.setDate(1);
    next.setMonth(next.getMonth() + 1);
    // Day 0 of the FOLLOWING month is the last day of the target month.
    const lastDayOfTarget = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDayOfTarget));
  }

  return next;
};

/**
 * Spawn the next occurrence of a completed recurring task.
 *
 * MUST be called only after the completion has been persisted and the caller
 * has won the `recurrenceSpawnedAt` claim (see taskController). Previously this
 * ran BEFORE `task.save()`, so a failed save left an orphan child, and two
 * concurrent completions both passed the `status !== 'Completed'` check and
 * each spawned one.
 *
 * @param {Object} completedTask
 * @param {Object} io - socket.io server
 * @returns {Promise<Object|undefined>}
 */
const spawnNextRecurrence = async (completedTask, io) => {
  try {
    if (!completedTask.isRecurring || !completedTask.recurrence) return;

    const nextDeadline = getNextDeadline(completedTask.deadline, completedTask.recurrence);

    const newTask = new Task({
      title: completedTask.title,
      description: completedTask.description,
      assignedTo: completedTask.assignedTo,
      clientName: completedTask.clientName,
      notes: completedTask.notes,
      deadline: nextDeadline,
      status: 'Pending',
      createdBy: completedTask.createdBy,
      isRecurring: true,
      recurrence: completedTask.recurrence,
      parentTaskId: completedTask.parentTaskId || completedTask._id,
      linkedEmail: null  // Do not carry over email link
    });

    const saved = await newTask.save();
    logger.info({ taskId: String(saved._id), parentId: String(completedTask._id), nextDeadline },
      'spawned next recurrence');

    // Notify the assignee
    if (completedTask.assignedTo) {
      await createNotification(
        completedTask.assignedTo,
        `Recurring task renewed: "${completedTask.title}" — next due ${nextDeadline.toLocaleDateString()}`,
        io,
        saved._id,
        'task_assigned'
      );

      // The email half of the same event. A renewal really is a new task with a
      // new deadline, and the in-app row above is already typed `task_assigned`,
      // so mailing here is what keeps the Profile toggle honest across both
      // channels. There is no acting user on an automatic renewal, so the
      // task's CREATOR is the assigner — which also means someone who set up a
      // recurring task for themselves is never mailed about it.
      try {
        const { sendTaskAssignedEmail } = require('./taskMailer');
        await sendTaskAssignedEmail({
          task: saved,
          assigneeId: completedTask.assignedTo,
          actorId: completedTask.createdBy
        });
      } catch (err) {
        logger.error({ err: err.message, taskId: String(saved._id) }, 'failed to queue recurrence assignment email');
      }
    }

    return saved;
  } catch (err) {
    logger.error({ err: err.message, taskId: String(completedTask?._id) }, 'failed to spawn next recurrence');
  }
};

module.exports = { spawnNextRecurrence, getNextDeadline };
