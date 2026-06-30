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
  parentTaskId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Task',
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Task', TaskSchema);
