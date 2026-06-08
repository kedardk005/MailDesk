const express = require('express');
const router = express.Router();
const {
  getAuthUrl,
  handleOAuthCallback,
  fetchEmails,
  getEmails
} = require('../controllers/gmailController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// GET /api/gmail/auth-url - Generate Google OAuth URL (protected, Admin/Head only)
router.get('/auth-url', protect, authorizeRoles('Admin', 'Head'), getAuthUrl);

// GET /api/gmail/oauth/callback - Google redirect target (public callback)
router.get('/oauth/callback', handleOAuthCallback);

// POST /api/gmail/fetch - Triggers a manual email pull from Gmail (protected, Admin/Head only)
router.post('/fetch', protect, authorizeRoles('Admin', 'Head'), fetchEmails);

// GET /api/gmail/emails - Gets all fetched emails matching user authorization scope (protected, Admin/Head only)
router.get('/emails', protect, authorizeRoles('Admin', 'Head'), getEmails);

module.exports = router;
