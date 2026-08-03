const mongoose = require('mongoose');

const ClientSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  associatedEmails: {
    type: [String],
    default: []
  },
  contactPerson: {
    type: String,
    default: ''
  },
  email: {
    type: String,
    default: ''
  },
  phone: {
    type: String,
    default: ''
  },
  notes: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Active', 'Inactive'],
    default: 'Active'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

ClientSchema.index({ createdAt: -1 });
ClientSchema.index({ status: 1, name: 1 });
// The sender -> client matcher looks up by address; keeping it indexed means a
// future direct lookup does not need the whole collection in memory.
ClientSchema.index({ associatedEmails: 1 });
ClientSchema.index({ email: 1 });

module.exports = mongoose.model('Client', ClientSchema);
