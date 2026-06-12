const express = require('express');
const router = express.Router();
const { registerUser, loginUser, forgotPassword } = require('../controllers/authController');

// POST /api/auth/register - Register a new user
router.post('/register', registerUser);

// POST /api/auth/login - Login existing user
router.post('/login', loginUser);

// POST /api/auth/forgot-password - Send temporary password to user
router.post('/forgot-password', forgotPassword);

module.exports = router;
