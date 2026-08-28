const express = require('express');
const router = express.Router();
const {
  getClients,
  getClientTimeline,
  createClient,
  importClients,
  updateClient,
  deleteClient
} = require('../controllers/clientController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');
const validate = require('../middleware/validate');
const { createClientSchema, updateClientSchema, importClientsSchema } = require('../middleware/schemas');
const { guardObjectIdParams } = require('../middleware/objectIdParam');

router.use(protect);

// H-10: '/:id/timeline' already checked the id by hand; '/:id' on PUT/DELETE
// did not, and PUT leaked the raw driver CastError text in a 500.
guardObjectIdParams(router, 'client', ['id']);

router.get('/', getClients);

// GET /api/clients/:id/timeline - recent tasks + emails for one client (S-10).
// Role-scoped inside the controller, same rules as the task/email lists.
router.get('/:id/timeline', getClientTimeline);
// H-9: this route had NO validation. `{"name":[]}` reached `name.trim()` and
// returned 500 "name.trim is not a function"; a 5,000 character name was 201.
router.post('/', authorizeRoles('Admin', 'Head'), validate(createClientSchema), createClient);
// POST /api/clients/import - bulk create/update from a parsed spreadsheet.
// Same roles as creating one by hand: importing is creating, in bulk.
// Declared BEFORE '/:id' routes so "import" is never read as an id.
router.post('/import', authorizeRoles('Admin', 'Head'), validate(importClientsSchema), importClients);
router.put('/:id', authorizeRoles('Admin', 'Head'), validate(updateClientSchema), updateClient);
router.delete('/:id', authorizeRoles('Admin'), deleteClient);

module.exports = router;
