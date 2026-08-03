/**
 * Express middleware to validate a request body against a Zod schema.
 *
 * Zod 4 removed `ZodError.errors` in favour of `ZodError.issues`. Reading
 * `.errors[0]` therefore threw a TypeError, which Express turned into a 500 for
 * EVERY validation failure on every validated route. `safeParse` removes the
 * throw path entirely and `.issues` is the Zod 4 accessor.
 *
 * @param {import('zod').ZodType} schema - The Zod schema to validate against
 */
const validate = (schema) => (req, res, next) => {
  // express.json() leaves req.body undefined for an empty request; normalise it
  // so a missing body produces a clean 400 rather than a schema crash.
  const result = schema.safeParse(req.body ?? {});

  if (!result.success) {
    const issues = result.error.issues || [];
    return res.status(400).json({
      // Preserved response shape: clients already read `message`.
      message: issues[0]?.message || 'Validation failed.',
      errors: issues.map((issue) => ({
        path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? ''),
        message: issue.message
      }))
    });
  }

  req.body = result.data; // Parsed data (strips unknown keys, coerces types)
  return next();
};

module.exports = validate;
