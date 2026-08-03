const User = require('../models/User');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logActivity } = require('../utils/activityLogger');
const cache = require('../utils/cache');
const { generateToken } = require('../utils/tokenService');
const { log } = require('../utils/logger');

const logger = log('auth');

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate: name, email, password are required
    if (!name || !email || !password) {
      return res.status(400).json({ message: 'All fields (name, email, password) are required.' });
    }

    // Check if email already exists (a soft-deleted account tombstones its
    // address, so it does not block re-registration).
    const emailNormalized = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: emailNormalized, deletedAt: null });
    if (userExists) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash password using bcryptjs (salt rounds: 10)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Lock down registration and role assignment.
    // `exists` stops at the first document; `countDocuments({})` scanned the
    // whole collection on EVERY registration attempt just to ask "is it empty".
    const anyUser = await User.exists({});
    let finalRole = 'Employee';
    let status = 'Pending'; // Self-registered users require Admin approval

    if (!anyUser) {
      // First user in the system becomes Admin with auto-approval
      finalRole = 'Admin';
      status = 'Approved';
    } else if (role === 'Admin') {
      return res.status(400).json({ message: 'Registration as Admin is only allowed for the first user.' });
    }

    // Save new user to MongoDB
    const newUser = new User({
      name: name.trim(),
      email: emailNormalized,
      password: hashedPassword,
      role: finalRole,
      status
    });

    const savedUser = await newUser.save();

    await logActivity(
      savedUser._id,
      'User Registration',
      `Self-registered with role ${savedUser.role} (status: ${savedUser.status})`,
      {
        req,
        targetType: 'User',
        targetId: savedUser._id,
        targetLabel: savedUser.email,
        after: { name: savedUser.name, email: savedUser.email, role: savedUser.role, status: savedUser.status }
      }
    );

    // Return JWT token + user object (without password)
    const userResponse = {
      _id: savedUser._id,
      name: savedUser.name,
      email: savedUser.email,
      role: savedUser.role,
      status: savedUser.status,
      birthdate: savedUser.birthdate,
      phoneNumber: savedUser.phoneNumber,
      createdAt: savedUser.createdAt
    };

    // A token used to be minted unconditionally, right here, BEFORE any status
    // gate — so a self-registered 'Pending' account received a working 7-day
    // JWT and Admin approval was decorative. Only an approved account gets one.
    if (savedUser.status !== 'Approved') {
      return res.status(201).json({
        message: 'Registration submitted. An administrator must approve your account before you can sign in.',
        user: userResponse
      });
    }

    const token = generateToken(savedUser);

    return res.status(201).json({
      token,
      user: userResponse
    });
  } catch (error) {
    logger.error({ err: error.message }, 'registerUser failed');
    return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate inputs
    if (!email || !password) {
      return res.status(400).json({ message: 'Please provide both email and password.' });
    }

    // Find user by email
    const emailNormalized = email.toLowerCase().trim();
    // Soft-deleted accounts must not be able to authenticate.
    const user = await User.findOne({ email: emailNormalized, deletedAt: null }).select('+password');
    if (!user) {
      return res.status(400).json({ message: 'Invalid credentials. User not found.' });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid credentials. Incorrect password.' });
    }

    // Check account status
    if (user.status === 'Pending') {
      return res.status(401).json({ message: 'Your administrator account is pending approval from an existing administrator.' });
    }
    if (user.status === 'Rejected') {
      return res.status(401).json({ message: 'Your registration request has been rejected by an administrator.' });
    }

    // Generate JWT token
    const token = generateToken(user);

    // WAVE2 gap S-4: record last successful login so the admin user list can
    // distinguish a dormant account from an active one.
    //
    // `updateOne` rather than `user.save()`: the document was loaded with
    // `+password` and re-saving it would re-run the whole document validation
    // on a hot path for one timestamp. It is also fire-and-forget — a failure
    // to stamp a timestamp must never fail a login.
    const previousLoginAt = user.lastLoginAt || null;
    const loginAt = new Date();
    User.updateOne({ _id: user._id }, { $set: { lastLoginAt: loginAt } })
      .then(() => cache.invalidateUser(user._id))
      .catch((err) => logger.warn({ err: err.message }, 'failed to record lastLoginAt'));

    // Return JWT token + user object (without password)
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      birthdate: user.birthdate,
      phoneNumber: user.phoneNumber,
      lastLoginAt: loginAt,
      createdAt: user.createdAt
    };

    await logActivity(user._id, 'Login', `Logged in as ${user.role}`, {
      req,
      targetType: 'User',
      targetId: user._id,
      targetLabel: user.email,
      before: { lastLoginAt: previousLoginAt },
      after: { lastLoginAt: loginAt }
    });

    return res.status(200).json({
      token,
      user: userResponse
    });
  } catch (error) {
    logger.error({ err: error.message }, 'loginUser failed');
    return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

// Single-use reset tokens are valid for 30 minutes.
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000;

// Identical for every branch, so the endpoint cannot be used to enumerate accounts.
const RESET_GENERIC_RESPONSE =
  'If an account with this email exists, a password reset link has been sent to it.';

/**
 * Hash a raw reset token for storage/lookup. Only the hash is persisted, so a
 * database read cannot be replayed into an account takeover.
 * @param {String} raw
 * @returns {String} hex sha256
 */
const hashResetToken = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

// @desc    Forgot Password - emails a single-use, time-limited reset link
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Please provide email address.' });
    }

    const emailNormalized = email.toLowerCase().trim();
    const user = await User.findOne({ email: emailNormalized, deletedAt: null });

    // Do not confirm whether the account exists.
    if (!user) {
      return res.status(200).json({ message: RESET_GENERIC_RESPONSE });
    }

    // NOTHING about the account is mutated at request time.
    //
    // This endpoint previously overwrote the victim's password and bumped
    // tokenVersion on every unauthenticated request, so anyone who knew an
    // employee's address could log them out and invalidate their password at
    // will — an unauthenticated account-lockout denial of service.
    const rawToken = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = hashResetToken(rawToken);
    user.resetTokenExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetLink = `${frontendUrl}/reset-password?token=${rawToken}`;

    const { sendEmail } = require('../utils/emailHelper');
    const emailSubject = 'K M KOTHARI - Password Reset Request';

    const emailBody = `Hello ${user.name},\n\nYou requested a password reset for K M KOTHARI. Open the link below to choose a new password. This link can be used once and expires in 30 minutes.\n\n${resetLink}\n\nIf you did not request this, you can safely ignore this email — your password has not been changed.\n\nBest regards,\nThe K M KOTHARI Team`;

    const emailHtml = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f1f5f9;">
          <h1 style="color: #4f46e5; margin: 0; font-size: 24px; font-weight: 800;">K M KOTHARI</h1>
        </div>
        <div style="padding: 20px 0;">
          <p style="font-size: 16px; line-height: 1.6; color: #334155;">Hello <strong>${user.name}</strong>,</p>
          <p style="font-size: 16px; line-height: 1.6; color: #334155;">You requested a password reset for your K M KOTHARI account. Click the button below to choose a new password.</p>
          <div style="margin: 24px 0; text-align: center;">
            <a href="${resetLink}" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 14px; font-weight: 700; border-radius: 8px; display: inline-block;">Reset My Password</a>
          </div>
          <p style="font-size: 14px; line-height: 1.6; color: #64748b;">This link can be used once and expires in 30 minutes.</p>
        </div>
        <div style="padding-top: 20px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
          <p style="margin: 0;">If you did not request this reset, you can ignore this email — your password has not been changed.</p>
        </div>
      </div>
    `;

    await sendEmail(user.email, emailSubject, emailBody, emailHtml);
    await logActivity(user._id, 'Password Reset Request', 'Sent password reset link', {
      req,
      targetType: 'User',
      targetId: user._id,
      targetLabel: user.email
    });

    return res.status(200).json({ message: RESET_GENERIC_RESPONSE });
  } catch (error) {
    logger.error({ err: error.message }, 'forgotPassword failed');
    return res.status(500).json({ message: 'Server error. Failed to process password reset.' });
  }
};

// @desc    Reset password by redeeming a single-use token
// @route   POST /api/auth/reset-password
// @access  Public
exports.resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: 'Reset token and new password are required.' });
    }

    // Look the user up BY the token hash, so a token is the only way in.
    const user = await User.findOne({
      resetTokenHash: hashResetToken(token),
      resetTokenExpires: { $gt: new Date() },
      deletedAt: null
    }).select('+password +resetTokenHash +resetTokenExpires');

    if (!user) {
      return res.status(400).json({ message: 'This password reset link is invalid or has expired.' });
    }

    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(password, salt);

    // Single use: burn the token, and revoke every existing session now that
    // the credential has actually changed.
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Drop the cached auth lookup so the revocation takes effect immediately
    // rather than at the end of the cache TTL.
    await cache.invalidateUser(user._id);

    await logActivity(user._id, 'Password Reset', 'Password reset via emailed reset link', {
      req,
      targetType: 'User',
      targetId: user._id,
      targetLabel: user.email
    });

    return res.status(200).json({ message: 'Password reset successfully. You can now sign in with your new password.' });
  } catch (error) {
    logger.error({ err: error.message }, 'resetPassword failed');
    return res.status(500).json({ message: 'Server error. Failed to reset password.' });
  }
};
