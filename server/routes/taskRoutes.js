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
/*
 * M-12 — the SAME operation answered differently depending on which of the two
 * documented-duplicate URLs a client happened to call:
 *
 *   POST /api/clients        as a Head -> 201
 *   POST /api/tasks/clients  as a Head -> 403
 *
 * Aligned on Admin + Head, i.e. widening this pair rather than narrowing
 * `/api/clients`, because Head client management is a shipped, exercised
 * feature: `client/src/pages/ClientList.jsx` grants the New client / Edit
 * controls on `isAdmin || isHead`, and the task form's client combobox offers a
 * Head a "Create «…»" path. Narrowing `/api/clients` to Admin would have broken
 * that flow to fix a consistency defect; widening breaks nothing, and a Head
 * could already reach the identical write one URL over.
 *
 * DELETE stays Admin-only on BOTH URLs — that pair already agreed, and deleting
 * a client is the one operation here that is not reversible from the UI.
 */
router.post('/clients', protect, authorizeRoles('Admin', 'Head'), validate(createClientSchema), createClient);
router.put('/clients/:id', protect, authorizeRoles('Admin', 'Head'), validate(updateClientSchema), updateClient);
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
