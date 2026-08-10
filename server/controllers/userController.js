const User = require('../models/User');
const bcrypt = require('bcryptjs');
const ActivityLog = require('../models/ActivityLog');
const Task = require('../models/Task');
const Email = require('../models/Email');
const Notification = require('../models/Notification');
const KeywordRule = require('../models/KeywordRule');
const { logActivity } = require('../utils/activityLogger');
const { generateToken } = require('../utils/tokenService');
const notificationPrefs = require('../utils/notificationPrefs');
const cache = require('../utils/cache');
const { escapeRegex } = require('../utils/regexHelper');
const { parseListParams, paginate, listResponse, firstString } = require('../utils/paginate');
const { log } = require('../utils/logger');

const logger = log('users');

// Sortable fields per docs/audits/API-LIST-CONTRACT.md.
// `lastLoginAt` added for WAVE2 gap S-4; it is indexed as
// {deletedAt, lastLoginAt} so the sort is not an in-memory one.
const USER_SORT_FIELDS = ['createdAt', 'name', 'email', 'role', 'status', 'lastLoginAt'];
const ACTIVITY_SORT_FIELDS = ['createdAt', 'action'];

// Explicit projection. `-password` alone still shipped every field the list
// view never renders.
//
// `+linkedGmailAccounts` is `select: false` on the schema and is pulled in ONLY
// to compute `connectedAccountCount` (S-4). It is stripped from every response
// by `withAccountCount()` below — it holds OAuth refresh tokens and must never
// reach a client.
const USER_LIST_FIELDS =
  'name email role status createdAt lastLoginAt birthdate phoneNumber gmailEmail maxConnectedAccounts allowedGmailAccounts';
const USER_LIST_SELECT = `${USER_LIST_FIELDS} +linkedGmailAccounts`;

/**
 * Replace the (secret-bearing) `linkedGmailAccounts` array with a count.
 *
 * WAVE2 gap S-4: the admin list previously inferred "connected Gmail accounts"
 * from `gmailEmail` alone, so a Head with three linked mailboxes read as one.
 *
 * @param {Object} user - a LEAN user object
 * @returns {Object} the same object without `linkedGmailAccounts`, plus counts
 */
const withAccountCount = (user) => {
  if (!user) return user;
  const linked = Array.isArray(user.linkedGmailAccounts) ? user.linkedGmailAccounts : [];
  const linkedEmails = linked.map((a) => a?.gmailEmail).filter(Boolean);
  const primary = user.gmailEmail ? [user.gmailEmail] : [];
  // De-duplicated: the primary mailbox is sometimes also present in the linked
  // array, and counting it twice is exactly the bug this replaces.
  const unique = new Set([...primary, ...linkedEmails]);

  const { linkedGmailAccounts, ...rest } = user;
  return {
    ...rest,
    connectedAccountCount: unique.size,
    // Addresses only — never tokens. Lets the admin page name the mailboxes.
    connectedAccountEmails: [...unique]
  };
};

// Structured audit fields returned by GET /api/users/activity-logs (S-2).
const ACTIVITY_LOG_FIELDS =
  'userId action details createdAt ip userAgent targetType targetId targetLabel before after';

// @desc    Get all users
// @route   GET /api/users
// @access  Private/Admin
exports.getAllUsers = async (req, res) => {
  try {
    const params = parseListParams(req, {
      sortWhitelist: USER_SORT_FIELDS,
      defaultSort: '-createdAt'
    });

    const filter = { deletedAt: null };

    const role = firstString(req.query.role, 20);
    if (['Admin', 'Head', 'Employee'].includes(role)) filter.role = role;

    const status = firstString(req.query.status, 20);
    if (['Pending', 'Approved', 'Rejected'].includes(status)) filter.status = status;

    if (params.q) {
      const regex = new RegExp(escapeRegex(params.q), 'i');
      filter.$or = [{ name: regex }, { email: regex }];
    }

    const { data, pagination } = await paginate(User, filter, params, { select: USER_LIST_SELECT });

    return listResponse(res, { params, data: data.map(withAccountCount), pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getAllUsers failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve users.' });
  }
};

// @desc    Get single user by ID
// @route   GET /api/users/:id
// @access  Private/Admin
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findOne({ _id: req.params.id, deletedAt: null })
      .select(USER_LIST_SELECT)
      .lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    return res.status(200).json(withAccountCount(user));
  } catch (error) {
    logger.error({ err: error.message }, 'getUserById failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve user details.' });
  }
};

// @desc    Create a new Head or Employee user
// @route   POST /api/users
// @access  Private/Admin
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate: all fields required
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'All fields (name, email, password, role) are required.' });
    }

    // Validate: role must be Head or Employee (Admin cannot create another Admin)
    const allowedRoles = ['Head', 'Employee'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role. Admin can only create Head or Employee accounts.' });
    }

    // Check if email already exists (soft-deleted accounts tombstone their address)
    const emailNormalized = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: emailNormalized, deletedAt: null });
    if (userExists) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash password using bcryptjs
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save and return new user
    const newUser = new User({
      name: name.trim(),
      email: emailNormalized,
      password: hashedPassword,
      role
    });

    const savedUser = await newUser.save();
    await cache.invalidateStats();

    // Account creation is security relevant and was previously unlogged.
    await logActivity(
      req.user._id,
      'User Creation',
      `Created user ${savedUser.email} with role ${savedUser.role}`,
      {
        req,
        targetType: 'User',
        targetId: savedUser._id,
        targetLabel: savedUser.email,
        before: null,
        after: { name: savedUser.name, email: savedUser.email, role: savedUser.role, status: savedUser.status }
      }
    );

    // Response user object excluding password
    const userResponse = {
      _id: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      role: savedUser.role,
      createdAt: savedUser.createdAt
    };

    return res.status(201).json(userResponse);
  } catch (error) {
    logger.error({ err: error.message }, 'createUser failed');
    return res.status(500).json({ message: 'Server error. Failed to create user.' });
  }
};

// @desc    Update user details (name, email, role)
// @route   PUT /api/users/:id
// @access  Private/Admin
exports.updateUser = async (req, res) => {
  try {
    const { name, email, role, status, maxConnectedAccounts, allowedGmailAccounts } = req.body;

    // Find user
    const user = await User.findOne({ _id: req.params.id, deletedAt: null });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Captured before any mutation so the audit entry records before/after.
    // S-2: this snapshot is now persisted STRUCTURALLY on the ActivityLog row
    // rather than being formatted into the `details` sentence.
    const previousRole = user.role;
    const previousStatus = user.status;
    const snapshot = (doc) => ({
      name: doc.name,
      email: doc.email,
      role: doc.role,
      status: doc.status,
      maxConnectedAccounts: doc.maxConnectedAccounts,
      allowedGmailAccounts: [...(doc.allowedGmailAccounts || [])]
    });
    const beforeState = snapshot(user);

    if (maxConnectedAccounts !== undefined) {
      user.maxConnectedAccounts = Number(maxConnectedAccounts) >= 0 ? Number(maxConnectedAccounts) : 5;
    }

    if (allowedGmailAccounts !== undefined) {
      user.allowedGmailAccounts = Array.isArray(allowedGmailAccounts)
        ? allowedGmailAccounts.map((e) => e.trim()).filter(Boolean)
        : typeof allowedGmailAccounts === 'string'
        ? allowedGmailAccounts.split(',').map((e) => e.trim()).filter(Boolean)
        : [];
    }

    // Validate role if updated (must be Admin, Head, or Employee)
    if (role) {
      const allowedRoles = ['Admin', 'Head', 'Employee'];
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ message: 'Invalid role selection.' });
      }
      // Enforce single Admin constraint
      if (role === 'Admin') {
        const approvedAdminExists = await User.findOne({
          role: 'Admin',
          status: 'Approved',
          deletedAt: null,
          _id: { $ne: user._id }
        }).select('_id').lean();
        if (approvedAdminExists) {
          return res.status(400).json({ message: 'There can only be one Admin in the system.' });
        }
      }
      user.role = role;
    }

    // Handle status changes & email dispatch
    if (status) {
      const allowedStatuses = ['Pending', 'Approved', 'Rejected'];
      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid status selection.' });
      }
      
      // Enforce single Admin constraint on status approval
      if (status === 'Approved' && user.role === 'Admin') {
        const approvedAdminExists = await User.findOne({
          role: 'Admin',
          status: 'Approved',
          deletedAt: null,
          _id: { $ne: user._id }
        }).select('_id').lean();
        if (approvedAdminExists) {
          return res.status(400).json({ message: 'There can only be one Admin in the system.' });
        }
      }

      const wasPending = user.status === 'Pending';
      user.status = status;
      
      if (wasPending && status === 'Approved') {
        try {
          const { sendEmail } = require('../utils/emailHelper');
          const { accountApproved } = require('../utils/emailTemplates');
          // The old copy hard-coded "as an Administrator" regardless of the
          // role actually granted, so an approved Employee was told they were
          // an Admin.
          const mail = accountApproved({ name: user.name, email: user.email, role: user.role });

          await sendEmail(user.email, mail.subject, mail.text, mail.html);
        } catch (emailErr) {
          logger.error({ err: emailErr.message }, 'failed to queue approval email');
        }
      }
    }

    if (name) {
      user.name = name.trim();
    }

    if (email) {
      const emailNormalized = email.toLowerCase().trim();
      // If email is changing, check if new email is already taken
      if (emailNormalized !== user.email) {
        const emailExists = await User.findOne({ email: emailNormalized, deletedAt: null });
        if (emailExists) {
          return res.status(400).json({ message: 'Email address is already in use by another user.' });
        }
        user.email = emailNormalized;
      }
    }

    // Revoke live sessions whenever privilege or account state changes.
    //
    // Previously `status` flipped without touching tokenVersion, so a rejected
    // or suspended employee kept a fully working JWT (and Socket.io session)
    // for the remaining 7 days. A role change had the same problem.
    const roleChanged = user.role !== previousRole;
    const statusChanged = user.status !== previousStatus;

    if (roleChanged || statusChanged) {
      user.tokenVersion = (user.tokenVersion || 0) + 1;
    }

    const updatedUser = await user.save();

    // Any role/status change revokes live sessions via tokenVersion; the cached
    // copy of this user must go with it or the revocation would not take effect
    // until the TTL expired.
    await cache.invalidateUser(user._id);

    // Audit: role escalation and status changes are the most security-relevant
    // actions in the system and wrote no ActivityLog entry at all before.
    const afterState = snapshot(updatedUser);
    const auditMeta = {
      req,
      targetType: 'User',
      targetId: updatedUser._id,
      targetLabel: updatedUser.email,
      before: beforeState,
      after: afterState
    };

    if (roleChanged) {
      await logActivity(
        req.user._id,
        'User Role Change',
        `Changed role of ${updatedUser.email} from ${previousRole} to ${updatedUser.role}`,
        auditMeta
      );
    }
    if (statusChanged) {
      await logActivity(
        req.user._id,
        'User Status Change',
        `Changed status of ${updatedUser.email} from ${previousStatus} to ${updatedUser.status}`,
        auditMeta
      );
    }
    if (!roleChanged && !statusChanged) {
      await logActivity(req.user._id, 'User Update', `Updated user ${updatedUser.email}`, auditMeta);
    }

    // WAVE2 gap S-5: return the FULL updated document (minus secrets).
    //
    // This response used to omit `maxConnectedAccounts` and
    // `allowedGmailAccounts` — the two fields the Gmail-permission form on the
    // admin page edits — so the page had to re-GET the whole user list after
    // every save just to see what it had written.
    const userResponse = withAccountCount(
      await User.findById(updatedUser._id).select(USER_LIST_SELECT).lean()
    );

    return res.status(200).json(userResponse);
  } catch (error) {
    logger.error({ err: error.message }, 'updateUser failed');
    return res.status(500).json({ message: 'Server error. Failed to update user.' });
  }
};

// @desc    Delete user
// @route   DELETE /api/users/:id
// @access  Private/Admin
exports.deleteUser = async (req, res) => {
  try {
    // Cannot delete own account
    if (req.user._id.toString() === req.params.id) {
      return res.status(400).json({ message: 'Access denied. You cannot delete your own Administrator account.' });
    }

    // Select the token fields explicitly so they can be cleared on the document.
    const user = await User.findOne({ _id: req.params.id, deletedAt: null })
      .select('+gmailAccessToken +gmailRefreshToken +linkedGmailAccounts +resetTokenHash +resetTokenExpires');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const userId = user._id;
    const originalEmail = user.email;
    const originalRole = user.role;
    const beforeState = { name: user.name, email: originalEmail, role: user.role, status: user.status };

    // SOFT delete.
    //
    // The previous hard delete cascaded through seven collections and purged
    // the departing user's ActivityLog entries and comments — destroying the
    // audit trail of the very account being destroyed. Their history now
    // survives; only their access is removed.

    // These touch four different collections and are independent of each other,
    // so they run in parallel: four sequential round-trips became one.
    await Promise.all([
      // 1. Unassign tasks assigned to this user (keep the task history)
      Task.updateMany({ assignedTo: userId }, { $set: { assignedTo: null } }),
      // 2. Unassign emails assigned to this user
      Email.updateMany({ assignedTo: userId }, { $set: { assignedTo: null, status: 'unassigned' } }),
      // 3. Notifications are per-user and carry no audit value once the account
      //    is gone — these remain a hard delete.
      Notification.deleteMany({ userId }),
      // 4. ActivityLog entries are RETAINED (append-only audit trail).
      // 5. TaskComments are RETAINED so task discussions stay intelligible.
      // 6. Deactivate, rather than delete, keyword rules created by this user.
      KeywordRule.updateMany({ createdBy: userId }, { $set: { isActive: false } }),
      // 7. Unassign keyword rules targeting this user
      KeywordRule.updateMany({ assignedTo: userId }, { $set: { assignedTo: null, isActive: false } })
    ]);

    // Tombstone the address so it frees the unique index and can be
    // re-registered, while preserving the original for the audit record.
    user.deletedAt = new Date();
    user.deletedBy = req.user._id;
    user.deletedEmail = originalEmail;
    user.email = `deleted+${userId}@deleted.invalid`;
    user.status = 'Rejected';
    // Invalidate every live session immediately.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    // Revoke Gmail credentials so no background sync keeps running for them.
    user.gmailAccessToken = null;
    user.gmailRefreshToken = null;
    user.gmailEmail = '';
    user.linkedGmailAccounts = [];
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    await user.save();

    // The cached auth lookup MUST be dropped immediately: leaving it would let
    // a deleted account keep authenticating for the remainder of the TTL.
    await cache.invalidateUser(userId);
    await cache.invalidateRules();
    await cache.invalidateStats();

    await logActivity(
      req.user._id,
      'User Deletion',
      `Deleted user ${originalEmail} (role: ${originalRole})`,
      {
        req,
        targetType: 'User',
        targetId: userId,
        targetLabel: originalEmail,
        before: beforeState,
        after: { deletedAt: user.deletedAt, status: user.status, email: user.email }
      }
    );

    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteUser failed');
    return res.status(500).json({ message: 'Server error. Failed to delete user.' });
  }
};

// @desc    Get all activity logs
// @route   GET /api/users/activity-logs
// @access  Private (Admin only)
exports.getActivityLogs = async (req, res) => {
  try {
    // The fastest-growing collection in the system: ~500-2000 rows/day, and
    // this endpoint used to return ALL of them with an unbounded populate. At
    // six months of history that is a ~50 MB response — the Admin activity page
    // was effectively a denial-of-service button.
    const params = parseListParams(req, {
      sortWhitelist: ACTIVITY_SORT_FIELDS,
      defaultSort: '-createdAt',
      defaultLimit: 50
    });

    const filter = {};

    // WAVE2 gap S-3 — the actor filter parameter is settled.
    //
    // CANONICAL: `userId`.  ALIAS: `actor` (accepted, identical semantics).
    // The Admin page sends both because the name was unspecified; `userId`
    // wins when they disagree. Documented in docs/audits/API-LIST-CONTRACT.md.
    const userId = firstString(req.query.userId, 40) || firstString(req.query.actor, 40);
    if (/^[0-9a-fA-F]{24}$/.test(userId)) filter.userId = userId;

    const action = firstString(req.query.action, 100);
    if (action) filter.action = action;

    // S-2: the structured target is queryable now that it is a real column.
    const targetType = firstString(req.query.targetType, 30);
    if (targetType) filter.targetType = targetType;

    const targetId = firstString(req.query.targetId, 60);
    if (targetId) filter.targetId = targetId;

    // Date range, per the contract's dateFrom/dateTo.
    const dateFrom = firstString(req.query.dateFrom, 40);
    const dateTo = firstString(req.query.dateTo, 40);
    if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom && !Number.isNaN(Date.parse(dateFrom))) range.$gte = new Date(dateFrom);
      if (dateTo && !Number.isNaN(Date.parse(dateTo))) range.$lte = new Date(dateTo);
      if (Object.keys(range).length > 0) filter.createdAt = range;
    }

    if (params.q) {
      const regex = new RegExp(escapeRegex(params.q), 'i');
      filter.$or = [{ action: regex }, { details: regex }, { targetLabel: regex }, { ip: regex }];
    }

    const { data, pagination } = await paginate(ActivityLog, filter, params, {
      select: ACTIVITY_LOG_FIELDS,
      populate: [{ path: 'userId', select: 'name email role' }]
    });

    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getActivityLogs failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve activity logs.' });
  }
};

// @desc    Update logged-in user profile details (name, email, birthdate, phoneNumber)
// @route   PUT /api/users/profile
// @access  Private
exports.updateUserProfile = async (req, res) => {
  try {
    const { name, email, birthdate, phoneNumber } = req.body;

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const beforeState = {
      name: user.name,
      email: user.email,
      birthdate: user.birthdate,
      phoneNumber: user.phoneNumber
    };

    if (name) {
      user.name = name.trim();
    }

    if (email) {
      const emailNormalized = email.toLowerCase().trim();
      // If email is changing, check if new email is already taken
      if (emailNormalized !== user.email) {
        const emailExists = await User.findOne({ email: emailNormalized, deletedAt: null });
        if (emailExists) {
          return res.status(400).json({ message: 'Email address is already in use by another user.' });
        }
        user.email = emailNormalized;
      }
    }

    // Birthdate and Phone Number are optional/nullable
    if (birthdate !== undefined) {
      user.birthdate = birthdate || null;
    }

    if (phoneNumber !== undefined) {
      user.phoneNumber = phoneNumber ? phoneNumber.trim() : '';
    }

    const updatedUser = await user.save();
    await cache.invalidateUser(user._id);

    await logActivity(req.user._id, 'Profile Update', 'Updated own profile details', {
      req,
      targetType: 'User',
      targetId: updatedUser._id,
      targetLabel: updatedUser.email,
      before: beforeState,
      after: {
        name: updatedUser.name,
        email: updatedUser.email,
        birthdate: updatedUser.birthdate,
        phoneNumber: updatedUser.phoneNumber
      }
    });

    // WAVE2 gap S-7: return the SAME shape as GET /api/auth/me.
    //
    // This used to be a hand-picked subset that omitted `status` (and
    // `maxConnectedAccounts`, `allowedGmailAccounts`, `notificationPreferences`),
    // so a client assigning the response wholesale silently dropped fields that
    // /auth/me had supplied. `/auth/me` returns `req.user`, which is
    // `User.findById().select('-password').lean()` — every `select: false`
    // field (tokens, reset hashes) is excluded by the schema, so this is the
    // identical projection.
    const userResponse = await User.findById(updatedUser._id).select('-password').lean();

    return res.status(200).json(userResponse);
  } catch (error) {
    logger.error({ err: error.message }, 'updateUserProfile failed');
    return res.status(500).json({ message: 'Server error. Failed to update profile.' });
  }
};

// @desc    Change password of the logged-in user
// @route   PUT /api/users/change-password
// @access  Private
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: 'Current password and new password are required.' });
    }

    const user = await User.findById(req.user._id).select('+password');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Compare current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Incorrect current password.' });
    }

    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    user.password = hashedPassword;
    // Bumping tokenVersion invalidates EVERY session that holds the old
    // credential — that is the point, and it stays.
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();
    await cache.invalidateUser(user._id);

    await logActivity(user._id, 'Password Change', 'Successfully changed account password', {
      req,
      targetType: 'User',
      targetId: user._id,
      targetLabel: user.email
      // Deliberately NO before/after: there is nothing to record here that is
      // not a credential.
    });

    // WAVE2 gap S-6: hand back a replacement token for THIS session.
    //
    // The tokenVersion bump above invalidated the caller's own JWT along with
    // everyone else's, so changing your own password logged you out. The new
    // token is signed with the new tokenVersion, so every OTHER session stays
    // revoked while the session that performed the change survives.
    const token = generateToken(user);
    const userResponse = await User.findById(user._id).select('-password').lean();

    return res.status(200).json({
      message: 'Password changed successfully.',
      token,
      user: userResponse
    });
  } catch (error) {
    logger.error({ err: error.message }, 'changePassword failed');
    return res.status(500).json({ message: 'Server error. Failed to change password.' });
  }
};

// @desc    Read the logged-in user's notification preferences
// @route   GET /api/users/notification-preferences
// @access  Private (all roles)
//
// WAVE2 gap S-12. Always returns the COMPLETE shape: an account created before
// this feature existed has no sub-document, and the defaults are materialised
// on read so a client never has to guess which keys exist.
exports.getNotificationPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notificationPreferences').lean();
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    return res.status(200).json({
      notificationPreferences: notificationPrefs.normalizePreferences(user.notificationPreferences),
      // The canonical event list, so the UI can render one toggle per event
      // without hard-coding a list that would drift from the server's.
      events: notificationPrefs.NOTIFICATION_EVENTS
    });
  } catch (error) {
    logger.error({ err: error.message }, 'getNotificationPreferences failed');
    return res.status(500).json({ message: 'Server error. Failed to load notification preferences.' });
  }
};

// @desc    Update the logged-in user's notification preferences
// @route   PUT /api/users/notification-preferences
// @access  Private (all roles)
//
// A PUT that behaves as a DEEP MERGE: send only the toggle that changed. A
// full object is equally valid. Unknown event names and non-boolean values are
// rejected with a 400 carrying a field-error list, matching the shape
// middleware/validate.js produces elsewhere.
exports.updateNotificationPreferences = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notificationPreferences email');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const current = notificationPrefs.normalizePreferences(user.notificationPreferences);

    // Accept either a bare preferences object or one wrapped in
    // `{ notificationPreferences: {...} }`, because that is exactly what the
    // GET returns and round-tripping it must work.
    const patch =
      req.body && typeof req.body === 'object' && req.body.notificationPreferences !== undefined
        ? req.body.notificationPreferences
        : req.body;

    const { preferences, errors } = notificationPrefs.mergePreferences(current, patch);

    if (errors.length > 0) {
      return res.status(400).json({
        message: 'Invalid notification preferences.',
        errors: errors.map((message) => ({ field: 'notificationPreferences', message }))
      });
    }

    user.notificationPreferences = preferences;
    await user.save();

    // The preference cache is read on EVERY notification write, so a stale
    // entry would keep delivering muted notifications for a full TTL.
    await notificationPrefs.invalidate(user._id);
    await cache.invalidateUser(user._id);

    await logActivity(req.user._id, 'Notification Preferences Update', 'Updated notification preferences', {
      req,
      targetType: 'User',
      targetId: user._id,
      targetLabel: user.email,
      before: current,
      after: preferences
    });

    return res.status(200).json({
      message: 'Notification preferences updated.',
      notificationPreferences: preferences,
      events: notificationPrefs.NOTIFICATION_EVENTS
    });
  } catch (error) {
    logger.error({ err: error.message }, 'updateNotificationPreferences failed');
    return res.status(500).json({ message: 'Server error. Failed to update notification preferences.' });
  }
};
