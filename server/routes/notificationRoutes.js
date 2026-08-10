const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead
} = require('../controllers/notificationController');
const { guardObjectIdParams } = require('../middleware/objectIdParam');

// All routes require authentication
router.use(protect);

// H-10. '/read-all' is a literal path registered before '/:id/read', so it is
// never seen as an id.
guardObjectIdParams(router, 'notification', ['id']);

// GET /api/notifications - Get all notifications for logged-in user
router.get('/', getNotifications);

// GET /api/notifications/unread-count - Bell badge count, without downloading
// the list to count it client-side.
router.get('/unread-count', getUnreadCount);

// PUT /api/notifications/read-all - Mark all notifications as read (MUST be registered before dynamic /:id/read)
router.put('/read-all', markAllAsRead);

// PUT /api/notifications/:id/read - Mark a single notification as read
router.put('/:id/read', markAsRead);

module.exports = router;
