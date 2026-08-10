const Task = require('../models/Task');
const Email = require('../models/Email');
const Client = require('../models/Client');
const User = require('../models/User');
const { logActivity } = require('../utils/activityLogger');
const { createNotification } = require('../utils/notificationHelper');
const { sendEmail } = require('../utils/emailHelper');
const { sendTaskAssignedEmail, sendTasksAssignedEmail } = require('../utils/taskMailer');
const { escapeRegex } = require('../utils/regexHelper');
const { taskScopeFor } = require('../utils/taskScope');
const { parseDeadline, getAppTimezone } = require('../utils/dateHelper');
const { sanitizeTaskLinkedEmail } = require('../utils/sanitizeEmailHtml');
const cache = require('../utils/cache');
const { parseListParams, paginate, listResponse, firstString } = require('../utils/paginate');
const { listClients, CLIENT_SORT_FIELDS } = require('../utils/clientService');
const { log } = require('../utils/logger');

const logger = log('tasks');

// Sortable fields for GET /api/tasks (docs/audits/API-LIST-CONTRACT.md).
const TASK_SORT_FIELDS = ['createdAt', 'deadline', 'title', 'status', 'priority', 'clientName'];

// List projection. `description` is excluded because taskHelper fills it from
// an email preview and it is dead weight in a list.
const TASK_LIST_FIELDS =
  'title clientName status priority deadline assignedTo createdBy createdAt completedAt linkedEmail isRecurring recurrence overdueNotifiedAt parentTaskId';

// Linked-email projection for LIST responses. `body` is deliberately absent:
// `.populate('linkedEmail', 'subject from body attachments')` used to drag one
// base64-laden body per row into the response.
const LINKED_EMAIL_LIST_FIELDS = 'subject from snippet attachments';
// Detail responses opt in explicitly.
const LINKED_EMAIL_DETAIL_FIELDS = 'subject from snippet attachments +body';

/**
 * Spawn the next occurrence of a recurring task AT MOST ONCE.
 *
 * `recurrenceSpawnedAt` is claimed with a conditional update, so of two
 * concurrent completions exactly one writes the flag and therefore exactly one
 * child task is created. Called only after the completion has been persisted —
 * previously the spawn ran BEFORE `task.save()`, so a failed save left an
 * orphaned child behind.
 *
 * @param {Object} task - the (saved) task document
 * @param {Object} io - socket.io server
 * @returns {Promise<void>}
 */
const claimRecurrenceSpawn = async (task, io) => {
  if (!task || !task.isRecurring || !task.recurrence) return;

  const claim = await Task.updateOne(
    { _id: task._id, recurrenceSpawnedAt: null },
    { $set: { recurrenceSpawnedAt: new Date() } }
  );
  if ((claim.modifiedCount || 0) !== 1) return;

  const { spawnNextRecurrence } = require('../utils/recurrenceHelper');
  await spawnNextRecurrence(task, io);
};

/**
 * The audit-visible shape of a task, for ActivityLog `before`/`after`.
 *
 * Deliberately a small, stable projection rather than the whole document: the
 * log renders these as a diff, and dumping every field would bury the one that
 * actually changed. Contains nothing credential-shaped.
 *
 * @param {Object} doc - a Task document (or lean object)
 * @returns {Object|null}
 */
const taskSnapshot = (doc) => {
  if (!doc) return null;
  return {
    title: doc.title,
    status: doc.status,
    priority: doc.priority,
    clientName: doc.clientName,
    assignedTo: doc.assignedTo?._id ? String(doc.assignedTo._id) : (doc.assignedTo ? String(doc.assignedTo) : null),
    deadline: doc.deadline || null,
    isRecurring: !!doc.isRecurring,
    completedAt: doc.completedAt || null
  };
};


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

    // Verify the assignee actually exists — an unknown id previously produced a
    // Mongoose CastError -> 500.
    const assignee = await User.findOne({ _id: assignedTo, deletedAt: null }).select('name');
    if (!assignee) {
      return res.status(400).json({ message: 'Assignee not found.' });
    }

    // Object-level authorization on linkedEmail.
    //
    // `linkedEmail` was previously taken from the request with zero checks, so a
    // Head could link the Admin's email to a task, read its full body back from
    // the 201 response, and flip its assignment.
    if (linkedEmail) {
      const emailScope = { _id: linkedEmail, deletedAt: null };
      if (req.user.role !== 'Admin') {
        emailScope.fetchedBy = req.user._id;
      }
      const linkedEmailDoc = await Email.findOne(emailScope).select('_id');
      if (!linkedEmailDoc) {
        return res.status(403).json({ message: 'Linked email not found or not in your mailbox.' });
      }
    }

    // `isRecurring` must be evaluated once and reused — the original code
    // normalized it and then tested the RAW value on the next line, so
    // {"isRecurring":"false"} stored isRecurring:false with a non-null recurrence.
    const recurringFlag = isRecurring === true || isRecurring === 'true';

    // Create the task instance
    const task = new Task({
      title: title.trim(),
      description: description ? description.trim() : '',
      linkedEmail: linkedEmail || null,
      assignedTo,
      clientName: clientName.trim(),
      // Already normalized to a UTC Date by createTaskSchema.
      deadline: parseDeadline(deadline),
      notes: notes ? notes.trim() : '',
      priority: priority || 'Medium',
      createdBy: req.user._id,
      status: 'Pending',
      isRecurring: recurringFlag,
      recurrence: recurringFlag ? (recurrence || null) : null
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

    // Populate task details before returning. `body` and `attachments` are
    // deliberately NOT populated here — the 201 response must not become an
    // email-content read primitive.
    const populatedTask = await Task.findById(savedTask._id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', 'subject from')
      .populate('createdBy', 'name');

    // A create has no meaningful `before`, so only `after` is attached — the
    // log renders a one-sided change as a single snapshot.
    await logActivity(req.user._id, 'Task Creation', `Created task "${populatedTask.title}" (Assigned to: ${populatedTask.assignedTo?.name || 'N/A'}, Client: ${populatedTask.clientName})`, {
      req,
      targetType: 'Task',
      targetId: populatedTask._id,
      targetLabel: populatedTask.title,
      after: taskSnapshot(populatedTask)
    });

    // Send real-time notification to the assignee
    const io = req.app.get('io');
    await createNotification(
      assignedTo,
      `New task assigned: ${populatedTask.title}`,
      io,
      populatedTask._id,
      'task_assigned'
    );

    // The matching email. `task_assigned` had an email toggle on the Profile
    // page and no sender behind it, so the switch controlled nothing.
    // Self-assignment is skipped inside the mailer — for an Admin writing down
    // their own work that is every task they create.
    try {
      await sendTaskAssignedEmail({
        task: populatedTask,
        assigneeId: assignedTo,
        actorId: req.user._id,
        actorName: req.user.name
      });
    } catch (err) {
      // Belt and braces: the mailer already swallows its own failures. A task
      // must never fail to be created because mail is down.
      logger.error({ err: err.message, taskId: String(populatedTask._id) }, 'failed to queue task assignment email');
    }

    await cache.invalidateStats();

    return res.status(201).json(populatedTask);
  } catch (error) {
    logger.error({ err: error.message }, 'createTask failed');
    return res.status(500).json({ message: 'Server error. Failed to create task.' });
  }
};

// @desc    Get all tasks
// @route   GET /api/tasks
// @access  Private (All roles)
exports.getAllTasks = async (req, res) => {
  try {
    const params = parseListParams(req, {
      sortWhitelist: TASK_SORT_FIELDS,
      defaultSort: '-createdAt'
    });

    // H-4: the ONE definition of "tasks this user may see" — Employee:
    // assignedTo, Head: createdBy OR assignedTo, Admin: everything. The
    // dashboard and Reports now read the same module (utils/taskScope.js), so
    // this page and those tiles can no longer disagree.
    const filter = { ...taskScopeFor(req.user) };

    // Additive, endpoint-specific filters.
    const status = firstString(req.query.status, 20);
    if (['Pending', 'Completed', 'Late'].includes(status)) filter.status = status;

    const priority = firstString(req.query.priority, 20);
    if (['Low', 'Medium', 'High', 'Urgent'].includes(priority)) filter.priority = priority;

    const assignedTo = firstString(req.query.assignedTo, 40);
    if (/^[0-9a-fA-F]{24}$/.test(assignedTo) && req.user.role !== 'Employee') filter.assignedTo = assignedTo;

    const clientName = firstString(req.query.clientName, 200);
    if (clientName) filter.clientName = clientName;

    /*
     * The two filters the client already sends and the server silently ignored.
     * Both are strictly additive — omitting them behaves exactly as before —
     * and both are needed by UI work happening in parallel:
     *
     *   createdBy               audit H-6: `/tasks?creator=<id>` rendered a
     *                           "Priya Nair" chip and a Clear-filters button
     *                           over all 430 tasks in the workspace. An
     *                           Employee is not offered the filter and cannot
     *                           widen their scope with it, so it is refused for
     *                           them exactly as `assignedTo` is.
     *   deadlineFrom/deadlineTo audit H-7: the Calendar could only ever load
     *                           the newest 100 tasks because there was no way
     *                           to ask for a month. Paging back one month
     *                           showed "nothing scheduled" over 104 real tasks.
     */
    const createdBy = firstString(req.query.createdBy, 40);
    if (/^[0-9a-fA-F]{24}$/.test(createdBy) && req.user.role !== 'Employee') filter.createdBy = createdBy;

    const deadlineFrom = firstString(req.query.deadlineFrom, 40);
    const deadlineTo = firstString(req.query.deadlineTo, 40);
    const deadlineRange = {};
    if (deadlineFrom && !Number.isNaN(Date.parse(deadlineFrom))) deadlineRange.$gte = new Date(deadlineFrom);
    if (deadlineTo && !Number.isNaN(Date.parse(deadlineTo))) deadlineRange.$lte = new Date(deadlineTo);
    if (Object.keys(deadlineRange).length > 0) filter.deadline = deadlineRange;

    if (params.q) {
      const regex = new RegExp(escapeRegex(params.q), 'i');
      const search = { $or: [{ title: regex }, { clientName: regex }] };
      // Never overwrite the role scope's own `$or`.
      filter.$and = [search];
    }

    const { data, pagination } = await paginate(Task, filter, params, {
      select: TASK_LIST_FIELDS,
      populate: [
        { path: 'assignedTo', select: 'name email' },
        { path: 'linkedEmail', select: LINKED_EMAIL_LIST_FIELDS },
        { path: 'createdBy', select: 'name' }
      ]
    });

    // Bodies are no longer in this payload at all, so the read-time sanitizer
    // has nothing to do here; it is retained only on the detail paths.
    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'getAllTasks failed');
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
      // The detail view is the ONLY task read path that opts into the body.
      .populate('linkedEmail', LINKED_EMAIL_DETAIL_FIELDS)
      .populate('createdBy', 'name');

    if (!task) {
      return res.status(404).json({ message: 'Task not found.' });
    }

    // Employees can only access their own tasks.
    //
    // The `task.assignedTo &&` short-circuit let UNASSIGNED tasks through, so an
    // Employee could read any unassigned task — including its populated email
    // body and attachments. Deny by default: no assignee means no access.
    if (req.user.role === 'Employee' && task.assignedTo?._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Access denied. You can only access tasks assigned to you.' });
    }

    // Heads can access tasks created by or assigned to them
    if (req.user.role === 'Head') {
      const isCreator = task.createdBy && task.createdBy._id.toString() === req.user._id.toString();
      const isAssignee = task.assignedTo && task.assignedTo._id.toString() === req.user._id.toString();
      if (!isCreator && !isAssignee) {
        return res.status(403).json({ message: 'Access denied. You can only access tasks created by or assigned to you.' });
      }
    }

    return res.status(200).json(sanitizeTaskLinkedEmail(task));
  } catch (error) {
    logger.error({ err: error.message }, 'getTaskById failed');
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

    // Captured BEFORE any branch mutates the in-memory document (the Employee
    // completion path assigns `task.status` directly), so the audit `before`
    // is genuinely the prior state.
    const beforeState = taskSnapshot(task);

    let shouldSpawnRecurrence = false;
    // Set only when the assignee actually changes to a real user, and read only
    // AFTER the save — mail for a reassignment that failed to persist would be
    // worse than no mail. Holds the NEW assignee; the outgoing one is not told.
    let reassignedTo = null;

    // Role checks
    if (req.user.role === 'Employee') {
      // Employees can only update their own tasks. Deny by default: the old
      // `task.assignedTo &&` short-circuit let an Employee complete any
      // UNASSIGNED task, firing notifications and spawning recurrences.
      if (task.assignedTo?.toString() !== req.user._id.toString()) {
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

      // Claim the Pending/Late -> Completed transition ATOMICALLY.
      //
      // The old code read `task.status`, decided, fired the notifications and
      // spawned the recurrence, and only then called `task.save()`. Two
      // concurrent completions therefore both saw "not completed", both mailed
      // the creator and both spawned a child task — and if the save failed, the
      // side effects had already happened.
      // F-2: `completedAt` is stamped by the SAME atomic claim that sets the
      // status, so the completion instant cannot disagree with the status and
      // a losing concurrent completion cannot move it.
      const claimed = await Task.findOneAndUpdate(
        { _id: task._id, status: { $ne: 'Completed' } },
        { $set: { status: 'Completed', completedAt: new Date() } },
        { new: true }
      );
      const wasAlreadyCompleted = !claimed;
      task.status = 'Completed';

      if (!wasAlreadyCompleted) {
        // Send completion notification & email alert to task creator (Admin/Head)
        try {
          const creator = await User.findById(task.createdBy).select('email name').lean();
          if (creator) {
            // 1. App Notification
            await createNotification(
              task.createdBy,
              `Task completed: ${task.title} by ${req.user.name}`,
              io,
              task._id,
              'task_completed'
            );
            // 2. Email alert — QUEUED, so completing a task no longer waits on
            //    an SMTP round-trip to Gmail. Tagged with an `event`, so the
            //    creator's notification preferences actually govern it.
            // Was plain text with no HTML at all — the only email of the three
            // that arrived unformatted.
            const { taskCompleted: completedTemplate } = require('../utils/emailTemplates');
            const mail = completedTemplate({
              recipientName: creator.name || 'there',
              taskTitle: task.title,
              completedBy: req.user.name,
              completedAt: new Date().toLocaleString('en-GB', {
                timeZone: getAppTimezone(),
                dateStyle: 'medium',
                timeStyle: 'short'
              }),
              clientName: task.clientName,
              taskUrl: `${(process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '')}/tasks?task=${task._id}`
            });
            await sendEmail(creator.email, mail.subject, mail.text, mail.html, {
              event: 'task_completed',
              userId: task.createdBy
            });
          }
        } catch (err) {
          logger.error({ err: err.message, taskId: String(task._id) }, 'failed to queue task completion alerts');
        }

        // Recurrence is spawned AFTER the completion is durable — see
        // claimRecurrenceSpawn below.
        await claimRecurrenceSpawn(task, io);
      }

      await cache.invalidateStats();

      const completedTask = await Task.findById(task._id)
        .populate('assignedTo', 'name email')
        .populate('linkedEmail', LINKED_EMAIL_DETAIL_FIELDS)
        .populate('createdBy', 'name');

      await logActivity(
        req.user._id,
        'Task Update',
        `Updated task "${completedTask.title}" (Status: ${completedTask.status})`,
        {
          req,
          targetType: 'Task',
          targetId: completedTask._id,
          targetLabel: completedTask.title,
          before: beforeState,
          after: taskSnapshot(completedTask)
        }
      );

      // Return early: the status write already happened atomically above, so
      // falling through to the shared `task.save()` would rewrite a stale doc.
      return res.status(200).json(sanitizeTaskLinkedEmail(completedTask));
    } else {
      // For Head, check if they created the task or are assigned to it
      if (req.user.role === 'Head') {
        const isCreator = task.createdBy && task.createdBy.toString() === req.user._id.toString();
        const isAssignee = task.assignedTo && task.assignedTo.toString() === req.user._id.toString();
        if (!isCreator && !isAssignee) {
          return res.status(403).json({ message: 'Access denied. You can only update tasks created by or assigned to you.' });
        }
      }

      // Admin/Head can update all fields
      const { title, description, assignedTo, clientName, deadline, notes, status, priority, isRecurring, recurrence } = req.body;

      const wasAlreadyCompleted = task.status === 'Completed';

      // All values are already type-checked and bounded by updateTaskSchema, so
      // these are safe (previously `{"title":123}` threw and became a 500).
      if (title !== undefined) task.title = title.trim();
      if (description !== undefined) task.description = description.trim();
      if (clientName !== undefined) task.clientName = clientName.trim();
      if (deadline !== undefined) {
        task.deadline = deadline === null ? null : parseDeadline(deadline);
        // A new deadline re-arms overdue notification for this task.
        task.overdueNotifiedAt = null;
      }
      if (notes !== undefined) task.notes = notes.trim();
      if (status !== undefined) {
        task.status = status;
        // Leaving the Late state re-arms the overdue notifier.
        if (status !== 'Late') task.overdueNotifiedAt = null;

        // F-2. Set only on the transition INTO Completed, so re-saving an
        // already-completed task does not move its resolution time; cleared on
        // the transition out, so a reopened task is not counted as resolved.
        if (status === 'Completed' && !wasAlreadyCompleted) task.completedAt = new Date();
        else if (status !== 'Completed') task.completedAt = null;
      }
      if (priority !== undefined) task.priority = priority;
      if (isRecurring !== undefined) task.isRecurring = isRecurring;
      if (recurrence !== undefined) task.recurrence = recurrence || null;

      // Handle changes to task assignee
      if (assignedTo !== undefined && assignedTo !== task.assignedTo?.toString()) {
        task.assignedTo = assignedTo || null;
        // Unassigning tells nobody: `assignedTo: null` means the task lost an
        // owner, not that someone gained one.
        if (assignedTo) reassignedTo = String(assignedTo);
        // If there's a linked email, keep the email's assignee in sync
        if (task.linkedEmail) {
          await Email.findByIdAndUpdate(task.linkedEmail, {
            assignedTo: assignedTo || null,
            status: assignedTo ? 'assigned' : 'unassigned'
          });
        }
      }

      // The recurrence spawn is deferred until AFTER the save; see below.
      shouldSpawnRecurrence = status === 'Completed' && !wasAlreadyCompleted;
    }

    const updatedTask = await task.save();

    if (shouldSpawnRecurrence) {
      await claimRecurrenceSpawn(updatedTask, io);
    }

    await cache.invalidateStats();

    // Populate and return updated task details
    const populatedTask = await Task.findById(updatedTask._id)
      .populate('assignedTo', 'name email')
      .populate('linkedEmail', LINKED_EMAIL_DETAIL_FIELDS)
      .populate('createdBy', 'name');

    // Tell the NEW assignee, and only after the write is durable. An Admin who
    // reassigns a task to themselves gets nothing (handled in the mailer).
    if (reassignedTo) {
      try {
        await sendTaskAssignedEmail({
          task: populatedTask,
          assigneeId: reassignedTo,
          actorId: req.user._id,
          actorName: req.user.name
        });
      } catch (err) {
        logger.error({ err: err.message, taskId: String(populatedTask._id) }, 'failed to queue reassignment email');
      }
    }

    await logActivity(req.user._id, 'Task Update', `Updated task "${populatedTask.title}" (Status: ${populatedTask.status}, Assigned to: ${populatedTask.assignedTo?.name || 'N/A'})`, {
      req,
      targetType: 'Task',
      targetId: populatedTask._id,
      targetLabel: populatedTask.title,
      before: beforeState,
      after: taskSnapshot(populatedTask)
    });

    return res.status(200).json(sanitizeTaskLinkedEmail(populatedTask));
  } catch (error) {
    logger.error({ err: error.message }, 'updateTask failed');
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

    // No before/after on a delete: the "after" side is meaningless and the UI
    // already renders a one-sided change as a single snapshot.
    await logActivity(req.user._id, 'Task Deletion', `Deleted task "${task.title}" (Client: ${task.clientName})`, {
      req,
      targetType: 'Task',
      targetId: task._id,
      targetLabel: task.title,
      before: taskSnapshot(task)
    });
    await cache.invalidateStats();

    return res.status(200).json({ message: 'Task deleted successfully.' });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteTask failed');
    return res.status(500).json({ message: 'Server error. Failed to delete task.' });
  }
};

// @desc    Get all clients
// @route   GET /api/tasks/clients
// @access  Private (All roles)
exports.getClients = async (req, res) => {
  try {
    // Same implementation as GET /api/clients (utils/clientService); only the
    // default sort and the legacy response shape differ. The audit flagged
    // these two endpoints as duplicates with divergent behaviour.
    const params = parseListParams(req, {
      sortWhitelist: CLIENT_SORT_FIELDS,
      defaultSort: 'name'
    });

    // Counters scoped to the caller, same as GET /api/clients (audit D5).
    const { data, pagination } = await listClients(params, { user: req.user });

    res.set('Cache-Control', 'private, max-age=30, stale-while-revalidate=60');

    // Legacy shape preserved: a bare array (now bounded at 200).
    return listResponse(res, { params, data, pagination });
  } catch (error) {
    logger.error({ err: error.message }, 'getClients (tasks) failed');
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

    // ONE query, reused by every branch below. The original ran up to three
    // separate `Task.find({_id:{$in:taskIds}})` calls in a single handler, each
    // hydrating up to 500 full documents.
    // `status` and `assignedTo` are selected purely so the audit entry can
    // record the state the bulk write replaced. Still one lean query.
    // `title`/`clientName`/`deadline`/`priority` ride along so the reassign
    // branch can compose its email without a second read; none of them are
    // touched by a bulk action, so the pre-update values are still correct.
    const tasks = await Task.find({ _id: { $in: taskIds } })
      .select('_id createdBy linkedEmail status assignedTo title clientName deadline priority')
      .lean();

    // For Head role, make sure they created all tasks they are trying to perform bulk action on
    if (req.user.role === 'Head') {
      const ownedTasksCount = tasks.filter(t => t.createdBy && t.createdBy.toString() === req.user._id.toString()).length;
      if (ownedTasksCount !== tasks.length) {
        return res.status(403).json({ message: 'Access denied. You can only perform bulk actions on tasks created by you.' });
      }
    }

    let result = {};

    if (action === 'delete') {
      // Reset linked emails before deleting tasks
      const linkedEmailIds = tasks.filter(t => t.linkedEmail).map(t => t.linkedEmail);
      if (linkedEmailIds.length > 0) {
        await Email.updateMany(
          { _id: { $in: linkedEmailIds } },
          { $set: { status: 'unassigned', assignedTo: null } }
        );
      }
      await Task.deleteMany({ _id: { $in: taskIds } });
      result = { deleted: taskIds.length };
      // A bulk action has N targets, so there is no single honest `targetId`.
      // The type and a countable label are recorded; inventing one id would be
      // worse than leaving it null.
      await logActivity(req.user._id, 'Bulk Task Delete', `Bulk deleted ${taskIds.length} tasks`, {
        req,
        targetType: 'Task',
        targetLabel: `${taskIds.length} task(s)`
      });
    }

    else if (action === 'status') {
      const allowedStatuses = ['Pending', 'Completed', 'Late'];
      if (!value || !allowedStatuses.includes(value)) {
        return res.status(400).json({ message: `Invalid status. Must be one of: ${allowedStatuses.join(', ')}` });
      }
      // F-2: same transition semantics as the single-task path. Stamping
      // `completedAt` FIRST, restricted to tasks that are not already
      // completed, is what stops a bulk re-apply from resetting the resolution
      // time of tasks that were finished last week.
      if (value === 'Completed') {
        await Task.updateMany(
          { _id: { $in: taskIds }, status: { $ne: 'Completed' } },
          { $set: { completedAt: new Date() } }
        );
        await Task.updateMany({ _id: { $in: taskIds } }, { $set: { status: 'Completed' } });
      } else {
        await Task.updateMany({ _id: { $in: taskIds } }, { $set: { status: value, completedAt: null } });
      }
      result = { updated: taskIds.length, status: value };
      // Summarised rather than per-task: 500 rows of before/after would blow
      // past the logger's size bound and be discarded wholesale.
      const beforeStatusCounts = tasks.reduce((acc, t) => {
        const key = t.status || 'Unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});
      await logActivity(req.user._id, 'Bulk Task Status', `Bulk set ${taskIds.length} tasks to "${value}"`, {
        req,
        targetType: 'Task',
        targetLabel: `${taskIds.length} task(s)`,
        before: { statusCounts: beforeStatusCounts },
        after: { status: value, taskCount: taskIds.length }
      });
    }

    else if (action === 'reassign') {
      if (!value) return res.status(400).json({ message: 'value (userId) is required for reassign action.' });
      const targetUser = await User.findById(value).select('name').lean();
      if (!targetUser) return res.status(404).json({ message: 'Target user not found.' });
      await Task.updateMany({ _id: { $in: taskIds } }, { $set: { assignedTo: value } });
      // Sync linked email assignments too, reusing the tasks already loaded.
      const linkedEmailIds = tasks.filter(t => t.linkedEmail).map(t => t.linkedEmail);
      if (linkedEmailIds.length > 0) {
        await Email.updateMany({ _id: { $in: linkedEmailIds } }, { $set: { assignedTo: value, status: 'assigned' } });
      }
      result = { updated: taskIds.length, assignedTo: targetUser.name };

      // ONE email for the whole batch. Reassigning 200 tasks must not put 200
      // messages in one inbox, so this uses the digest template above a single
      // task. Tasks the person already owned are excluded — being told you were
      // assigned something you already had is noise.
      try {
        const newlyAssigned = tasks.filter((t) => String(t.assignedTo || '') !== String(value));
        await sendTasksAssignedEmail({
          tasks: newlyAssigned,
          assigneeId: value,
          actorId: req.user._id,
          actorName: req.user.name
        });
      } catch (err) {
        logger.error({ err: err.message, count: taskIds.length }, 'failed to queue bulk reassignment email');
      }

      const beforeAssignees = [
        ...new Set(tasks.map((t) => (t.assignedTo ? String(t.assignedTo) : 'unassigned')))
      ].slice(0, 20);
      await logActivity(req.user._id, 'Bulk Task Reassign', `Bulk reassigned ${taskIds.length} tasks to ${targetUser.name}`, {
        req,
        targetType: 'Task',
        targetLabel: `${taskIds.length} task(s)`,
        before: { assignedTo: beforeAssignees },
        after: { assignedTo: String(value), assignedToName: targetUser.name, taskCount: taskIds.length }
      });
    }

    await cache.invalidateStats();

    return res.status(200).json({ message: 'Bulk action completed.', result });
  } catch (error) {
    logger.error({ err: error.message }, 'bulkTaskAction failed');
    return res.status(500).json({ message: 'Server error. Failed to perform bulk action.' });
  }
};

// @desc    Create a new client
// @route   POST /api/tasks/clients
// @access  Private (Admin only)
exports.createClient = async (req, res) => {
  try {
    const { name, associatedEmails } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ message: 'Client name is required.' });
    }

    const trimmedName = name.trim();
    const existing = await Client.findOne({ name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, 'i') } });
    if (existing) {
      return res.status(400).json({ message: 'Client name must be unique. Client already exists.' });
    }

    // Process associatedEmails array
    let emailArray = [];
    if (Array.isArray(associatedEmails)) {
      emailArray = associatedEmails.map(email => email.trim()).filter(email => email.length > 0);
    }

    const client = new Client({
      name: trimmedName,
      associatedEmails: emailArray
    });

    await client.save();
    await cache.invalidateClients();
    await logActivity(req.user._id, 'Client Creation', `Created client "${client.name}"`, {
      req,
      targetType: 'Client',
      targetId: client._id,
      targetLabel: client.name,
      after: { name: client.name, associatedEmails: [...(client.associatedEmails || [])] }
    });

    return res.status(201).json(client);
  } catch (error) {
    logger.error({ err: error.message }, 'createClient (tasks) failed');
    return res.status(500).json({ message: 'Server error. Failed to create client.' });
  }
};

// @desc    Update a client
// @route   PUT /api/tasks/clients/:id
// @access  Private (Admin only)
exports.updateClient = async (req, res) => {
  try {
    const { name, associatedEmails } = req.body;
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ message: 'Client not found.' });
    }

    // Snapshot before the field assignments below mutate the document.
    const beforeClient = { name: client.name, associatedEmails: [...(client.associatedEmails || [])] };

    if (name !== undefined) {
      const trimmedName = name.trim();
      if (!trimmedName) {
        return res.status(400).json({ message: 'Client name cannot be empty.' });
      }

      // Check if client name matches another client
      const existing = await Client.findOne({ 
        name: { $regex: new RegExp(`^${escapeRegex(trimmedName)}$`, 'i') }, 
        _id: { $ne: req.params.id } 
      });
      if (existing) {
        return res.status(400).json({ message: 'Client name must be unique. Another client exists with this name.' });
      }
      client.name = trimmedName;
    }

    if (associatedEmails !== undefined && Array.isArray(associatedEmails)) {
      client.associatedEmails = associatedEmails.map(email => email.trim()).filter(email => email.length > 0);
    }

    await client.save();
    await cache.invalidateClients();
    await logActivity(req.user._id, 'Client Update', `Updated client "${client.name}"`, {
      req,
      targetType: 'Client',
      targetId: client._id,
      targetLabel: client.name,
      before: beforeClient,
      after: { name: client.name, associatedEmails: [...(client.associatedEmails || [])] }
    });

    return res.status(200).json(client);
  } catch (error) {
    logger.error({ err: error.message }, 'updateClient (tasks) failed');
    return res.status(500).json({ message: 'Server error. Failed to update client.' });
  }
};

// @desc    Delete a client
// @route   DELETE /api/tasks/clients/:id
// @access  Private (Admin only)
exports.deleteClient = async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ message: 'Client not found.' });
    }

    await Client.findByIdAndDelete(req.params.id);
    await cache.invalidateClients();
    await logActivity(req.user._id, 'Client Deletion', `Deleted client "${client.name}"`, {
      req,
      targetType: 'Client',
      targetId: client._id,
      targetLabel: client.name,
      before: { name: client.name, associatedEmails: [...(client.associatedEmails || [])] }
    });

    return res.status(200).json({ message: 'Client deleted successfully.' });
  } catch (error) {
    logger.error({ err: error.message }, 'deleteClient (tasks) failed');
    return res.status(500).json({ message: 'Server error. Failed to delete client.' });
  }
};

