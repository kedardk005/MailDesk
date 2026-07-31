const KeywordRule = require('../models/KeywordRule');
const Email = require('../models/Email');
const User = require('../models/User');
const { logActivity } = require('../utils/activityLogger');
const { createNotification } = require('../utils/notificationHelper');
const { escapeRegex } = require('../utils/regexHelper');
const { ensureTaskForEmail } = require('../utils/taskHelper');


// @desc    Get all keyword rules
// @route   GET /api/keyword-rules
// @access  Private (Admin, Head)
exports.getKeywordRules = async (req, res) => {
  try {
    const rules = await KeywordRule.find()
      .populate('assignedTo', 'name email role')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    return res.status(200).json(rules);
  } catch (error) {
    console.error('Error fetching keyword rules:', error);
    return res.status(500).json({ message: 'Failed to retrieve keyword rules.' });
  }
};

// @desc    Create a new keyword rule
// @route   POST /api/keyword-rules
// @access  Private (Admin, Head)
exports.createKeywordRule = async (req, res) => {
  try {
    const { keyword, assignedTo, autoApprove } = req.body;

    if (!keyword || !keyword.trim() || !assignedTo) {
      return res.status(400).json({ message: 'Keyword and target assigned employee are required.' });
    }

    const cleanKeyword = keyword.trim().toUpperCase();

    // Check if target user exists
    const employee = await User.findById(assignedTo);
    if (!employee) {
      return res.status(404).json({ message: 'Assigned employee user not found.' });
    }

    // Check if rule for this keyword already exists
    const existingRule = await KeywordRule.findOne({ keyword: cleanKeyword });
    if (existingRule) {
      return res.status(400).json({ message: `A rule for keyword "${cleanKeyword}" already exists.` });
    }

    const rule = new KeywordRule({
      keyword: cleanKeyword,
      assignedTo,
      createdBy: req.user._id,
      autoApprove: !!autoApprove,
      isActive: true
    });

    await rule.save();
    await rule.populate('assignedTo', 'name email role');
    await rule.populate('createdBy', 'name email');

    await logActivity(
      req.user._id,
      'Keyword Rule Creation',
      `Created keyword rule: "${cleanKeyword}" mapped to ${employee.name}`
    );

    // Scan existing unassigned emails to retroactively flag matches for approval
    const searchRegex = new RegExp(escapeRegex(cleanKeyword), 'i');
    const matchingEmails = await Email.find({
      status: 'unassigned',
      $or: [{ subject: searchRegex }, { body: searchRegex }]
    });

    let updatedCount = 0;
    for (const email of matchingEmails) {
      if (!email.matchedKeyword) {
        email.matchedKeyword = cleanKeyword;
        email.suggestedAssignedTo = assignedTo;
        if (rule.autoApprove) {
          email.assignedTo = assignedTo;
          email.status = 'assigned';
          email.approvalStatus = 'approved';
          await ensureTaskForEmail(email, assignedTo, req.user._id);
        } else {
          email.approvalStatus = 'pending';
        }
        await email.save();
        updatedCount++;
      }
    }

    return res.status(201).json({
      rule,
      matchedEmailCount: updatedCount,
      message: `Rule created. ${updatedCount} existing email(s) flagged for auto-assignment/approval.`
    });
  } catch (error) {
    console.error('Error creating keyword rule:', error);
    return res.status(500).json({ message: 'Failed to create keyword rule.' });
  }
};

// @desc    Update an existing keyword rule
// @route   PUT /api/keyword-rules/:id
// @access  Private (Admin, Head)
exports.updateKeywordRule = async (req, res) => {
  try {
    const { assignedTo, autoApprove, isActive } = req.body;
    const rule = await KeywordRule.findById(req.params.id);

    if (!rule) {
      return res.status(404).json({ message: 'Keyword rule not found.' });
    }

    if (assignedTo) {
      const employee = await User.findById(assignedTo);
      if (!employee) {
        return res.status(404).json({ message: 'Target assigned employee not found.' });
      }
      rule.assignedTo = assignedTo;
    }

    if (autoApprove !== undefined) rule.autoApprove = !!autoApprove;
    if (isActive !== undefined) rule.isActive = !!isActive;

    await rule.save();
    await rule.populate('assignedTo', 'name email role');
    await rule.populate('createdBy', 'name email');

    await logActivity(
      req.user._id,
      'Keyword Rule Update',
      `Updated rule for keyword: "${rule.keyword}"`
    );

    return res.status(200).json(rule);
  } catch (error) {
    console.error('Error updating keyword rule:', error);
    return res.status(500).json({ message: 'Failed to update keyword rule.' });
  }
};

// @desc    Delete a keyword rule
// @route   DELETE /api/keyword-rules/:id
// @access  Private (Admin, Head)
exports.deleteKeywordRule = async (req, res) => {
  try {
    const rule = await KeywordRule.findByIdAndDelete(req.params.id);
    if (!rule) {
      return res.status(404).json({ message: 'Keyword rule not found.' });
    }

    await logActivity(
      req.user._id,
      'Keyword Rule Delete',
      `Deleted keyword rule for "${rule.keyword}"`
    );

    return res.status(200).json({ message: `Keyword rule "${rule.keyword}" deleted successfully.` });
  } catch (error) {
    console.error('Error deleting keyword rule:', error);
    return res.status(500).json({ message: 'Failed to delete keyword rule.' });
  }
};

// @desc    Get emails pending keyword assignment approval
// @route   GET /api/keyword-rules/pending-approvals
// @access  Private (Admin, Head)
exports.getPendingApprovals = async (req, res) => {
  try {
    const pendingEmails = await Email.find({ approvalStatus: 'pending' })
      .populate('suggestedAssignedTo', 'name email role')
      .populate('fetchedBy', 'name email')
      .sort({ date: -1 });

    return res.status(200).json(pendingEmails);
  } catch (error) {
    console.error('Error fetching pending keyword approvals:', error);
    return res.status(500).json({ message: 'Failed to fetch pending keyword approvals.' });
  }
};

// @desc    Approve or reassign a single keyword-matched email
// @route   POST /api/keyword-rules/approve-email/:id
// @access  Private (Admin, Head)
exports.approveEmailAssignment = async (req, res) => {
  try {
    const { targetUserId } = req.body;
    const email = await Email.findById(req.params.id);

    if (!email) {
      return res.status(404).json({ message: 'Email not found.' });
    }

    let assignedUserId = targetUserId;
    if (typeof assignedUserId === 'object' && assignedUserId !== null && assignedUserId._id) {
      assignedUserId = assignedUserId._id;
    }
    if (!assignedUserId && email.suggestedAssignedTo) {
      assignedUserId = typeof email.suggestedAssignedTo === 'object' && email.suggestedAssignedTo._id
        ? email.suggestedAssignedTo._id
        : email.suggestedAssignedTo;
    }

    if (!assignedUserId) {
      return res.status(400).json({ message: 'Target assigned user ID is required.' });
    }

    const employee = await User.findById(assignedUserId);
    if (!employee) {
      return res.status(404).json({ message: 'Target assigned user not found.' });
    }

    email.assignedTo = assignedUserId;
    email.status = 'assigned';
    email.approvalStatus = 'approved';
    await email.save();

    // Create / link Task for TaskList module
    await ensureTaskForEmail(email, assignedUserId, req.user._id);

    const io = req.app.get('io');
    await createNotification(
      employee._id,
      `Mail assigned to you (Keyword: ${email.matchedKeyword || 'Auto'}): "${email.subject}"`,
      io
    );

    await logActivity(
      req.user._id,
      'Keyword Mail Approved',
      `Approved assignment of email "${email.subject}" to ${employee.name}`
    );

    return res.status(200).json({
      message: `Email assigned to ${employee.name} successfully.`,
      email
    });
  } catch (error) {
    console.error('Error approving email assignment:', error);
    return res.status(500).json({ message: 'Failed to approve email assignment.' });
  }
};

// @desc    Bulk approve all pending emails for a keyword or all pending emails
// @route   POST /api/keyword-rules/bulk-approve
// @access  Private (Admin, Head)
exports.bulkApproveEmails = async (req, res) => {
  try {
    const { keyword, targetUserId } = req.body;

    let query = { approvalStatus: 'pending' };
    if (keyword) {
      query.matchedKeyword = keyword.toUpperCase();
    }

    const pendingEmails = await Email.find(query);
    if (pendingEmails.length === 0) {
      return res.status(200).json({ message: 'No pending emails found to approve.', count: 0 });
    }

    let approvedCount = 0;
    const io = req.app.get('io');

    for (const email of pendingEmails) {
      let finalUserId = targetUserId;
      if (typeof finalUserId === 'object' && finalUserId !== null && finalUserId._id) {
        finalUserId = finalUserId._id;
      }
      if (!finalUserId && email.suggestedAssignedTo) {
        finalUserId = typeof email.suggestedAssignedTo === 'object' && email.suggestedAssignedTo._id
          ? email.suggestedAssignedTo._id
          : email.suggestedAssignedTo;
      }

      if (finalUserId) {
        email.assignedTo = finalUserId;
        email.status = 'assigned';
        email.approvalStatus = 'approved';
        await email.save();

        // Create / link Task for TaskList module
        await ensureTaskForEmail(email, finalUserId, req.user._id);
        approvedCount++;

        await createNotification(
          finalUserId,
          `Mail assigned to you (${email.matchedKeyword || 'Keyword'}): "${email.subject}"`,
          io
        );
      }
    }

    await logActivity(
      req.user._id,
      'Keyword Mail Bulk Approved',
      `Approved ${approvedCount} email assignment(s) for keyword: ${keyword || 'All'}`
    );

    return res.status(200).json({
      message: `Successfully approved and assigned ${approvedCount} email(s).`,
      count: approvedCount
    });
  } catch (error) {
    console.error('Error bulk approving emails:', error);
    return res.status(500).json({ message: 'Failed to bulk approve emails.' });
  }
};
