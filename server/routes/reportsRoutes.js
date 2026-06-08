const express = require('express');
const router = express.Router();
const {
  getEmployeeReport,
  getOverallStats,
  getTaskTimeline
} = require('../controllers/reportsController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

// Authenticate all endpoints
router.use(protect);

// GET /api/reports/employee - Admin only performance stats
router.get('/employee', authorizeRoles('Admin'), getEmployeeReport);

// GET /api/reports/overall - Admin and Head system statistics
router.get('/overall', authorizeRoles('Admin', 'Head'), getOverallStats);

// GET /api/reports/timeline - Admin and Head timeline chart coordinates
router.get('/timeline', authorizeRoles('Admin', 'Head'), getTaskTimeline);

module.exports = router;
