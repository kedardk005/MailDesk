/**
 * One shared guard for route parameters that are Mongo ObjectIds (audit H-10).
 *
 * Seven endpoints answered 500 for a mistyped id — `/api/tasks/notanoid`,
 * `/api/users/notanoid`, `/api/gmail/emails/notanoid`, `PUT
 * /api/notifications/:id/read`, `GET /api/tasks/:id/comments`, `DELETE
 * /api/keyword-rules/:id` and `DELETE /api/clients/:id` — because a Mongoose
 * `CastError` escaped to the generic catch. One of them (`PUT /api/clients/:id`)
 * leaked the raw driver message to the caller. A valid-but-absent id already
 * returned a clean 404 on every one of them, so the defect was specifically the
 * cast path.
 *
 * The correct pattern already existed at `clientController.getClientTimeline`
 * ("Invalid client ID"). Rather than copy it into seven controllers, it is
 * applied once per router as an Express `router.param` handler, which runs
 * BEFORE the route handler and only for routes that actually declare the
 * parameter. Controllers keep their own checks where they have them; this is a
 * belt-and-braces gate, not a replacement.
 *
 * Deliberately NOT applied to opaque non-ObjectId identifiers such as
 * `:threadId` (a Gmail conversation id), `:jobId` (a BullMQ id) or
 * `:attachmentId` (a Gmail attachment id).
 */

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/**
 * Build an Express `router.param` handler that rejects a malformed id with 400.
 *
 * @param {String} label - resource name used in the message, e.g. 'task'
 * @returns {Function} (req, res, next, value) => void
 */
const objectIdParam = (label) => (req, res, next, value) => {
  if (OBJECT_ID.test(String(value ?? ''))) return next();
  return res.status(400).json({
    message: `Invalid ${label} ID.`,
    code: 'INVALID_ID',
    errors: [{ path: 'params.id', message: `Invalid ${label} ID.` }]
  });
};

/**
 * Register `objectIdParam` for one or more parameter names on a router.
 *
 * @param {import('express').Router} router
 * @param {String} label
 * @param {String[]} [names]
 * @returns {import('express').Router} the same router, for chaining
 */
const guardObjectIdParams = (router, label, names = ['id']) => {
  for (const name of names) router.param(name, objectIdParam(label));
  return router;
};

/**
 * Standalone middleware form, for the few places where a router-level `param`
 * handler is not reachable (a sub-router mounted on a parent path whose
 * parameter is consumed by the parent).
 *
 * @param {String} name - the parameter name on req.params
 * @param {String} label
 * @returns {Function} express middleware
 */
const requireObjectIdParam = (name, label) => (req, res, next) =>
  objectIdParam(label)(req, res, next, req.params[name]);

module.exports = { objectIdParam, guardObjectIdParams, requireObjectIdParam, OBJECT_ID };
