const express = require('express');
const router = express.Router();
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const {
  createTask,
  getAllTasks,
  getTaskById,
  updateTask,
  deleteTask,
  getClients
} = require('../controllers/taskController');

// Route for listing all clients - must be registered before the /:id route parameters to prevent collisions
router.get('/clients', protect, getClients);

router.route('/')
  .get(protect, getAllTasks)
  .post(protect, authorizeRoles('Admin', 'Head'), createTask);

router.route('/:id')
  .get(protect, getTaskById)
  .put(protect, updateTask)
  .delete(protect, authorizeRoles('Admin', 'Head'), deleteTask);

module.exports = router;
