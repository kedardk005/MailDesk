const ActivityLog = require('../models/ActivityLog');

const logActivity = async (userId, action, details) => {
  try {
    if (!userId) {
      console.warn('activityLogger: userId is missing for action:', action);
      return;
    }
    await ActivityLog.create({
      userId,
      action,
      details
    });
    console.log(`[ACTIVITY LOGGED] User: ${userId}, Action: ${action}, Details: ${details}`);
  } catch (error) {
    console.error('Failed to log activity:', error);
  }
};

module.exports = { logActivity };
