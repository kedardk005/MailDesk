const express = require('express');
const router = express.Router();
const { registerUser, loginUser, forgotPassword, resetPassword } = require('../controllers/authController');
const validate = require('../middleware/validate');
const {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema
} = require('../middleware/schemas');

// POST /api/auth/register - Register a new user
router.post('/register', validate(registerSchema), registerUser);

// POST /api/auth/login - Login existing user
router.post('/login', validate(loginSchema), loginUser);

// POST /api/auth/forgot-password - Email a single-use password reset link
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);

// POST /api/auth/reset-password - Redeem a reset token and set a new password
router.post('/reset-password', validate(resetPasswordSchema), resetPassword);

module.exports = router;
