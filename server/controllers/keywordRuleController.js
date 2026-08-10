const KeywordRule = require('../models/KeywordRule');
const Email = require('../models/Email');
const User = require('../models/User');
const { logActivity } = require('../utils/activityLogger');
const { createNotification } = require('../utils/notificationHelper');
const { escapeRegex } = require('../utils/regexHelper');

const { sanitizeEmailDoc } = require('../utils/sanitizeEmailHtml');
const { ensureTaskForEmail, ensureTasksForEmails } = require('../utils/taskHelper');
const cache = require('../utils/cache');
const queue = require('../utils/queue');
const { parseListParams, paginate, listResponse } = require('../utils/paginate');
const { log } = require('../utils/logger');
// M-13: one error envelope, `{ message, errors: [{ path, message }] }`.
const { fieldError } = require('../utils/apiError');

const logger = log('keyword-rules');

const RULE_SORT_FIELDS = ['createdAt', 'keyword', 'isActive'];
const PENDING_SORT_FIELDS = ['date', 'subject', 'from', 'matchedKeyword'];

// Pending-approval rows are a LIST: never `body`. See API-LIST-CONTRACT.md.
const PENDING_EMAIL_FIELDS =
  'subject snippet from date status toEmail matchedKeyword suggestedAssignedTo approvalStatus fetchedBy attachments';

/**
 * Restrict a query on the Email collection to what the caller may see.
 * Admin sees the whole workspace; everyone else only their own mailbox.
 * @param {Object} user - req.user
 * @param {Object} base - base query
 * @returns {Object}
 */
const scopeEmailQuery = (user, base = {}) => {
  // F-1: replies we sent are persisted as Email rows now. Keyword routing acts
  // on RECEIVED mail only — without this guard a backfill could match our own
  // reply by subject and queue it for approval, or assign it to an employee.
  const scoped = { ...base, deletedAt: null, direction: { $ne: 'outbound' } };
  if (user.role !== 'Admin') {
    scoped.fetchedBy = user._id;
  }
  return scoped;
};

/**
 * A keyword rule may only be mutated by its creator or an Admin. `createdBy` was
 * stored but never enforced, so any Head could rewrite or delete the Admin's
 * routing rules.
 * @param {Object} rule
 * @param {Object} user - req.user
 * @returns {Boolean}
 */
const canMutateRule = (rule, user) =>
  user.role === 'Admin' || (rule.createdBy && rule.createdBy.toString() === user._id.toString());


// @desc    Get all keyword rules
// @route   GET /api/keyword-rules
// @access  Private (Admin, Head)
exports.getKeywordRules = async (req, res) => {
  try {
    const params = parseListParams(req, {
      sortWhitelist: RULE_SORT_FIELDS,
      defaultSort: '-createdAt',
      defaultLimit: 50
    });

    const filter = {};
    if (req.query.isActive === 'true') filter.isActive = true;
    if (req.query.isActive === 'false') filter.isActive = false;
    if (params.q) {
      filter.keyword = new RegExp(escapeRegex(params.q), 'i');
    }

    const { data, pagination } = await paginate(KeywordRule, filter, params, {
      select: 'keyword assignedTo createdBy autoApprove isActive createdAt',
      populate: [
        { path: 'assignedTo', select: 'name email role' },
        { path: 'createdBy', select: 'name email' }
      ]
    });

    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getKeywordRules failed');
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
      return fieldError(res, 400, 'Keyword and target assigned employee are required.', [
        { path: 'keyword', message: 'A keyword is required.' },
        { path: 'assignedTo', message: 'Choose who matching mail is assigned to.' }
      ]);
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
      return fieldError(res, 400, `A rule for keyword "${cleanKeyword}" already exists.`, ['keyword']);
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
      `Created keyword rule: "${cleanKeyword}" mapped to ${employee.name}`,
      {
        req,
        targetType: 'KeywordRule',
        targetId: rule._id,
        targetLabel: cleanKeyword,
        after: {
          keyword: cleanKeyword,
          assignedTo: String(assignedTo),
          assignedToName: employee.name,
          autoApprove: rule.autoApprove,
          isActive: rule.isActive
        }
      }
    );

    // The active-rule cache feeds the Gmail sync loop, so it must be dropped the
    // instant a rule changes.
    await cache.invalidateRules();

    // The retroactive scan is now a QUEUED JOB.
    //
    // It used to run inline inside this POST: an unanchored regex over the
    // `body` of every unassigned email (at 100k emails x ~60 KB that is ~6 GB
    // read off disk for ONE rule creation), followed by a `save()` and an
    // `ensureTaskForEmail` — each of which did its own `Client.find({})` — per
    // match. A multi-minute request.
    const backfill = await queue.enqueue(
      queue.QUEUES.KEYWORD_BACKFILL,
      {
        keyword: cleanKeyword,
        assignedTo: String(assignedTo),
        autoApprove: rule.autoApprove,
        actorId: String(req.user._id),
        actorRole: req.user.role
      },
      { attempts: 2, backoffMs: 5000 }
    );

    return res.status(201).json({
      rule,
      // Preserved for the existing client contract. The real number is not
      // known yet because the scan is asynchronous now; poll `backfillJobId`.
      matchedEmailCount: 0,
      backfillJobId: backfill.jobId,
      message: 'Rule created. Existing emails are being scanned in the background.'
    });
  } catch (error) {
    logger.error({ err: error.message }, 'createKeywordRule failed');
    return res.status(500).json({ message: 'Failed to create keyword rule.' });
  }
};

/**
 * The unit of work the `keyword-backfill` queue processes.
 *
 * Walks the unassigned backlog in bounded batches with an explicit projection
 * (never `body`), then writes with `bulkWrite` + one bulk task upsert.
 *
 * @param {Object} data
 * @param {Object} [context]
 * @returns {Promise<{keyword: String, matched: Number}>}
 */
exports.runKeywordBackfillJob = async (data, context) => {
  const { keyword, assignedTo, autoApprove, actorId, actorRole } = data;
  const searchRegex = new RegExp(escapeRegex(keyword), 'i');
  const batchSize = Number(process.env.KEYWORD_BACKFILL_BATCH || 200);
  const maxBatches = Number(process.env.KEYWORD_BACKFILL_MAX_BATCHES || 100);

  const scope = scopeEmailQuery({ _id: actorId, role: actorRole }, {
    status: 'unassigned',
    matchedKeyword: null,
    // Matching on `subject` only. Regexing `body` was the single most expensive
    // query in the application, and every body has already been matched against
    // the rule set at ingest.
    subject: searchRegex
  });

  let matched = 0;
  let lastId = null;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const filter = lastId ? { ...scope, _id: { $gt: lastId } } : scope;
    const emails = await Email.find(filter)
      .select('_id from subject snippet matchedKeyword fetchedBy')
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    if (emails.length === 0) break;
    lastId = emails[emails.length - 1]._id;

    const update = autoApprove
      ? { matchedKeyword: keyword, suggestedAssignedTo: assignedTo, assignedTo, status: 'assigned', approvalStatus: 'approved' }
      : { matchedKeyword: keyword, suggestedAssignedTo: assignedTo, approvalStatus: 'pending' };

    await Email.updateMany({ _id: { $in: emails.map((e) => e._id) } }, { $set: update });

    if (autoApprove) {
      await ensureTasksForEmails(
        emails.map((email) => ({ email, assignedUserId: assignedTo, createdById: actorId }))
      );
    }

    matched += emails.length;
    if (context?.updateProgress) await context.updateProgress(matched);
    if (emails.length < batchSize) break;
  }

  await cache.invalidateStats();
  // Runs on the keyword-backfill QUEUE WORKER, not in a request: there is no
  // `req`, so `ip`/`userAgent` stay null. That is the honest record — a
  // background job has no client address, and synthesising one would make the
  // audit trail lie. `targetId` is the keyword itself (targetId is a String
  // precisely so non-document targets like this can be recorded).
  await logActivity(actorId, 'Keyword Rule Backfill', `Flagged ${matched} existing email(s) for keyword "${keyword}"`, {
    targetType: 'KeywordRule',
    targetId: keyword,
    targetLabel: keyword
  });

  return { keyword, matched };
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

    // Only the rule's creator or an Admin may modify it.
    if (!canMutateRule(rule, req.user)) {
      return res.status(403).json({ message: 'Access denied. You can only modify keyword rules you created.' });
    }

    // Snapshot before the assignments below mutate the document.
    const beforeRule = {
      keyword: rule.keyword,
      assignedTo: rule.assignedTo ? String(rule.assignedTo) : null,
      autoApprove: rule.autoApprove,
      isActive: rule.isActive
    };

    if (assignedTo) {
      const employee = await User.findOne({ _id: assignedTo, deletedAt: null });
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

    await cache.invalidateRules();

    await logActivity(
      req.user._id,
      'Keyword Rule Update',
      `Updated rule for keyword: "${rule.keyword}"`,
      {
        req,
        targetType: 'KeywordRule',
        targetId: rule._id,
        targetLabel: rule.keyword,
        before: beforeRule,
        after: {
          keyword: rule.keyword,
          // `assignedTo` is populated by this point, so read the id off the doc.
          assignedTo: rule.assignedTo?._id ? String(rule.assignedTo._id) : null,
          autoApprove: rule.autoApprove,
          isActive: rule.isActive
        }
      }
    );

    return res.status(200).json(rule);
  } catch (error) {
    logger.error({ err: error.message }, 'updateKeywordRule failed');
    return res.status(500).json({ message: 'Failed to update keyword rule.' });
  }
};

// @desc    Delete a keyword rule
// @route   DELETE /api/keyword-rules/:id
// @access  Private (Admin, Head)
exports.deleteKeywordRule = async (req, res) => {
  try {
    // Load first so ownership can be checked BEFORE the delete happens.
    const rule = await KeywordRule.findById(req.params.id);
    if (!rule) {
      return res.status(404).json({ message: 'Keyword rule not found.' });
    }

    // Only the rule's creator or an Admin may delete it.
    if (!canMutateRule(rule, req.user)) {
      return res.status(403).json({ message: 'Access denied. You can only delete keyword rules you created.' });
    }

    await KeywordRule.findByIdAndDelete(req.params.id);
    await cache.invalidateRules();

    await logActivity(
      req.user._id,
      'Keyword Rule Delete',
      `Deleted keyword rule for "${rule.keyword}"`,
      {
        req,
        targetType: 'KeywordRule',
        targetId: rule._id,
        targetLabel: rule.keyword,
        before: {
          keyword: rule.keyword,
          assignedTo: rule.assignedTo ? String(rule.assignedTo) : null,
          autoApprove: rule.autoApprove,
          isActive: rule.isActive
        }
      }
    );

    return res.status(200).json({ message: `Keyword rule "${rule.keyword}" deleted successfully.` });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteKeywordRule failed');
    return res.status(500).json({ message: 'Failed to delete keyword rule.' });
  }
};

// @desc    Get emails pending keyword assignment approval
// @route   GET /api/keyword-rules/pending-approvals
// @access  Private (Admin, Head)
exports.getPendingApprovals = async (req, res) => {
  try {
    // Scoped to the caller's mailbox. This endpoint previously returned EVERY
    // pending email in the workspace — full documents including `body` — to any
    // Head, which was both a direct data breach and the id oracle that made the
    // other email IDORs practical.
    const params = parseListParams(req, {
      sortWhitelist: PENDING_SORT_FIELDS,
      defaultSort: '-date'
    });

    const filter = scopeEmailQuery(req.user, { approvalStatus: 'pending' });
    if (params.q) {
      const regex = new RegExp(escapeRegex(params.q), 'i');
      filter.$and = [{ $or: [{ subject: regex }, { from: regex }] }];
    }

    const { data, pagination } = await paginate(Email, filter, params, {
      // This endpoint used to return FULL documents including `body`.
      select: PENDING_EMAIL_FIELDS,
      populate: [
        { path: 'suggestedAssignedTo', select: 'name email role' },
        { path: 'fetchedBy', select: 'name email' }
      ]
    });

    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getPendingApprovals failed');
    return res.status(500).json({ message: 'Failed to fetch pending keyword approvals.' });
  }
};

// @desc    Approve or reassign a single keyword-matched email
// @route   POST /api/keyword-rules/approve-email/:id
// @access  Private (Admin, Head)
exports.approveEmailAssignment = async (req, res) => {
  try {
    const { targetUserId } = req.body;

    // Scoped: a Head could previously approve/reassign ANY email by id.
    // Projection: this handler needs six fields, not a base64-laden body.
    // `status`, `approvalStatus` and `assignedTo` are selected so the audit
    // entry can record the state this approval replaced. The response shape is
    // unchanged: all three are assigned onto `email` unconditionally below, so
    // they were already present on the returned object.
    const email = await Email.findOne(scopeEmailQuery(req.user, { _id: req.params.id }))
      .select('_id subject snippet from matchedKeyword suggestedAssignedTo fetchedBy status approvalStatus assignedTo')
      .lean();

    if (!email) {
      return res.status(404).json({ message: 'Email not found.' });
    }

    // Captured before the local mutations below overwrite the lean copy.
    const beforeEmail = {
      status: email.status,
      approvalStatus: email.approvalStatus,
      assignedTo: email.assignedTo ? String(email.assignedTo) : null
    };

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
      return fieldError(res, 400, 'Target assigned user ID is required.', ['targetUserId']);
    }

    const employee = await User.findOne({ _id: assignedUserId, deletedAt: null }).select('name').lean();
    if (!employee) {
      return res.status(404).json({ message: 'Target assigned user not found.' });
    }

    await Email.updateOne(
      { _id: email._id },
      { $set: { assignedTo: assignedUserId, status: 'assigned', approvalStatus: 'approved' } }
    );
    email.assignedTo = assignedUserId;
    email.status = 'assigned';
    email.approvalStatus = 'approved';

    // Create / link Task for TaskList module (atomic upsert)
    // Capture the task: this is the single-email path, so the notification can
    // deep-link straight to the work item. It previously passed taskId: null
    // despite having just created the task, leaving the bell entry with
    // nowhere to go.
    const linkedTask = await ensureTaskForEmail(email, assignedUserId, req.user._id);
    await cache.invalidateStats();

    const io = req.app.get('io');
    await createNotification(
      employee._id,
      `Mail assigned to you (Keyword: ${email.matchedKeyword || 'Auto'}): "${email.subject}"`,
      io,
      linkedTask?._id || null,
      'email_assigned'
    );

    await logActivity(
      req.user._id,
      'Keyword Mail Approved',
      `Approved assignment of email "${email.subject}" to ${employee.name}`,
      {
        req,
        targetType: 'Email',
        targetId: email._id,
        targetLabel: email.subject,
        before: beforeEmail,
        after: {
          status: 'assigned',
          approvalStatus: 'approved',
          assignedTo: String(assignedUserId),
          assignedToName: employee.name
        }
      }
    );

    return res.status(200).json({
      message: `Email assigned to ${employee.name} successfully.`,
      email
    });
  } catch (error) {
    logger.error({ err: error.message }, 'approveEmailAssignment failed');
    return res.status(500).json({ message: 'Failed to approve email assignment.' });
  }
};

// @desc    Bulk approve all pending emails for a keyword or all pending emails
// @route   POST /api/keyword-rules/bulk-approve
// @access  Private (Admin, Head)
exports.bulkApproveEmails = async (req, res) => {
  try {
    const { keyword, targetUserId } = req.body;

    // An explicit keyword is REQUIRED (enforced by bulkApproveSchema, re-checked
    // here). Without it, `POST /bulk-approve {"targetUserId":"<attacker>"}`
    // swept every pending email in the company into the attacker's queue.
    if (!keyword || !keyword.trim()) {
      return fieldError(res, 400, 'A keyword is required for bulk approval.', ['keyword']);
    }

    const query = scopeEmailQuery(req.user, {
      approvalStatus: 'pending',
      matchedKeyword: keyword.trim().toUpperCase()
    });

    // Bounded, projected, lean. This used to load every matching FULL document
    // (bodies included) and then run three sequential writes per email:
    // save() + ensureTaskForEmail() (which itself did a Client.find({})) +
    // createNotification(). At 500 pending emails that is 1500 round-trips.
    const pendingEmails = await Email.find(query)
      .select('_id subject snippet from matchedKeyword suggestedAssignedTo fetchedBy')
      .limit(Number(process.env.BULK_APPROVE_MAX || 500))
      .lean();

    if (pendingEmails.length === 0) {
      return res.status(200).json({ message: 'No pending emails found to approve.', count: 0 });
    }

    const io = req.app.get('io');

    const resolveAssignee = (email) => {
      let id = targetUserId;
      if (typeof id === 'object' && id !== null && id._id) id = id._id;
      if (!id && email.suggestedAssignedTo) {
        id =
          typeof email.suggestedAssignedTo === 'object' && email.suggestedAssignedTo._id
            ? email.suggestedAssignedTo._id
            : email.suggestedAssignedTo;
      }
      return id || null;
    };

    const resolved = pendingEmails
      .map((email) => ({ email, assignedUserId: resolveAssignee(email), createdById: req.user._id }))
      .filter((entry) => entry.assignedUserId);

    const approvedCount = resolved.length;

    if (approvedCount > 0) {
      // 1. One grouped updateMany per assignee.
      const byAssignee = new Map();
      for (const entry of resolved) {
        const key = String(entry.assignedUserId);
        if (!byAssignee.has(key)) byAssignee.set(key, []);
        byAssignee.get(key).push(entry.email._id);
      }

      await Promise.all(
        [...byAssignee.entries()].map(([assigneeId, ids]) =>
          Email.updateMany(
            { _id: { $in: ids } },
            { $set: { assignedTo: assigneeId, status: 'assigned', approvalStatus: 'approved' } }
          )
        )
      );

      // 2. One bulkWrite for every task.
      await ensureTasksForEmails(resolved);

      // 3. ONE digest notification per assignee instead of one per email.
      await Promise.all(
        [...byAssignee.entries()].map(([assigneeId, ids]) =>
          createNotification(
            assigneeId,
            ids.length === 1
              ? `Mail assigned to you (${keyword.trim().toUpperCase()}).`
              : `${ids.length} mails assigned to you (${keyword.trim().toUpperCase()}).`,
            io,
            null,
            'email_assigned'
          )
        )
      );

      await cache.invalidateStats();
    }

    // N emails, so no single honest `targetId`; the keyword is what scoped the
    // sweep and is recorded as the label.
    await logActivity(
      req.user._id,
      'Keyword Mail Bulk Approved',
      `Approved ${approvedCount} email assignment(s) for keyword: ${keyword || 'All'}`,
      {
        req,
        targetType: 'Email',
        targetLabel: `${approvedCount} email(s) matching "${keyword.trim().toUpperCase()}"`,
        before: { approvalStatus: 'pending', emailCount: approvedCount },
        after: { approvalStatus: 'approved', status: 'assigned', emailCount: approvedCount }
      }
    );

    return res.status(200).json({
      message: `Successfully approved and assigned ${approvedCount} email(s).`,
      count: approvedCount
    });
  } catch (error) {
    logger.error({ err: error.message }, 'bulkApproveEmails failed');
    return res.status(500).json({ message: 'Failed to bulk approve emails.' });
  }
};
