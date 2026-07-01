const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { logActivity } = require('../utils/activityLogger');

/**
 * Generate a JWT token for a user
 * @param {Object} user - The user document
 * @returns {String} JWT token
 */
const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, role: user.role, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

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

    // Check if email already exists
    const emailNormalized = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: emailNormalized });
    if (userExists) {
      return res.status(400).json({ message: 'User with this email already exists.' });
    }

    // Hash password using bcryptjs (salt rounds: 10)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Lock down registration and role assignment
    const totalUsers = await User.countDocuments({});
    let finalRole = 'Employee';
    let status = 'Approved';

    if (role === 'Admin') {
      if (totalUsers === 0) {
        finalRole = 'Admin';
      } else {
        return res.status(400).json({ message: 'Registration as Admin is only allowed for the first user.' });
      }
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

    // Generate JWT token
    const token = generateToken(savedUser);

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

    return res.status(201).json({
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('Error in registerUser:', error);
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
    const user = await User.findOne({ email: emailNormalized });
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

    // Return JWT token + user object (without password)
    const userResponse = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      birthdate: user.birthdate,
      phoneNumber: user.phoneNumber,
      createdAt: user.createdAt
    };

    await logActivity(user._id, 'Login', `Logged in as ${user.role}`);

    return res.status(200).json({
      token,
      user: userResponse
    });
  } catch (error) {
    console.error('Error in loginUser:', error);
    return res.status(500).json({ message: 'Server error. Please try again later.' });
  }
};

// @desc    Forgot Password - generates a temporary password and sends it via email
// @route   POST /api/auth/forgot-password
// @access  Public
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Please provide email address.' });
    }

    const emailNormalized = email.toLowerCase().trim();
    const user = await User.findOne({ email: emailNormalized });
    
    // For security reasons, do not explicitly confirm if user does not exist
    if (!user) {
      return res.status(200).json({ message: 'If a user with this email exists, a temporary password has been sent to it.' });
    }

    // Generate unique random password of 10 characters
    const generateTempPassword = () => {
      const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$';
      let pass = '';
      for (let i = 0; i < 10; i++) {
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return pass;
    };
    const tempPassword = generateTempPassword();



    // Hash temporary password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(tempPassword, salt);

    user.password = hashedPassword;
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    // Send email helper
    const { sendEmail } = require('../utils/emailHelper');
    const emailSubject = 'MailDesk - Temporary Password Request';
    
    const emailBody = `Hello ${user.name},\n\nYou requested a password reset for MailDesk. Use the following temporary password to log in:\n\nTemporary Password: ${tempPassword}\n\nOnce logged in, please go to your Profile to set a new password.\n\nBest regards,\nThe MailDesk Team`;
    
    const emailHtml = `
      <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f1f5f9;">
          <h1 style="color: #4f46e5; margin: 0; font-size: 24px; font-weight: 800;">MailDesk</h1>
        </div>
        <div style="padding: 20px 0;">
          <p style="font-size: 16px; line-height: 1.6; color: #334155;">Hello <strong>${user.name}</strong>,</p>
          <p style="font-size: 16px; line-height: 1.6; color: #334155;">You requested a temporary password for your MailDesk account. Use the unique password credentials below to log in:</p>
          <div style="margin: 24px 0; padding: 16px; background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; text-align: center; font-family: monospace; font-size: 18px; font-weight: 700; color: #4f46e5; letter-spacing: 1.5px;">
            ${tempPassword}
          </div>
          <p style="font-size: 14px; line-height: 1.6; color: #ef4444; font-weight: 600;">Important Safety Warning: Once logged in, go directly to your My Profile page inside the system and change this password immediately.</p>
        </div>
        <div style="padding-top: 20px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
          <p style="margin: 0;">If you did not request this password reset, please secure your email account.</p>
        </div>
      </div>
    `;
    
    await sendEmail(user.email, emailSubject, emailBody, emailHtml);
    await logActivity(user._id, 'Password Reset Request', `Sent temporary password reset email`);

    return res.status(200).json({ message: 'If a user with this email exists, a temporary password has been sent to it.' });
  } catch (error) {
    console.error('Error in forgotPassword:', error);
    return res.status(500).json({ message: 'Server error. Failed to process password reset.' });
  }
};
