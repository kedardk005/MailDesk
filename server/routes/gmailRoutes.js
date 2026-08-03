const express = require('express');
const router = express.Router();
const {
  getAuthUrl,
  handleOAuthCallback,
  fetchEmails,
  getEmails,
  deleteEmailsDispatch,
  deleteSingleEmail,
  markEmailRead,
  bulkMarkEmailsRead,
  getConnectedStatus,
  disconnectGmail,
  disconnectLinkedAccount,
  replyToEmail,
  bulkAssignEmails,
  downloadAttachment,
  deduplicateGmailConnections,
  getEmailById,
  getSyncJobStatus,
  getThreads,
  getThreadById
} = require('../controllers/gmailController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const {
  replyToEmailSchema,
  bulkAssignEmailsSchema,
  disconnectLinkedAccountSchema
} = require('../middleware/schemas');

// GET /api/gmail/auth-url - Generate Google OAuth URL (protected, Admin/Head only)
router.get('/auth-url', protect, authorizeRoles('Admin', 'Head'), getAuthUrl);

// GET /api/gmail/oauth/callback - Google redirect target (public callback)
router.get('/oauth/callback', handleOAuthCallback);

// POST /api/gmail/fetch - QUEUES a Gmail sync and returns 202 with a jobId.
// The sync used to run inline and could hold the request open for minutes.
router.post('/fetch', protect, authorizeRoles('Admin', 'Head'), fetchEmails);

// GET /api/gmail/sync/:jobId - Poll the status of a queued sync
router.get('/sync/:jobId', protect, authorizeRoles('Admin', 'Head'), getSyncJobStatus);

// GET /api/gmail/emails - Paginated email list (see docs/audits/API-LIST-CONTRACT.md).
// Carries `snippet`, never `body`. Each row carries `isRead` for the caller.
router.get('/emails', protect, authorizeRoles('Admin', 'Head'), getEmails);

// GET /api/gmail/threads - F-1 conversation list, one row per thread.
// Same role gate and the same ownership scoping as GET /api/gmail/emails.
// `GET /api/gmail/emails?group=thread` delegates here, so the client's
// Conversations/Messages toggle can use either spelling.
router.get('/threads', protect, authorizeRoles('Admin', 'Head'), getThreads);

// GET /api/gmail/threads/:threadId - ordered messages INCLUDING bodies.
// All roles, gated per message by the same object-level check as
// GET /api/gmail/emails/:id.
router.get('/threads/:threadId', protect, getThreadById);

// PATCH /api/gmail/emails/read - Bulk mark read/unread for the calling user.
// MUST be registered before '/emails/:id' so the literal 'read' segment is not
// captured as an email id.
router.patch('/emails/read', protect, bulkMarkEmailsRead);

// GET /api/gmail/emails/:id - Single email INCLUDING its body. Registered after
// the more specific /emails routes so it cannot shadow them.
router.get('/emails/:id', protect, getEmailById);

// PATCH /api/gmail/emails/:id/read - Mark one email read/unread for the caller.
// All roles: read state is per-user, so an Employee marks their own copy read.
router.patch('/emails/:id/read', protect, markEmailRead);

// POST /api/gmail/emails/:id/reply - Send a reply to an email
router.post('/emails/:id/reply', protect, authorizeRoles('Admin', 'Head'), validate(replyToEmailSchema), replyToEmail);

// POST /api/gmail/emails/bulk-assign - Bulk assign multiple emails
router.post('/emails/bulk-assign', protect, authorizeRoles('Admin', 'Head'), validate(bulkAssignEmailsSchema), bulkAssignEmails);

// DELETE /api/gmail/emails - two behaviours on one URL (WAVE2 gap S-15):
//   body { "ids": [...] } -> ownership-scoped bulk soft-delete  (Admin, Head)
//   body absent           -> clear the whole inbox              (Admin only,
//                            enforced inside deleteEmailsDispatch)
// The role gate is widened here and re-narrowed in the controller so the
// pre-existing "clear all" contract is unchanged for non-Admins.
router.delete('/emails', protect, authorizeRoles('Admin', 'Head'), deleteEmailsDispatch);

// DELETE /api/gmail/emails/:id - Delete a single email (protected, Admin/Head only)
router.delete('/emails/:id', protect, authorizeRoles('Admin', 'Head'), deleteSingleEmail);

// GET /api/gmail/emails/:id/attachments/:attachmentId - Download email attachment (protected)
router.get('/emails/:id/attachments/:attachmentId', protect, downloadAttachment);

// GET /api/gmail/status - Get connected Gmail account status (protected)
router.get('/status', protect, getConnectedStatus);

// DELETE /api/gmail/disconnect - Disconnect connected Gmail account (protected)
router.delete('/disconnect', protect, disconnectGmail);

// POST /api/gmail/deduplicate - Explicitly de-duplicate workspace Gmail connections (Admin only).
// Body { "apply": true } performs the write; omitted/false performs a dry run.
// This replaces the implicit sweep that used to run on every GET /api/gmail/status.
router.post('/deduplicate', protect, authorizeRoles('Admin'), deduplicateGmailConnections);

// DELETE /api/gmail/linked-account - Disconnect a linked Gmail account.
//
// WAVE2 gap S-11: this was Admin-only while GET /api/gmail/status returns
// linked accounts to Heads as well, so a Head could see an account they were
// forbidden to disconnect. The controller already scopes correctly — a
// non-Admin can only ever target `req.user._id`, and the `userId` body field is
// honoured for Admins only — so widening the gate grants a Head nothing beyond
// their own mailboxes.
router.delete('/linked-account', protect, authorizeRoles('Admin', 'Head'), validate(disconnectLinkedAccountSchema), disconnectLinkedAccount);

module.exports = router;
