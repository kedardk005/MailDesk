const mongoose = require('mongoose');

const KeywordRuleSchema = new mongoose.Schema({
  keyword: {
    type: String,
    required: true,
    trim: true,
    uppercase: true
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  autoApprove: {
    type: Boolean,
    default: false // false requires Admin/Head approval modal
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('KeywordRule', KeywordRuleSchema);
