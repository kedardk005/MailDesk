const cron = require('node-cron');
const Task = require('../models/Task');
const User = require('../models/User');
const { createNotification } = require('./notificationHelper');

/**
 * Initializes cron jobs for task deadline tracking
 * @param {Object} io - Socket.io server instance
 */
const startCronJobs = (io) => {
  console.log('[CRON] Initializing workspace cron scheduler...');

  // Schedule to run every minute
  cron.schedule('* * * * *', async () => {
    try {
      console.log('[CRON] Checking for pending tasks past their deadline...');

      const now = new Date();
      // Find all tasks where status is 'Pending' AND deadline is in the past
      const overdueTasks = await Task.find({
        status: 'Pending',
        deadline: { $lt: now }
      }).populate('assignedTo', 'name');

      if (overdueTasks.length === 0) {
        console.log('[CRON] No overdue tasks found.');
        return;
      }

      console.log(`[CRON] Found ${overdueTasks.length} overdue tasks. Updating statuses to 'Late'...`);

      // Fetch all Head and Admin users to notify them
      const supervisors = await User.find({
        role: { $in: ['Admin', 'Head'] }
      });

      let updatedCount = 0;

      for (const task of overdueTasks) {
        // Update task status
        task.status = 'Late';
        await task.save();
        updatedCount++;

        // 1. Notify the assigned employee
        if (task.assignedTo) {
          await createNotification(
            task.assignedTo._id,
            `Your task is overdue: ${task.title}`,
            io
          );
        }

        // 2. Notify all Admins and Department Heads
        const employeeName = task.assignedTo ? task.assignedTo.name : 'Unassigned';
        const staffAlertMessage = `Task overdue: ${task.title} assigned to ${employeeName}`;

        for (const supervisor of supervisors) {
          await createNotification(
            supervisor._id,
            staffAlertMessage,
            io
          );
        }
      }

      console.log(`[CRON SUCCESS] Processed and marked ${updatedCount} tasks as 'Late'.`);
    } catch (error) {
      console.error('[CRON ERROR] Overdue task evaluation failed:', error);
    }
  });

  // Schedule to run every 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    try {
      console.log('[CRON] Starting automatic email synchronization for connected users...');
      
      // Find all users who have a connected Gmail account
      const users = await User.find({
        gmailAccessToken: { $ne: null, $ne: "" }
      });

      if (users.length === 0) {
        console.log('[CRON] No users with connected Gmail accounts found for auto-sync.');
        return;
      }

      // Dynamic import to avoid circular dependency/load order issues
      const { syncUserEmails } = require('../controllers/gmailController');

      for (const user of users) {
        try {
          console.log(`[CRON] Auto-syncing emails for user: ${user.email}`);
          const count = await syncUserEmails(user, false);
          console.log(`[CRON] Auto-sync complete. ${count} new emails fetched for user ${user.email}.`);
        } catch (syncError) {
          console.error(`[CRON ERROR] Failed to auto-sync emails for user ${user.email}:`, syncError);
        }
      }
    } catch (error) {
      console.error('[CRON ERROR] Automatic email sync cron job failed:', error);
    }
  });
};

module.exports = { startCronJobs };
