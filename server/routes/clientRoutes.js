const express = require('express');
const router = express.Router();
const {
  getClients,
  getClientTimeline,
  createClient,
  updateClient,
  deleteClient
} = require('../controllers/clientController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/', getClients);

// GET /api/clients/:id/timeline - recent tasks + emails for one client (S-10).
// Role-scoped inside the controller, same rules as the task/email lists.
router.get('/:id/timeline', getClientTimeline);
router.post('/', authorizeRoles('Admin', 'Head'), createClient);
router.put('/:id', authorizeRoles('Admin', 'Head'), updateClient);
router.delete('/:id', authorizeRoles('Admin'), deleteClient);

module.exports = router;
