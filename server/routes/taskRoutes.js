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
  bulkTaskAction,
  createClient,
  updateClient,
  deleteClient
} = require('../controllers/taskController');
const validate = require('../middleware/validate');
const { createTaskSchema, updateTaskSchema, bulkTaskSchema, createClientSchema, updateClientSchema } = require('../middleware/schemas');
const { guardObjectIdParams } = require('../middleware/objectIdParam');

// H-10: both `/tasks/:id` and `/tasks/clients/:id` carry ObjectIds.
guardObjectIdParams(router, 'task', ['id']);

// Route for listing all clients - must be registered before the /:id route parameters to prevent collisions
router.get('/clients', protect, getClients);
// H-9: same Zod schemas as POST/PUT /api/clients, so the documented-duplicate
// URL cannot be the unvalidated one.
router.post('/clients', protect, authorizeRoles('Admin'), validate(createClientSchema), createClient);
router.put('/clients/:id', protect, authorizeRoles('Admin'), validate(updateClientSchema), updateClient);
router.delete('/clients/:id', protect, authorizeRoles('Admin'), deleteClient);

// Route for bulk actions
router.post('/bulk', protect, authorizeRoles('Admin', 'Head'), validate(bulkTaskSchema), bulkTaskAction);

router.route('/')
  .get(protect, getAllTasks)
  .post(protect, authorizeRoles('Admin', 'Head'), validate(createTaskSchema), createTask);

router.route('/:id')
  .get(protect, getTaskById)
  .put(protect, validate(updateTaskSchema), updateTask)
  .delete(protect, authorizeRoles('Admin', 'Head'), deleteTask);

module.exports = router;
