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
  ],
  matchedKeyword: {
    type: String,
    default: null
  },
  suggestedAssignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  approvalStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none'
  }
});

EmailSchema.index({ fetchedBy: 1 });
EmailSchema.index({ assignedTo: 1 });
EmailSchema.index({ status: 1 });
EmailSchema.index({ toEmail: 1 });
EmailSchema.index({ date: -1 });
EmailSchema.index({ approvalStatus: 1 });

module.exports = mongoose.model('Email', EmailSchema);
