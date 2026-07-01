const Task = require('../models/Task');
const User = require('../models/User');
const Email = require('../models/Email');
const Client = require('../models/Client');

// @desc    Get Employee Performance Report
// @route   GET /api/reports/employee
// @access  Private (Admin only)
exports.getEmployeeReport = async (req, res) => {
  try {
    const { filter, userId } = req.query;

    // Calculate date range
    const now = new Date();
    const startDate = new Date();
    if (filter === 'weekly') {
      startDate.setDate(now.getDate() - 7);
    } else {
      // Default to monthly (30 days)
      startDate.setDate(now.getDate() - 30);
    }
    // Set to start of the day
    startDate.setHours(0, 0, 0, 0);

    // Fetch target users (role Employee or Head)
    let userQuery = { role: { $in: ['Employee', 'Head'] } };
    if (userId) {
      userQuery._id = userId;
    }

    const users = await User.find(userQuery).select('name email role');

    if (users.length === 0) {
      return res.status(200).json([]);
    }

    const userIds = users.map((u) => u._id);

    // Query tasks created within range and assigned to targeted users
    const tasks = await Task.find({
      createdAt: { $gte: startDate },
      assignedTo: { $in: userIds }
    });

    const report = users.map((user) => {
      const userTasks = tasks.filter(
        (t) => t.assignedTo && t.assignedTo.toString() === user._id.toString()
      );

      const totalAssigned = userTasks.length;
      const totalCompleted = userTasks.filter((t) => t.status === 'Completed').length;
      const totalPending = userTasks.filter((t) => t.status === 'Pending').length;
      const totalLate = userTasks.filter((t) => t.status === 'Late').length;

      const completionRate =
        totalAssigned > 0 ? Math.round((totalCompleted / totalAssigned) * 100) : 0;

      return {
        employeeId: user._id,
        employeeName: user.name,
        employeeEmail: user.email,
        employeeRole: user.role,
        totalAssigned,
        totalCompleted,
        totalPending,
        totalLate,
        completionRate,
        tasks: userTasks.map((t) => ({
          _id: t._id,
          title: t.title,
          clientName: t.clientName,
          deadline: t.deadline,
          status: t.status
        }))
      };
    });

    return res.status(200).json(report);
  } catch (error) {
    console.error('Error in getEmployeeReport:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve employee reports.' });
  }
};

// @desc    Get Overall System Stats
// @route   GET /api/reports/overall
// @access  Private (Admin, Head only)
exports.getOverallStats = async (req, res) => {
  try {
    let emailQuery = {};
    let taskQuery = {};

    if (req.user.role === 'Head') {
      emailQuery.fetchedBy = req.user._id;
      taskQuery = { createdBy: req.user._id };
    }

    const totalUsers = await User.countDocuments({});
    const totalEmails = await Email.countDocuments(emailQuery);
    const totalTasks = await Task.countDocuments(taskQuery);
    const totalPending = await Task.countDocuments({ ...taskQuery, status: 'Pending' });
    const totalCompleted = await Task.countDocuments({ ...taskQuery, status: 'Completed' });
    const totalLate = await Task.countDocuments({ ...taskQuery, status: 'Late' });
    const totalUnassignedEmails = await Email.countDocuments({ ...emailQuery, status: 'unassigned' });
    const totalClients = await Client.countDocuments({});

    return res.status(200).json({
      totalUsers,
      totalEmails,
      totalTasks,
      totalPending,
      totalCompleted,
      totalLate,
      totalUnassignedEmails,
      totalClients
    });
  } catch (error) {
    console.error('Error in getOverallStats:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve system statistics.' });
  }
};

// @desc    Get Task Timeline (Created last 30 days)
// @route   GET /api/reports/timeline
// @access  Private (Admin, Head only)
exports.getTaskTimeline = async (req, res) => {
  try {
    const now = new Date();
    const dateMap = {};
    const timelineDates = [];

    // Initialize 30 days calendar mapping with count 0
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      
      dateMap[dateStr] = 0;
      timelineDates.push(dateStr);
    }

    const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    startDate.setHours(0, 0, 0, 0);

    let taskQuery = { createdAt: { $gte: startDate } };
    if (req.user.role === 'Head') {
      taskQuery.createdBy = req.user._id;
    }

    // Fetch tasks created in the timeline range
    const tasks = await Task.find(taskQuery);

    tasks.forEach((task) => {
      const d = new Date(task.createdAt);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;

      if (dateMap[dateStr] !== undefined) {
        dateMap[dateStr]++;
      }
    });

    const timelineData = timelineDates.map((dateStr) => ({
      date: dateStr,
      count: dateMap[dateStr]
    }));

    return res.status(200).json(timelineData);
  } catch (error) {
    console.error('Error in getTaskTimeline:', error);
    return res.status(500).json({ message: 'Server error. Failed to retrieve timeline logs.' });
  }
};
