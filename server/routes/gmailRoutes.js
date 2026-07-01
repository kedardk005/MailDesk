const express = require('express');
const router = express.Router();
const {
  getAuthUrl,
  handleOAuthCallback,
  fetchEmails,
  getEmails,
  deleteAllEmails,
  deleteSingleEmail,
  getConnectedStatus,
  disconnectGmail,
  disconnectLinkedAccount,
  replyToEmail,
  bulkAssignEmails,
  downloadAttachment
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

// POST /api/gmail/emails/:id/reply - Send a reply to an email
router.post('/emails/:id/reply', protect, authorizeRoles('Admin', 'Head'), replyToEmail);

// POST /api/gmail/emails/bulk-assign - Bulk assign multiple emails
router.post('/emails/bulk-assign', protect, authorizeRoles('Admin', 'Head'), bulkAssignEmails);

// DELETE /api/gmail/emails - Clear all emails (protected, Admin only)
router.delete('/emails', protect, authorizeRoles('Admin'), deleteAllEmails);

// DELETE /api/gmail/emails/:id - Delete a single email (protected, Admin/Head only)
router.delete('/emails/:id', protect, authorizeRoles('Admin', 'Head'), deleteSingleEmail);

// GET /api/gmail/emails/:id/attachments/:attachmentId - Download email attachment (protected)
router.get('/emails/:id/attachments/:attachmentId', protect, downloadAttachment);

// GET /api/gmail/status - Get connected Gmail account status (protected)
router.get('/status', protect, getConnectedStatus);

// DELETE /api/gmail/disconnect - Disconnect connected Gmail account (protected)
router.delete('/disconnect', protect, disconnectGmail);

// DELETE /api/gmail/linked-account - Disconnect a specific extra linked Gmail account (Admin only)
router.delete('/linked-account', protect, authorizeRoles('Admin'), disconnectLinkedAccount);

module.exports = router;
