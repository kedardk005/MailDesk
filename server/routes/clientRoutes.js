const express = require('express');
const router = express.Router();
const {
  getClients,
  createClient,
  updateClient,
  deleteClient
} = require('../controllers/clientController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.use(protect);

router.get('/', getClients);
router.post('/', authorizeRoles('Admin', 'Head'), createClient);
router.put('/:id', authorizeRoles('Admin', 'Head'), updateClient);
router.delete('/:id', authorizeRoles('Admin'), deleteClient);

module.exports = router;
