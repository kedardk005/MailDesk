const express = require('express');
const router = express.Router();
const {
  getEmployeeReport,
  getOverallStats,
  getTaskTimeline,
  getClientStats,
  getEmailTimeline
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

// GET /api/reports/email-timeline - Admin and Head day-wise emails received report
router.get('/email-timeline', authorizeRoles('Admin', 'Head'), getEmailTimeline);

// GET /api/reports/client-stats - Admin and Head client statistics
router.get('/client-stats', authorizeRoles('Admin', 'Head'), getClientStats);

module.exports = router;
