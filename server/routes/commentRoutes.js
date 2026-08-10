const express = require('express');
const router = express.Router({ mergeParams: true }); // mergeParams to access :id from parent
const { getComments, addComment, deleteComment } = require('../controllers/commentController');
const { protect } = require('../middleware/authMiddleware');
const { requireObjectIdParam, objectIdParam } = require('../middleware/objectIdParam');

// H-10. `:id` (the task) is declared by the PARENT mount path
// (`app.use('/api/tasks/:id/comments', commentRoutes)`), so a `router.param`
// handler on this router would never fire — Express processes a mount path's
// parameters on the parent router. It is applied as ordinary middleware here.
router.use(requireObjectIdParam('id', 'task'));

// `:commentId` IS declared on this router, so the ordinary param handler works.
router.param('commentId', objectIdParam('comment'));

router.route('/').get(protect, getComments).post(protect, addComment);
router.delete('/:commentId', protect, deleteComment);

module.exports = router;
