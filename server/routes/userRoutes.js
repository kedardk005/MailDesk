const express = require('express');
const router = express.Router();
const {
  getAllUsers,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  getActivityLogs,
  updateUserProfile,
  changePassword
} = require('../controllers/userController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const {
  createUserSchema,
  updateUserSchema,
  updateUserProfileSchema,
  changePasswordSchema
} = require('../middleware/schemas');

// All routes here require authenticating first
router.use(protect);

// PUT /api/users/profile - Update own profile (all roles)
router.put('/profile', validate(updateUserProfileSchema), updateUserProfile);

// PUT /api/users/change-password - Change own password (all roles)
router.put('/change-password', validate(changePasswordSchema), changePassword);

// GET /api/users - Get all users (accessible by Admin and Head for assignment lists)
// POST /api/users - Create new Head/Employee user (Admin only)
router.route('/')
  .get(authorizeRoles('Admin', 'Head'), getAllUsers)
  .post(authorizeRoles('Admin'), validate(createUserSchema), createUser);

// GET /api/users/activity-logs - Get activity logs (Admin only)
router.get('/activity-logs', authorizeRoles('Admin'), getActivityLogs);

// GET /api/users/:id - Get user by ID (Admin only)
// PUT /api/users/:id - Update user details by ID (Admin only)
// DELETE /api/users/:id - Delete user by ID (Admin only)
router.route('/:id')
  .get(authorizeRoles('Admin'), getUserById)
  .put(authorizeRoles('Admin'), validate(updateUserSchema), updateUser)
  .delete(authorizeRoles('Admin'), deleteUser);

module.exports = router;
