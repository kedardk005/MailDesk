const Notification = require('../models/Notification');
const { log } = require('./logger');

const logger = log('notification');

/**
 * In-app notification delivery.
 *
 * WAVE2 gap S-12: every write here is now gated on the recipient's
 * `notificationPreferences.inApp`. `utils/notificationPrefs.js` fails OPEN — a
 * lookup failure delivers — and an unrecognised `type` is treated as `system`,
 * which is on by default, so nothing can be silently swallowed.
 *
 * A suppressed in-app notification is NOT written to the database at all: an
 * unread badge for a notification the user asked not to receive is the exact
 * thing the toggle exists to prevent.
 *
 * Required lazily to avoid a require cycle
 * (notificationPrefs -> models/User -> ... ) at module load.
 * @returns {Object} the notificationPrefs module
 */
const prefs = () => require('./notificationPrefs');

/**
 * Creates a notification in the database and emits a real-time event via Socket.io.
 * @param {String} userId - The user ID to receive the notification
 * @param {String} message - The notification message
 * @param {Object} io - The socket.io server instance
 * @param {String} [taskId]
 * @param {String} [type] - one of User.NOTIFICATION_EVENTS; governs suppression
 * @returns {Promise<Object|null>} the notification, or null when suppressed/failed
 */
const createNotification = async (userId, message, io, taskId = null, type = null) => {
  try {
    if (!userId) {
      logger.warn('createNotification called without a userId');
      return null;
    }

    if (type && !(await prefs().shouldDeliver(userId, 'inApp', type))) {
      logger.debug({ userId: String(userId), type }, 'in-app notification suppressed by preference');
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
      logger.debug({ room, type, taskId: taskId ? String(taskId) : null }, 'newNotification emitted');
    }

    return savedNotification;
  } catch (error) {
    logger.error({ err: error.message }, 'createNotification failed');
    return null;
  }
};

/**
 * Creates many notifications in a SINGLE insertMany and emits one socket event
 * per created row. Used by the overdue cron, which previously issued one
 * sequential save() per task per supervisor.
 *
 * Preference checks run in parallel across recipients before the insert, so the
 * batch path costs one cached lookup per recipient rather than one per row.
 *
 * @param {Array<{userId: String, message: String, taskId?: String, type?: String}>} entries
 * @param {Object} io - The socket.io server instance
 * @returns {Promise<Array>} the created notifications
 */
const createNotifications = async (entries, io) => {
  try {
    const valid = (entries || []).filter((e) => e && e.userId && e.message);
    if (valid.length === 0) return [];

    const { shouldDeliver } = prefs();
    const allowed = await Promise.all(
      valid.map((e) => (e.type ? shouldDeliver(e.userId, 'inApp', e.type) : Promise.resolve(true)))
    );

    const deliverable = valid.filter((_, i) => allowed[i]);
    if (deliverable.length === 0) {
      logger.debug({ requested: valid.length }, 'all batched notifications suppressed by preference');
      return [];
    }

    const docs = deliverable.map((e) => ({
      userId: e.userId,
      message: e.message,
      read: false,
      taskId: e.taskId || null,
      type: e.type || null
    }));

    const saved = await Notification.insertMany(docs);

    if (io) {
      for (const notification of saved) {
        io.to(notification.userId.toString()).emit('newNotification', notification);
      }
      logger.debug({ count: saved.length, suppressed: valid.length - deliverable.length },
        'batched notifications emitted');
    }

    return saved;
  } catch (error) {
    logger.error({ err: error.message }, 'createNotifications failed');
    return [];
  }
};

module.exports = { createNotification, createNotifications };
