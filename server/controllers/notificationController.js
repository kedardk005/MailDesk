const Notification = require('../models/Notification');
const { parseListParams, paginate, listResponse, firstString } = require('../utils/paginate');
const { log } = require('../utils/logger');

const logger = log('notifications');

const NOTIFICATION_SORT_FIELDS = ['createdAt', 'read'];

// @desc    Get notifications for the logged-in user (paginated)
// @route   GET /api/notifications
// @access  Private
exports.getNotifications = async (req, res) => {
  try {
    // This was unbounded, and the overdue cron used to create one notification
    // per overdue task PER SUPERVISOR every single minute — a single stuck task
    // generated 1,440 rows/day/supervisor, so the bell-icon endpoint was
    // returning five figures of rows within a week.
    const params = parseListParams(req, {
      sortWhitelist: NOTIFICATION_SORT_FIELDS,
      defaultSort: '-createdAt',
      defaultLimit: 30
    });

    const filter = { userId: req.user._id };

    const unread = firstString(req.query.unread, 10);
    if (unread === 'true') filter.read = false;

    const { data, pagination } = await paginate(Notification, filter, params, {
      select: 'userId message read taskId type createdAt'
    });

    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getNotifications failed');
    return res.status(500).json({ message: 'Server error. Failed to retrieve notifications.' });
  }
};

// @desc    Unread notification count for the bell badge
// @route   GET /api/notifications/unread-count
// @access  Private
exports.getUnreadCount = async (req, res) => {
  try {
    // Covered by the existing { userId: 1, read: 1 } index, so the badge no
    // longer requires downloading the notification list to count it.
    const count = await Notification.countDocuments({ userId: req.user._id, read: false });
    return res.status(200).json({ count });
  } catch (error) {
    logger.error({ err: error.message }, 'getUnreadCount failed');
    return res.status(500).json({ message: 'Server error. Failed to count notifications.' });
  }
};

// @desc    Mark a single notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
exports.markAsRead = async (req, res) => {
  try {
    // Ownership is enforced INSIDE the query, so the read-then-check race is
    // gone and there is one round-trip instead of two.
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { $set: { read: true } },
      { new: true }
    ).lean();

    if (!notification) {
      // Deliberately does not distinguish "missing" from "not yours".
      return res.status(404).json({ message: 'Notification not found.' });
    }

    return res.status(200).json(notification);
  } catch (error) {
    logger.error({ err: error.message }, 'markAsRead failed');
    return res.status(500).json({ message: 'Server error. Failed to update notification.' });
  }
};

// @desc    Mark all notifications for user as read
// @route   PUT /api/notifications/read-all
// @access  Private
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany({ userId: req.user._id, read: false }, { $set: { read: true } });
    return res.status(200).json({ message: 'All notifications marked as read.' });
  } catch (error) {
    logger.error({ err: error.message }, 'markAllAsRead failed');
    return res.status(500).json({ message: 'Server error. Failed to update notifications.' });
  }
};
