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
    const { title, description, linkedEmail, assignedTo, clientName, deadline, notes } = req.body;

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
      createdBy: req.user._id,
      status: 'Pending'
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
      .populate('linkedEmail', 'subject')
      .populate('createdBy', 'name');

    await logActivity(req.user._id, 'Task Creation', `Created task "${populatedTask.title}" (Assigned to: ${populatedTask.assignedTo?.name || 'N/A'}, Client: ${populatedTask.clientName})`);

    // Send real-time notification to the assignee
    const io = req.app.get('io');
    await createNotification(
      assignedTo,
      `New task assigned: ${populatedTask.title}`,
      io
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

    // Filter by role: Employees can only see tasks assigned to them
    if (req.user.role === 'Employee') {
      query = { assignedTo: req.user._id };
    }

    const tasks = await Task.find(query)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from body')
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
      .populate('linkedEmail', 'subject from body')
      .populate('createdBy', 'name');

    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    // Employees can only access their own tasks
    if (req.user.role === 'Employee' && task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You can only access tasks assigned to you.' });
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
      if (status && status !== 'Completed') {
        return res.status(400).json({ message: 'Employees are only allowed to mark a task as Completed.' });
      }

      const wasAlreadyCompleted = task.status === 'Completed';
      task.status = 'Completed';

      if (!wasAlreadyCompleted) {
        // Send completion notification & email alert to task creator (Admin/Head)
        try {
          const creator = await User.findById(task.createdBy);
          if (creator) {
            const io = req.app.get('io');
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
      }
    } else {
      // Admin/Head can update all fields
      const { title, description, assignedTo, clientName, deadline, notes, status } = req.body;

      if (title !== undefined) task.title = title.trim();
      if (description !== undefined) task.description = description.trim();
      if (clientName !== undefined) task.clientName = clientName.trim();
      if (deadline !== undefined) task.deadline = deadline;
      if (notes !== undefined) task.notes = notes.trim();
      if (status !== undefined) task.status = status;

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
    }

    const updatedTask = await task.save();

    // Populate and return updated task details
    const populatedTask = await Task.findById(updatedTask._id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from')
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
