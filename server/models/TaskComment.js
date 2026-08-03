const mongoose = require('mongoose');

const TaskCommentSchema = new mongoose.Schema({
  taskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    required: true,
    index: true
  },
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  message: {
    type: String,
    required: true,
    trim: true,
    maxlength: 1000
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Comments are listed oldest-first for one task; without the compound the sort
// is not covered by the single `taskId` index.
TaskCommentSchema.index({ taskId: 1, createdAt: 1 });
TaskCommentSchema.index({ author: 1 });

module.exports = mongoose.model('TaskComment', TaskCommentSchema);
