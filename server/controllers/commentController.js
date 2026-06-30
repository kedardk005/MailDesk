const TaskComment = require('../models/TaskComment');
const Task = require('../models/Task');
const { createNotification } = require('../utils/notificationHelper');
const { logActivity } = require('../utils/activityLogger');

// @desc    Get all comments for a task
// @route   GET /api/tasks/:id/comments
// @access  Private (All roles)
exports.getComments = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found.' });

    // Employees can only see comments on their own tasks
    if (req.user.role === 'Employee' && task.assignedTo?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const comments = await TaskComment.find({ taskId: req.params.id })
      .populate('author', 'name role')
      .sort({ createdAt: 1 });

    return res.status(200).json(comments);
  } catch (error) {
    console.error('Error in getComments:', error);
    return res.status(500).json({ message: 'Server error. Failed to load comments.' });
  }
};

// @desc    Add a comment to a task
// @route   POST /api/tasks/:id/comments
// @access  Private (All roles)
exports.addComment = async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ message: 'Comment message is required.' });
    }

    const task = await Task.findById(req.params.id)
      .populate('assignedTo', 'name')
      .populate('createdBy', 'name');

    if (!task) return res.status(404).json({ message: 'Task not found.' });

    // Employees can only comment on their own tasks
    if (req.user.role === 'Employee' && task.assignedTo?._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const comment = new TaskComment({
      taskId: req.params.id,
      author: req.user._id,
      message: message.trim()
    });

    const saved = await comment.save();
    const populated = await TaskComment.findById(saved._id).populate('author', 'name role');

    // Notify task assignee (if commenter is not the assignee)
    const io = req.app.get('io');
    if (task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
      await createNotification(
        task.assignedTo._id,
        `New comment on task "${task.title}" by ${req.user.name}`,
        io,
        task._id,
        'task_comment'
      );
    }
    // Notify task creator (if commenter is not the creator)
    if (task.createdBy && task.createdBy._id.toString() !== req.user._id.toString()) {
      await createNotification(
        task.createdBy._id,
        `New comment on task "${task.title}" by ${req.user.name}`,
        io,
        task._id,
        'task_comment'
      );
    }

    await logActivity(req.user._id, 'Task Comment', `Commented on task "${task.title}"`);

    // Emit real-time comment event to all users viewing this task
    if (io) {
      io.emit(`task:${req.params.id}:comment`, populated);
    }

    return res.status(201).json(populated);
  } catch (error) {
    console.error('Error in addComment:', error);
    return res.status(500).json({ message: 'Server error. Failed to post comment.' });
  }
};

// @desc    Delete a comment
// @route   DELETE /api/tasks/:taskId/comments/:commentId
// @access  Private (Admin/Head can delete any; Employee can delete own only)
exports.deleteComment = async (req, res) => {
  try {
    const comment = await TaskComment.findById(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found.' });

    const isOwner = comment.author.toString() === req.user._id.toString();
    const isAdminOrHead = req.user.role === 'Admin' || req.user.role === 'Head';

    if (!isOwner && !isAdminOrHead) {
      return res.status(403).json({ message: 'Access denied. You can only delete your own comments.' });
    }

    await TaskComment.findByIdAndDelete(req.params.commentId);

    const io = req.app.get('io');
    if (io) {
      io.emit(`task:${req.params.taskId}:commentDeleted`, { commentId: req.params.commentId });
    }

    return res.status(200).json({ message: 'Comment deleted.' });
  } catch (error) {
    console.error('Error in deleteComment:', error);
    return res.status(500).json({ message: 'Server error. Failed to delete comment.' });
  }
};
