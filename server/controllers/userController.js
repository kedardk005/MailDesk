const User = require('../models/User');
const bcrypt = require('bcryptjs');
const ActivityLog = require('../models/ActivityLog');
const { logActivity } = require('../utils/activityLogger');

// @desc    Get all users
// @route   GET /api/users
// @access  Private/Admin
exports.getAllUsers = async (req, res) => {
  try {
    const users = await User.find({}).select('-password').sort({ createdAt: -1 });
    return res.status(200).json(users);
  } catch (error) {
    console.error('Error in getAllUsers:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve users.' });
  }
};

// @desc    Get single user by ID
// @route   GET /api/users/:id
// @access  Private/Admin
exports.getUserById = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }
    return res.status(200).json(user);
  } catch (error) {
    console.error('Error in getUserById:', error);
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

    // Check if email already exists
    const emailNormalized = email.toLowerCase().trim();
    const userExists = await User.findOne({ email: emailNormalized });
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
    console.error('Error in createUser:', error);
    return res.status(500).json({ message: 'Server error. Failed to create user.' });
  }
};

// @desc    Update user details (name, email, role)
// @route   PUT /api/users/:id
// @access  Private/Admin
exports.updateUser = async (req, res) => {
  try {
    const { name, email, role, status } = req.body;

    // Find user
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
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
          _id: { $ne: user._id }
        });
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
          _id: { $ne: user._id }
        });
        if (approvedAdminExists) {
          return res.status(400).json({ message: 'There can only be one Admin in the system.' });
        }
      }

      const wasPending = user.status === 'Pending';
      user.status = status;
      
      if (wasPending && status === 'Approved') {
        try {
          const { sendEmail } = require('../utils/emailHelper');
          const emailSubject = 'Your MailDesk Account has been Approved!';
          
          // Plain text fallback
          const emailBody = `Hello ${user.name},\n\nGreat news! Your request to join MailDesk as an Administrator has been approved. You can now log in to the workspace at your convenience using your email address.\n\nBest regards,\nThe MailDesk Team`;
          
          // Rich HTML well-formatted email
          const emailHtml = `
            <div style="font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
              <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f1f5f9;">
                <h1 style="color: #4f46e5; margin: 0; font-size: 24px; font-weight: 800;">MailDesk</h1>
              </div>
              <div style="padding: 20px 0;">
                <p style="font-size: 16px; line-height: 1.6; color: #334155;">Hello <strong>${user.name}</strong>,</p>
                <p style="font-size: 16px; line-height: 1.6; color: #334155;">Great news! Your request to join the workspace as an <strong>Administrator</strong> has been reviewed and <strong>approved</strong> by an existing administrator.</p>
                <div style="margin: 24px 0; text-align: center;">
                  <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/login" style="background-color: #4f46e5; color: #ffffff; text-decoration: none; padding: 12px 24px; font-size: 14px; font-weight: 700; border-radius: 8px; display: inline-block;">Log In to MailDesk</a>
                </div>
                <p style="font-size: 14px; line-height: 1.6; color: #64748b;">You can log in using your registered email: <strong>${user.email}</strong></p>
              </div>
              <div style="padding-top: 20px; border-top: 1px solid #f1f5f9; text-align: center; font-size: 12px; color: #94a3b8;">
                <p style="margin: 0;">This is an automated workspace notification sent from MailDesk.</p>
              </div>
            </div>
          `;
          await sendEmail(user.email, emailSubject, emailBody, emailHtml);
        } catch (emailErr) {
          console.error('Failed to send approval email notification:', emailErr);
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
        const emailExists = await User.findOne({ email: emailNormalized });
        if (emailExists) {
          return res.status(400).json({ message: 'Email address is already in use by another user.' });
        }
        user.email = emailNormalized;
      }
    }

    const updatedUser = await user.save();

    // Response user object excluding password
    const userResponse = {
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role,
      status: updatedUser.status,
      createdAt: updatedUser.createdAt
    };

    return res.status(200).json(userResponse);
  } catch (error) {
    console.error('Error in updateUser:', error);
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

    // Find and delete user
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    await User.findByIdAndDelete(req.params.id);

    return res.status(200).json({ message: 'User deleted successfully.' });
  } catch (error) {
    console.error('Error in deleteUser:', error);
    return res.status(500).json({ message: 'Server error. Failed to delete user.' });
  }
};

// @desc    Get all activity logs
// @route   GET /api/users/activity-logs
// @access  Private (Admin only)
exports.getActivityLogs = async (req, res) => {
  try {
    const logs = await ActivityLog.find({})
      .populate('userId', 'name email role')
      .sort({ createdAt: -1 });
    return res.status(200).json(logs);
  } catch (error) {
    console.error('Error in getActivityLogs:', error);
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

    if (name) {
      user.name = name.trim();
    }

    if (email) {
      const emailNormalized = email.toLowerCase().trim();
      // If email is changing, check if new email is already taken
      if (emailNormalized !== user.email) {
        const emailExists = await User.findOne({ email: emailNormalized });
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

    // Response user object excluding password
    const userResponse = {
      _id: updatedUser._id,
      name: updatedUser.name,
      email: updatedUser.email,
      role: updatedUser.role,
      birthdate: updatedUser.birthdate,
      phoneNumber: updatedUser.phoneNumber,
      createdAt: updatedUser.createdAt
    };

    return res.status(200).json(userResponse);
  } catch (error) {
    console.error('Error in updateUserProfile:', error);
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

    const user = await User.findById(req.user._id);
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
    user.tokenVersion = (user.tokenVersion || 0) + 1;
    await user.save();

    await logActivity(user._id, 'Password Change', `Successfully changed account password`);

    return res.status(200).json({ message: 'Password changed successfully.' });
  } catch (error) {
    console.error('Error in changePassword:', error);
    return res.status(500).json({ message: 'Server error. Failed to change password.' });
  }
};
