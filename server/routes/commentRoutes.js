const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :id from parent
const { getComments, addComment, deleteComment } = require('../controllers/commentController');
const { protect } = require('../middleware/authMiddleware');

router.route('/').get(protect, getComments).post(protect, addComment);
router.delete('/:commentId', protect, deleteComment);

module.exports = router;
