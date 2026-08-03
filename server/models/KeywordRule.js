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

// `{ isActive: true }` used to be queried once per Gmail message — 150 times
// per account per sync — against an unindexed field. It is now hoisted, cached
// (`rules:active`) AND indexed.
KeywordRuleSchema.index({ isActive: 1 });
// Deliberately NOT unique: an existing workspace may already hold duplicate
// keywords, and a unique index would fail to build on that data. Uniqueness is
// enforced in createKeywordRule.
KeywordRuleSchema.index({ keyword: 1 });
KeywordRuleSchema.index({ isActive: 1, keyword: 1 });
KeywordRuleSchema.index({ createdAt: -1 });
KeywordRuleSchema.index({ createdBy: 1 });
KeywordRuleSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('KeywordRule', KeywordRuleSchema);
