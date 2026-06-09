const User = require('../models/User');
const bcrypt = require('bcryptjs');
const ActivityLog = require('../models/ActivityLog');

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
    const { name, email, role } = req.body;

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
      user.role = role;
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
