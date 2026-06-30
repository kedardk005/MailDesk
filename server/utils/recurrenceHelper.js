const Task = require('../models/Task');
const { createNotification } = require('./notificationHelper');

const getNextDeadline = (currentDeadline, recurrence) => {
  const base = currentDeadline ? new Date(currentDeadline) : new Date();
  const next = new Date(base);
  if (recurrence === 'Daily') next.setDate(next.getDate() + 1);
  else if (recurrence === 'Weekly') next.setDate(next.getDate() + 7);
  else if (recurrence === 'Monthly') next.setMonth(next.getMonth() + 1);
  return next;
};

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
    console.log(`[RECURRENCE] Spawned next task "${saved.title}" due ${nextDeadline.toLocaleDateString()}`);

    // Notify the assignee
    if (completedTask.assignedTo) {
      await createNotification(
        completedTask.assignedTo,
        `Recurring task renewed: "${completedTask.title}" — next due ${nextDeadline.toLocaleDateString()}`,
        io
      );
    }

    return saved;
  } catch (err) {
    console.error('[RECURRENCE ERROR]', err.message);
  }
};

module.exports = { spawnNextRecurrence, getNextDeadline };
