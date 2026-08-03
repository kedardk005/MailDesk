const express = require('express');
const router = express.Router();
const {
  getEmployeeReport,
  getOverallStats,
  getTaskTimeline,
  getClientStats,
  getEmailTimeline,
  getSlaSummary,
  getSlaTimeseries,
  getSlaPolicyConfig,
  updateSlaPolicyConfig
} = require('../controllers/reportsController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const { slaPolicySchema } = require('../middleware/schemas');

// Authenticate all endpoints
router.use(protect);

// GET /api/reports/employee - Admin and Head performance stats.
// WAVE2 gap S-17: was Admin-only while every sibling route below served Head.
// The controller scopes a Head to the tasks they created, matching
// getOverallStats / getTaskTimeline. Route and controller now agree.
router.get('/employee', authorizeRoles('Admin', 'Head'), getEmployeeReport);

// GET /api/reports/overall - Admin and Head system statistics
router.get('/overall', authorizeRoles('Admin', 'Head'), getOverallStats);

// GET /api/reports/timeline - Admin and Head timeline chart coordinates
router.get('/timeline', authorizeRoles('Admin', 'Head'), getTaskTimeline);

// GET /api/reports/email-timeline - Admin and Head day-wise emails received report
router.get('/email-timeline', authorizeRoles('Admin', 'Head'), getEmailTimeline);

// GET /api/reports/client-stats - Admin and Head client statistics
router.get('/client-stats', authorizeRoles('Admin', 'Head'), getClientStats);

// ---------------------------------------------------------------------------
// F-2 — SLA analytics.
//
// The two literal sub-paths are registered BEFORE the summary route's siblings
// so neither can be shadowed. A Head is served, scoped to their own mailbox and
// their own tasks by the controller, exactly like every sibling report route.
// ---------------------------------------------------------------------------

// GET /api/reports/sla/timeseries - daily buckets for charting
router.get('/sla/timeseries', authorizeRoles('Admin', 'Head'), getSlaTimeseries);

// GET /api/reports/sla/policy - the effective targets (read-only, Admin + Head)
router.get('/sla/policy', authorizeRoles('Admin', 'Head'), getSlaPolicyConfig);

// PUT /api/reports/sla/policy - upsert the global policy or one client override
router.put('/sla/policy', authorizeRoles('Admin'), validate(slaPolicySchema), updateSlaPolicyConfig);

// GET /api/reports/sla - median/p90 first response, resolution and backlog
router.get('/sla', authorizeRoles('Admin', 'Head'), getSlaSummary);

module.exports = router;
