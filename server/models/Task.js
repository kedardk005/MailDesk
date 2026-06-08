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
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Task', TaskSchema);
