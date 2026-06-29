const express = require('express');
const router = express.Router();
const { summarizeEmail } = require('../controllers/aiController');
const { protect, authorizeRoles } = require('../middleware/authMiddleware');

router.post('/summarize-email', protect, authorizeRoles('Admin', 'Head'), summarizeEmail);

module.exports = router;
