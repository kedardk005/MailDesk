const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
  getNotifications,
  markAsRead,
  markAllAsRead
} = require('../controllers/notificationController');

// All routes require authentication
router.use(protect);

// GET /api/notifications - Get all notifications for logged-in user
router.get('/', getNotifications);

// PUT /api/notifications/read-all - Mark all notifications as read (MUST be registered before dynamic /:id/read)
router.put('/read-all', markAllAsRead);

// PUT /api/notifications/:id/read - Mark a single notification as read
router.put('/:id/read', markAsRead);

module.exports = router;
