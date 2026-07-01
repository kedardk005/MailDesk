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
  fetchedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  fetchedAt: {
    type: Date,
    default: Date.now
  },
  labelIds: {
    type: [String],
    default: []
  },
  toEmail: {
    type: String,
    default: ''
  },
  attachments: [
    {
      attachmentId: { type: String, required: true },
      filename: { type: String, required: true },
      mimeType: { type: String, default: '' },
      size: { type: Number, default: 0 }
    }
  ]
});

module.exports = mongoose.model('Email', EmailSchema);
