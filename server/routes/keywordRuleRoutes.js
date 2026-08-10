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
const validate = require('../middleware/validate');
const { bulkApproveSchema, updateKeywordRuleSchema } = require('../middleware/schemas');
const { guardObjectIdParams } = require('../middleware/objectIdParam');

// All keyword rule routes are protected for Admin and Head
router.use(protect);
router.use(authorizeRoles('Admin', 'Head'));

// H-10: covers both '/:id' and '/approve-email/:id'.
guardObjectIdParams(router, 'keyword rule', ['id']);

router.route('/')
  .get(getKeywordRules)
  .post(createKeywordRule);

router.route('/pending-approvals')
  .get(getPendingApprovals);

router.route('/approve-email/:id')
  .post(approveEmailAssignment);

// `keyword` is mandatory here — see bulkApproveSchema.
router.route('/bulk-approve')
  .post(validate(bulkApproveSchema), bulkApproveEmails);

// PUT is authorized against rule.createdBy (or Admin) in the controller.
router.route('/:id')
  .put(validate(updateKeywordRuleSchema), updateKeywordRule)
  .delete(deleteKeywordRule);

module.exports = router;
