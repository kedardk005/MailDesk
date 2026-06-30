const Notification = require('../models/Notification');

/**
 * Creates a notification in the database and emits a real-time event via Socket.io.
 * @param {String} userId - The user ID to receive the notification
 * @param {String} message - The notification message
 * @param {Object} io - The socket.io server instance
 */
const createNotification = async (userId, message, io, taskId = null, type = null) => {
  try {
    if (!userId) {
      console.warn('createNotification: userId is missing.');
      return null;
    }

    const notification = new Notification({
      userId,
      message,
      read: false,
      taskId,
      type
    });

    const savedNotification = await notification.save();

    if (io) {
      const room = userId.toString();
      io.to(room).emit('newNotification', savedNotification);
      console.log(`[SOCKET EMITTED] newNotification to user room ${room}: "${message}" (taskId: ${taskId}, type: ${type})`);
    }

    return savedNotification;
  } catch (error) {
    console.error('Error in createNotification:', error);
    return null;
  }
};

module.exports = { createNotification };
