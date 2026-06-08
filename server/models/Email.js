const mongoose = require('mongoose');

const EmailSchema = new mongoose.Schema({
  messageId: {
    type: String,
    required: true,
    unique: true
  },
  subject: {
    type: String,
    default: ''
  },
  body: {
    type: String,
    default: ''
  },
  from: {
    type: String,
    required: true
  },
  date: {
    type: Date
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  status: {
    type: String,
    enum: ['unassigned', 'assigned'],
    default: 'unassigned'
  },
  fetchedAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Email', EmailSchema);
