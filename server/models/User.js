const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['Admin', 'Head', 'Employee'],
    default: 'Employee',
    required: true
  },
  gmailAccessToken: {
    type: String,
    default: null
  },
  gmailRefreshToken: {
    type: String,
    default: null
  },
  gmailEmail: {
    type: String,
    default: ""
  },
  linkedGmailAccounts: {
    type: [
      {
        gmailEmail: { type: String, required: true },
        gmailAccessToken: { type: String, default: null },
        gmailRefreshToken: { type: String, default: null }
      }
    ],
    default: []
  },
  birthdate: {
    type: Date,
    default: null
  },
  phoneNumber: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Approved'
  },
  tokenVersion: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('User', UserSchema);
