const mongoose = require('mongoose');

const TaskSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },
  linkedEmail: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Email',
    default: null
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  clientName: {
    type: String,
    default: ''
  },
  deadline: {
    type: Date,
    default: null
  },
  status: {
    type: String,
    enum: ['Pending', 'Completed', 'Late'],
    default: 'Pending'
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  priority: {
    type: String,
    enum: ['Low', 'Medium', 'High', 'Urgent'],
    default: 'Medium'
  },
  isRecurring: {
    type: Boolean,
    default: false
  },
  recurrence: {
    type: String,
    enum: ['Daily', 'Weekly', 'Monthly', null],
    default: null
  },
  // Set the first time the overdue cron notifies about this task, so the
  // every-minute job cannot re-notify the assignee and every supervisor forever.
  // Cleared whenever the deadline moves or the task leaves the Late state.
  overdueNotifiedAt: {
    type: Date,
    default: null
  },
  parentTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },
  // Set exactly once, by whichever request wins the atomic claim, when a
  // recurring task is completed. Two concurrent completions previously both
  // passed the `status !== 'Completed'` check and each spawned a child.
  recurrenceSpawnedAt: {
    type: Date,
    default: null
  },
  // ---------------------------------------------------------------------
  // F-2 SLA analytics
  // ---------------------------------------------------------------------
  // Set on the transition INTO `Completed`, cleared on the transition out of
  // it. Before this field existed the completion instant was simply not
  // recorded anywhere, which is why resolution time was uncomputable.
  //
  // Historical rows are backfilled (best effort) by
  // scripts/backfillTaskCompletedAt.js; where no defensible timestamp exists it
  // stays null and the task is excluded from resolution metrics rather than
  // given an invented one.
  completedAt: {
    type: Date,
    default: null
  },
  // When the first outbound reply went out on the thread this task is linked
  // to. Written by replyToEmail; null for tasks with no linked email, or whose
  // thread has never been answered.
  firstResponseAt: {
    type: Date,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

TaskSchema.index({ assignedTo: 1 });
TaskSchema.index({ createdBy: 1 });
TaskSchema.index({ status: 1 });
TaskSchema.index({ deadline: 1 });
TaskSchema.index({ status: 1, deadline: 1 });
TaskSchema.index({ createdAt: -1 });
TaskSchema.index({ clientName: 1 });
TaskSchema.index({ parentTaskId: 1 });

// Compound (filter + sort) indexes matching the real query shapes.
TaskSchema.index({ assignedTo: 1, createdAt: -1 });
TaskSchema.index({ createdBy: 1, createdAt: -1 });
TaskSchema.index({ assignedTo: 1, status: 1, deadline: -1 });
TaskSchema.index({ clientName: 1, status: 1 });
// The overdue cron scans exactly this shape every minute.
TaskSchema.index({ status: 1, overdueNotifiedAt: 1, deadline: 1 });

// F-2: the resolution-time pipeline matches Completed tasks by `completedAt`
// window, optionally narrowed to one creator (a Head's scope), and only ever
// looks at tasks that carry a linked email.
TaskSchema.index({ completedAt: -1 });
TaskSchema.index({ status: 1, completedAt: -1 });
TaskSchema.index({ createdBy: 1, completedAt: -1 });
TaskSchema.index({ firstResponseAt: 1 });

// One Task per linked Email, enforced by the database.
//
// `ensureTaskForEmail` used to do a check-then-act (`findOne` then `save`),
// which two concurrent syncs — or two replicas running the same cron tick —
// both passed, producing duplicate tasks for one email.
//
// A `sparse` index would NOT work here: `linkedEmail` defaults to `null`, and
// sparse only skips documents where the field is ABSENT, so every standalone
// task would collide on null. The partial filter restricts uniqueness to
// documents that actually reference an email.
TaskSchema.index(
  { linkedEmail: 1 },
  { unique: true, partialFilterExpression: { linkedEmail: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Task', TaskSchema);
