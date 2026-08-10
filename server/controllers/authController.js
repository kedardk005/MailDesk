const User = require('../models/User');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { logActivity } = require('../utils/activityLogger');
const cache = require('../utils/cache');
const { generateToken } = require('../utils/tokenService');
const { log } = require('../utils/logger');
// M-13: one error envelope, `{ message, errors: [{ path, message }] }`.
const { fieldError } = require('../utils/apiError');

const logger = log('auth');

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
exports.registerUser = async (req, res) => {
  try {
    const { name, email, password, role } = req.body;

    // Validate: name, email, password are required
    if (!name || !email || !password) {
      return fieldError(res, 400, 'All fields (name, email, password) are required.', [
        !name && { path: 'name', message: 'Name is required.' },
        !email && { path: 'email', message: 'Email address is required.' },
        !password && { path: 'password', message: 'Password is required.' }
      ].filter(Boolean));
    }

    // Check if email already exists (a soft-deleted account tombstones its
    // address, so it does not block re-registration).
    const emailNormalized = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: emailNormalized, deletedAt: null });
    if (userExists) {
      // M-13: a duplicate address is a field error on `email`.
      return fieldError(res, 400, 'User with this email already exists.', ['email']);
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
      return fieldError(res, 400, 'Registration as Admin is only allowed for the first user.', ['role']);
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
      return fieldError(res, 400, 'Please provide both email and password.', [
        !email && { path: 'email', message: 'Email address is required.' },
        !password && { path: 'password', message: 'Password is required.' }
      ].filter(Boolean));
    }

    // Find user by email
    const emailNormalized = email.toLowerCase().trim();
    // Soft-deleted accounts must not be able to authenticate.
    const user = await User.findOne({ email: emailNormalized, deletedAt: null }).select('+password');
    if (!user) {
      // The path is `email`; the MESSAGE is unchanged, so this discloses
      // nothing the response did not already say (M-13 is about attaching an
      // existing error to an input, not about what the error reveals).
      return fieldError(res, 400, 'Invalid credentials. User not found.', ['email']);
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return fieldError(res, 400, 'Invalid credentials. Incorrect password.', ['password']);
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
      return fieldError(res, 400, 'Please provide email address.', ['email']);
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
    const { passwordReset } = require('../utils/emailTemplates');
    const mail = passwordReset({
      name: user.name,
      resetLink,
      expiresMinutes: Math.round(RESET_TOKEN_TTL_MS / 60000)
    });

    await sendEmail(user.email, mail.subject, mail.text, mail.html);
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
      return fieldError(res, 400, 'Reset token and new password are required.', [
        !token && { path: 'token', message: 'Reset token is required.' },
        !password && { path: 'password', message: 'A new password is required.' }
      ].filter(Boolean));
    }

    // Look the user up BY the token hash, so a token is the only way in.
    const user = await User.findOne({
      resetTokenHash: hashResetToken(token),
      resetTokenExpires: { $gt: new Date() },
      deletedAt: null
    }).select('+password +resetTokenHash +resetTokenExpires');

    if (!user) {
      return fieldError(res, 400, 'This password reset link is invalid or has expired.', ['token']);
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
