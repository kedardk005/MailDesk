const Task = require('../models/Task');
const Client = require('../models/Client');

/**
 * Ensures a Task document is created/updated in the Task collection whenever an Email is assigned to a user.
 * @param {Object} email - Email mongoose document
 * @param {String} assignedUserId - ID of the assigned user (Employee / Head)
 * @param {String} createdById - ID of user triggering assignment or fetching
 */
const ensureTaskForEmail = async (email, assignedUserId, createdById) => {
  if (!email || !assignedUserId) return null;

  try {
    // Check if task already exists for this email
    let existingTask = await Task.findOne({ linkedEmail: email._id });
    if (existingTask) {
      existingTask.assignedTo = assignedUserId;
      existingTask.status = 'Pending';
      await existingTask.save();
      return existingTask;
    }

    // Attempt to match sender to an existing Client name
    let clientName = 'General Client';
    const clients = await Client.find({});
    if (clients.length > 0) {
      const senderLower = (email.from || '').toLowerCase();
      const matchedClient = clients.find(c => {
        const allEmails = [c.email, ...(c.associatedEmails || [])].filter(Boolean).map(e => e.toLowerCase().trim());
        return allEmails.some(ce => senderLower.includes(ce));
      });
      if (matchedClient) {
        clientName = matchedClient.name;
      } else {
        clientName = clients[0].name;
      }
    }

    // Default deadline 3 days from current date
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 3);

    const titleStr = email.subject && email.subject.trim() 
      ? email.subject.trim() 
      : `Task from Email [${email.matchedKeyword || 'Mail'}]`;

    const cleanBody = email.body 
      ? email.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 1000).trim()
      : '';

    const newTask = new Task({
      title: titleStr,
      description: cleanBody,
      linkedEmail: email._id,
      assignedTo: assignedUserId,
      clientName,
      deadline,
      priority: 'Medium',
      createdBy: createdById || email.fetchedBy || assignedUserId,
      status: 'Pending'
    });

    await newTask.save();
    console.log(`[TASK CREATED FOR EMAIL] Created Task "${newTask.title}" assigned to user ${assignedUserId}`);
    return newTask;
  } catch (err) {
    console.error('[ENSURE TASK ERROR] Failed to create/update task for email:', err);
    return null;
  }
};

module.exports = { ensureTaskForEmail };
