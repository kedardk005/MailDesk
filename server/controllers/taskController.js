const Task = require('../models/Task');
const Email = require('../models/Email');
const Client = require('../models/Client');
const User = require('../models/User');
const { logActivity } = require('../utils/activityLogger');
const { createNotification } = require('../utils/notificationHelper');
const { sendEmail } = require('../utils/emailHelper');

// @desc    Create a new task
// @route   POST /api/tasks
// @access  Private (Admin, Head only)
exports.createTask = async (req, res) => {
  try {
    const { title, description, linkedEmail, assignedTo, clientName, deadline, notes, priority, isRecurring, recurrence } = req.body;

    // Validate required fields
    if (!title || !assignedTo || !clientName || !deadline) {
      return res.status(400).json({ message: 'Title, assignedTo, clientName, and deadline are required.' });
    }

    // Create the task instance
    const task = new Task({
      title: title.trim(),
      description: description ? description.trim() : '',
      linkedEmail: linkedEmail || null,
      assignedTo,
      clientName: clientName.trim(),
      deadline,
      notes: notes ? notes.trim() : '',
      priority: priority || 'Medium',
      createdBy: req.user._id,
      status: 'Pending',
      isRecurring: isRecurring === true || isRecurring === 'true',
      recurrence: isRecurring ? (recurrence || null) : null
    });

    // Save task
    const savedTask = await task.save();

    // If linkedEmail is provided, update that Email document's status to 'assigned' and set assignedTo
    if (linkedEmail) {
      await Email.findByIdAndUpdate(linkedEmail, {
        status: 'assigned',
        assignedTo: assignedTo
      });
    }

    // Populate task details before returning
    const populatedTask = await Task.findById(savedTask._id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from body attachments')
      .populate('createdBy', 'name');

    await logActivity(req.user._id, 'Task Creation', `Created task "${populatedTask.title}" (Assigned to: ${populatedTask.assignedTo?.name || 'N/A'}, Client: ${populatedTask.clientName})`);

    // Send real-time notification to the assignee
    const io = req.app.get('io');
    await createNotification(
      assignedTo,
      `New task assigned: ${populatedTask.title}`,
      io,
      populatedTask._id,
      'task_assigned'
    );

    return res.status(201).json(populatedTask);
  } catch (error) {
    console.error('Error in createTask:', error);
    return res.status(500).json({ message: 'Server error. Failed to create task.' });
  }
};

// @desc    Get all tasks
// @route   GET /api/tasks
// @access  Private (All roles)
exports.getAllTasks = async (req, res) => {
  try {
    let query = {};

    // Filter by role: Employees can only see tasks assigned to them, Heads can only see tasks created by them
    if (req.user.role === 'Employee') {
      query = { assignedTo: req.user._id };
    } else if (req.user.role === 'Head') {
      query = { createdBy: req.user._id };
    }

    const tasks = await Task.find(query)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from body attachments')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 });

    return res.status(200).json(tasks);
  } catch (error) {
    console.error('Error in getAllTasks:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve tasks.' });
  }
};

// @desc    Get single task by ID
// @route   GET /api/tasks/:id
// @access  Private (All roles)
exports.getTaskById = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from body attachments')
      .populate('createdBy', 'name');

    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    // Employees can only access their own tasks
    if (req.user.role === 'Employee' && task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You can only access tasks assigned to you.' });
    }

    // Heads can only access tasks created by them
    if (req.user.role === 'Head' && task.createdBy && task.createdBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You can only access tasks created by you.' });
    }

    return res.status(200).json(task);
  } catch (error) {
    console.error('Error in getTaskById:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve task details.' });
  }
};

// @desc    Update a task
// @route   PUT /api/tasks/:id
// @access  Private (All roles)
exports.updateTask = async (req, res) => {
  try {
    const io = req.app.get('io');
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    // Role checks
    if (req.user.role === 'Employee') {
      // Employees can only update their own tasks
      if (task.assignedTo && task.assignedTo.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Access denied. You can only update your own tasks.' });
      }

      // Employees can only update the status field (specifically from Pending/Late to Completed)
      const { status } = req.body;
      if (!status) {
        return res.status(400).json({ message: 'Status field is required.' });
      }
      if (status !== 'Completed') {
        return res.status(400).json({ message: 'Employees are only allowed to mark a task as Completed.' });
      }

      const wasAlreadyCompleted = task.status === 'Completed';
      task.status = 'Completed';

      if (!wasAlreadyCompleted) {
        // Send completion notification & email alert to task creator (Admin/Head)
        try {
          const creator = await User.findById(task.createdBy);
          if (creator) {
            // 1. App Notification
            await createNotification(
              task.createdBy,
              `Task completed: ${task.title} by ${req.user.name}`,
              io
            );
            // 2. Email alert
            const emailSubject = `Task Completed: ${task.title}`;
            const emailBody = `Employee ${req.user.name} has marked the task "${task.title}" as completed on ${new Date().toLocaleString()}.`;
            await sendEmail(creator.email, emailSubject, emailBody);
          }
        } catch (err) {
          console.error('Failed to send task completion alerts:', err);
        }

        // If this is a recurring task, spawn the next occurrence
        const { spawnNextRecurrence } = require('../utils/recurrenceHelper');
        await spawnNextRecurrence(task, io);
      }
    } else {
      // For Head, check if they created the task
      if (req.user.role === 'Head' && task.createdBy && task.createdBy.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'Access denied. You can only update tasks created by you.' });
      }

      // Admin/Head can update all fields
      const { title, description, assignedTo, clientName, deadline, notes, status, priority, isRecurring, recurrence } = req.body;

      const wasAlreadyCompleted = task.status === 'Completed';

      if (title !== undefined) task.title = title.trim();
      if (description !== undefined) task.description = description.trim();
      if (clientName !== undefined) task.clientName = clientName.trim();
      if (deadline !== undefined) task.deadline = deadline;
      if (notes !== undefined) task.notes = notes.trim();
      if (status !== undefined) task.status = status;
      if (priority !== undefined) task.priority = priority;
      if (isRecurring !== undefined) task.isRecurring = isRecurring;
      if (recurrence !== undefined) task.recurrence = recurrence || null;

      // Handle changes to task assignee
      if (assignedTo !== undefined && assignedTo !== task.assignedTo?.toString()) {
        task.assignedTo = assignedTo || null;
        // If there's a linked email, keep the email's assignee in sync
        if (task.linkedEmail) {
          await Email.findByIdAndUpdate(task.linkedEmail, {
            assignedTo: assignedTo || null,
            status: assignedTo ? 'assigned' : 'unassigned'
          });
        }
      }

      // If status changed to Completed and was not already Completed, spawn next recurrence
      if (status === 'Completed' && !wasAlreadyCompleted) {
        const { spawnNextRecurrence } = require('../utils/recurrenceHelper');
        await spawnNextRecurrence(task, io);
      }
    }

    const updatedTask = await task.save();

    // Populate and return updated task details
    const populatedTask = await Task.findById(updatedTask._id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from body attachments')
      .populate('createdBy', 'name');

    await logActivity(req.user._id, 'Task Update', `Updated task "${populatedTask.title}" (Status: ${populatedTask.status}, Assigned to: ${populatedTask.assignedTo?.name || 'N/A'})`);

    return res.status(200).json(populatedTask);
  } catch (error) {
    console.error('Error in updateTask:', error);
    return res.status(500).json({ message: 'Server error. Failed to update task.' });
  }
};

// @desc    Delete a task
// @route   DELETE /api/tasks/:id
// @access  Private (Admin, Head only)
exports.deleteTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    // For Head, check if they created the task
    if (req.user.role === 'Head' && task.createdBy && task.createdBy.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You can only delete tasks created by you.' });
    }

    // If task has a linked email, reset its status to unassigned and clear assignee
    if (task.linkedEmail) {
      await Email.findByIdAndUpdate(task.linkedEmail, {
        status: 'unassigned',
        assignedTo: null
      });
    }

    await Task.findByIdAndDelete(req.params.id);

    await logActivity(req.user._id, 'Task Deletion', `Deleted task "${task.title}" (Client: ${task.clientName})`);

    return res.status(200).json({ message: 'Task deleted successfully.' });
  } catch (error) {
    console.error('Error in deleteTask:', error);
    return res.status(500).json({ message: 'Server error. Failed to delete task.' });
  }
};

// @desc    Get all clients
// @route   GET /api/tasks/clients
// @access  Private (All roles)
exports.getClients = async (req, res) => {
  try {
    const clients = await Client.find({}).sort({ name: 1 });
    return res.status(200).json(clients);
  } catch (error) {
    console.error('Error in getClients:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve clients.' });
  }
};

// @desc    Perform bulk actions on multiple tasks
// @route   POST /api/tasks/bulk
// @access  Private (Admin, Head only)
exports.bulkTaskAction = async (req, res) => {
  try {
    const { action, taskIds, value } = req.body;

    if (!action || !taskIds || !Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ message: 'action and taskIds array are required.' });
    }

    const validActions = ['delete', 'status', 'reassign'];
    if (!validActions.includes(action)) {
      return res.status(400).json({ message: `Invalid action. Must be one of: ${validActions.join(', ')}` });
    }

    // For Head role, make sure they created all tasks they are trying to perform bulk action on
    if (req.user.role === 'Head') {
      const tasks = await Task.find({ _id: { $in: taskIds } });
      const ownedTasksCount = tasks.filter(t => t.createdBy && t.createdBy.toString() === req.user._id.toString()).length;
      if (ownedTasksCount !== tasks.length) {
        return res.status(403).json({ message: 'Access denied. You can only perform bulk actions on tasks created by you.' });
      }
    }

    let result = {};

    if (action === 'delete') {
      // Reset linked emails before deleting tasks
      const tasks = await Task.find({ _id: { $in: taskIds } });
      const linkedEmailIds = tasks.filter(t => t.linkedEmail).map(t => t.linkedEmail);
      if (linkedEmailIds.length > 0) {
        await Email.updateMany(
          { _id: { $in: linkedEmailIds } },
          { $set: { status: 'unassigned', assignedTo: null } }
        );
      }
      await Task.deleteMany({ _id: { $in: taskIds } });
      result = { deleted: taskIds.length };
      await logActivity(req.user._id, 'Bulk Task Delete', `Bulk deleted ${taskIds.length} tasks`);
    }

    else if (action === 'status') {
      const allowedStatuses = ['Pending', 'Completed', 'Late'];
      if (!value || !allowedStatuses.includes(value)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` });
      }
      await Task.updateMany({ _id: { $in: taskIds } }, { $set: { status: value } });
      result = { updated: taskIds.length, status: value };
      await logActivity(req.user._id, 'Bulk Task Status', `Bulk set ${taskIds.length} tasks to "${value}"`);
    }

    else if (action === 'reassign') {
      if (!value) return res.status(400).json({ message: 'value (userId) is required for reassign action.' });
      const targetUser = await User.findById(value);
      if (!targetUser) return res.status(404).json({ message: 'Target user not found.' });
      await Task.updateMany({ _id: { $in: taskIds } }, { $set: { assignedTo: value } });
      // Sync linked email assignments too
      const tasks = await Task.find({ _id: { $in: taskIds }, linkedEmail: { $ne: null } });
      const linkedEmailIds = tasks.map(t => t.linkedEmail);
      if (linkedEmailIds.length > 0) {
        await Email.updateMany({ _id: { $in: linkedEmailIds } }, { $set: { assignedTo: value, status: 'assigned' } });
      }
      result = { updated: taskIds.length, assignedTo: targetUser.name };
      await logActivity(req.user._id, 'Bulk Task Reassign', `Bulk reassigned ${taskIds.length} tasks to ${targetUser.name}`);
    }

    return res.status(200).json({ message: 'Bulk action completed.', result });
  } catch (error) {
    console.error('Error in bulkTaskAction:', error);
    return res.status(500).json({ message: 'Server error. Failed to perform bulk action.' });
  }
};

