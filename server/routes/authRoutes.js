const express = require('express');
const router = express.Router();
const { registerUser, loginUser, forgotPassword } = require('../controllers/authController');
const validate = require('../middleware/validate');
const { registerSchema, loginSchema, forgotPasswordSchema } = require('../middleware/schemas');

// POST /api/auth/register - Register a new user
router.post('/register', validate(registerSchema), registerUser);

// POST /api/auth/login - Login existing user
router.post('/login', validate(loginSchema), loginUser);

// POST /api/auth/forgot-password - Send temporary password to user
router.post('/forgot-password', validate(forgotPasswordSchema), forgotPassword);

module.exports = router;
