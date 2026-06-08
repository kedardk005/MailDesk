const Notification = require('../models/Notification');

// @desc    Get all notifications for logged-in user
// @route   GET /api/notifications
// @access  Private
exports.getNotifications = async (req, res) => {
  try {
    const notifications = await Notification.find({ userId: req.user._id })
      .sort({ createdAt: -1 });

    return res.status(200).json(notifications);
  } catch (error) {
    console.error('Error in getNotifications:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve notifications.' });
  }
};

// @desc    Mark a single notification as read
// @route   PUT /api/notifications/:id/read
// @access  Private
exports.markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found.' });
    }

    // Verify ownership
    if (notification.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You do not own this notification.' });
    }

    notification.read = true;
    await notification.save();

    return res.status(200).json(notification);
  } catch (error) {
    console.error('Error in markAsRead:', error);
    return res.status(500).json({ message: 'Server error. Failed to update notification.' });
  }
};

// @desc    Mark all notifications for user as read
// @route   PUT /api/notifications/read-all
// @access  Private
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true }
    );

    return res.status(200).json({ message: 'All notifications marked as read.' });
  } catch (error) {
    console.error('Error in markAllAsRead:', error);
    return res.status(500).json({ message: 'Server error. Failed to update notifications.' });
  }
};
