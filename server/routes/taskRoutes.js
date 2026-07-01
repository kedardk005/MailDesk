const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  deleteTask,
  getClients,
  bulkTaskAction
} = require('../controllers/taskController');
const validate = require('../middleware/validate');
const { createTaskSchema, bulkTaskSchema } = require('../middleware/schemas');

// Route for listing all clients - must be registered before the /:id route parameters to prevent collisions
router.get('/clients', protect, getClients);

// Route for bulk actions
router.post('/bulk', protect, authorizeRoles('Admin', 'Head'), validate(bulkTaskSchema), bulkTaskAction);

router.route('/')
  .get(protect, getAllTasks)
  .post(protect, authorizeRoles('Admin', 'Head'), validate(createTaskSchema), createTask);

router.route('/:id')
  .get(protect, getTaskById)
  .put(protect, updateTask)
  .delete(protect, authorizeRoles('Admin', 'Head'), deleteTask);

module.exports = router;
