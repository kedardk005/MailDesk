const TaskComment = require('../models/TaskComment');
const Task = require('../models/Task');
const { createNotification } = require('../utils/notificationHelper');
const { logActivity } = require('../utils/activityLogger');
const { parseListParams, paginate, listResponse } = require('../utils/paginate');
const { log } = require('../utils/logger');

const logger = log('comments');

const COMMENT_SORT_FIELDS = ['createdAt'];

// @desc    Get all comments for a task
// @route   GET /api/tasks/:id/comments
// @access  Private (All roles)
exports.getComments = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).select('_id assignedTo createdBy').lean();
    if (!task) return res.status(404).json({ message: 'Task not found.' });

    // Employees can only see comments on their own tasks
    if (req.user.role === 'Employee' && task.assignedTo?.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Heads can see comments on tasks created by or assigned to them
    if (req.user.role === 'Head') {
      const isCreator = task.createdBy && task.createdBy.toString() === req.user._id.toString();
      const isAssignee = task.assignedTo && task.assignedTo.toString() === req.user._id.toString();
      if (!isCreator && !isAssignee) {
        return res.status(403).json({ message: 'Access denied.' });
      }
    }

    // Comments read oldest-first, so the default sort is ASCENDING here. The
    // { taskId: 1, createdAt: 1 } compound index covers filter + sort.
    const params = parseListParams(req, {
      sortWhitelist: COMMENT_SORT_FIELDS,
      defaultSort: 'createdAt',
      defaultLimit: 50
    });

    const { data, pagination } = await paginate(
      TaskComment,
      { taskId: req.params.id },
      params,
      {
        select: 'taskId author message createdAt',
        populate: [{ path: 'author', select: 'name role' }]
      }
    );

    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getComments failed');
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
      .select('_id title assignedTo createdBy')
      .populate('assignedTo', 'name')
      .populate('createdBy', 'name');

    if (!task) return res.status(404).json({ message: 'Task not found.' });

    // Employees can only comment on their own tasks
    if (req.user.role === 'Employee' && task.assignedTo?._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Heads can comment on tasks created by or assigned to them
    if (req.user.role === 'Head') {
      const isCreator = task.createdBy && task.createdBy._id.toString() === req.user._id.toString();
      const isAssignee = task.assignedTo && task.assignedTo._id.toString() === req.user._id.toString();
      if (!isCreator && !isAssignee) {
        return res.status(403).json({ message: 'Access denied.' });
      }
    }

    const comment = new TaskComment({
      taskId: req.params.id,
      author: req.user._id,
      message: message.trim()
    });

    const saved = await comment.save();
    const populated = await TaskComment.findById(saved._id).populate('author', 'name role');

    // Both notifications are independent writes, so they go out in parallel
    // instead of one sequential round-trip after the other.
    const io = req.app.get('io');
    const notificationText = `New comment on task "${task.title}" by ${req.user.name}`;
    const notifications = [];
    if (task.assignedTo && task.assignedTo._id.toString() !== req.user._id.toString()) {
      notifications.push(createNotification(task.assignedTo._id, notificationText, io, task._id, 'task_comment'));
    }
    if (task.createdBy && task.createdBy._id.toString() !== req.user._id.toString()) {
      notifications.push(createNotification(task.createdBy._id, notificationText, io, task._id, 'task_comment'));
    }
    await Promise.all(notifications);

    await logActivity(req.user._id, 'Task Comment', `Commented on task "${task.title}"`);

    // Emit real-time comment event scoped to task assignee and creator rooms
    if (io) {
      const eventName = `task:${req.params.id}:comment`;
      if (task.assignedTo) {
        io.to(task.assignedTo._id.toString()).emit(eventName, populated);
      }
      if (task.createdBy && (!task.assignedTo || task.createdBy._id.toString() !== task.assignedTo._id.toString())) {
        io.to(task.createdBy._id.toString()).emit(eventName, populated);
      }
    }

    return res.status(201).json(populated);
  } catch (error) {
    logger.error({ err: error.message }, 'addComment failed');
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

    // Bind the child to the parent BEFORE any authorization logic.
    //
    // Previously the comment was loaded by :commentId but authorization was
    // evaluated against Task.findById(:id) — two unrelated documents. A Head
    // could create one throwaway task they own and then delete ANY comment in
    // the system through it (classic confused deputy).
    if (!comment.taskId || comment.taskId.toString() !== req.params.id) {
      return res.status(404).json({ message: 'Comment not found.' });
    }

    // Authorize against the comment's OWN task.
    const task = await Task.findById(comment.taskId).select('_id title assignedTo createdBy').lean();
    if (!task) return res.status(404).json({ message: 'Task not found.' });

    const userId = req.user._id.toString();
    const isOwner = comment.author.toString() === userId;
    const isCreator = task.createdBy && task.createdBy.toString() === userId;
    const isAssignee = task.assignedTo && task.assignedTo.toString() === userId;

    let isAuthorized = false;
    if (req.user.role === 'Admin') {
      isAuthorized = true;
    } else if (req.user.role === 'Head') {
      // Heads can delete their own comments on a task they can see, and any
      // comment on a task they created.
      isAuthorized = isCreator || (isOwner && isAssignee);
    } else {
      // Employees may delete only their own comment, and only while the task is
      // still assigned to them.
      isAuthorized = isOwner && isAssignee;
    }

    if (!isAuthorized) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    await TaskComment.findByIdAndDelete(req.params.commentId);

    await logActivity(req.user._id, 'Task Comment Delete', `Deleted a comment on task "${task.title}"`);

    const io = req.app.get('io');
    if (io) {
      // Scope event to relevant user rooms
      const eventName = `task:${req.params.id}:commentDeleted`;
      const eventData = { commentId: req.params.commentId };
      if (task?.assignedTo) {
        io.to(task.assignedTo.toString()).emit(eventName, eventData);
      }
      if (task?.createdBy) {
        io.to(task.createdBy.toString()).emit(eventName, eventData);
      }
    }

    return res.status(200).json({ message: 'Comment deleted.' });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteComment failed');
    return res.status(500).json({ message: 'Server error. Failed to delete comment.' });
  }
};
