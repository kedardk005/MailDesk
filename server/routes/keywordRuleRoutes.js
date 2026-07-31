const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  getKeywordRules,
  createKeywordRule,
  updateKeywordRule,
  deleteKeywordRule,
  getPendingApprovals,
  approveEmailAssignment,
  bulkApproveEmails
} = require('../controllers/keywordRuleController');

// All keyword rule routes are protected for Admin and Head
router.use(protect);
router.use(authorizeRoles('Admin', 'Head'));

router.route('/')
  .get(getKeywordRules)
  .post(createKeywordRule);

router.route('/pending-approvals')
  .get(getPendingApprovals);

router.route('/approve-email/:id')
  .post(approveEmailAssignment);

router.route('/bulk-approve')
  .post(bulkApproveEmails);

router.route('/:id')
  .put(updateKeywordRule)
  .delete(deleteKeywordRule);

module.exports = router;
