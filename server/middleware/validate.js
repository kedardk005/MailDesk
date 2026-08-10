/*
 * M-13 — the headline used to be `issues[0].message` verbatim, so an empty
 * `POST /api/tasks` led with Zod's own wire-format complaint:
 *
 *   "Invalid input: expected string, received undefined"
 *
 * which names no field, describes no user-visible problem, and reads as a bug
 * report about the client rather than a prompt to the person filling the form.
 * The useful detail was in `errors[]` all along.
 *
 * The rule now:
 *  - one issue with a path  -> "Client name is required." style messages are
 *    already field-specific, so they pass through; a message that is only about
 *    the wire type gets its field prepended.
 *  - several issues         -> a summary naming the fields, with the full list
 *    still in `errors[]`.
 *
 * `errors[]` is never touched, so anything already reading it is unaffected.
 */

// Zod's type-level complaints. These describe the JSON, not the field, so they
// are useless as a headline on their own.
const WIRE_FORMAT = /^Invalid input: expected /i;

/**
 * Render a field path the way a form label would read it.
 * @param {String} path
 * @returns {String}
 */
const labelFor = (path) =>
  String(path || '')
    .split('.')
    .filter((part) => part && !/^\d+$/.test(part))
    .join(' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

/**
 * The user-facing headline for a set of field errors.
 * @param {Array<{path: String, message: String}>} errors
 * @returns {String}
 */
const headline = (errors) => {
  if (errors.length === 0) return 'Validation failed.';

  if (errors.length === 1) {
    const [only] = errors;
    if (only.path && WIRE_FORMAT.test(only.message)) {
      return `${labelFor(only.path)}: ${only.message}`;
    }
    return only.message || 'Validation failed.';
  }

  const fields = [...new Set(errors.map((e) => labelFor(e.path)).filter(Boolean))];
  if (fields.length === 0) return errors[0].message || 'Validation failed.';
  return `Check ${fields.length === 1 ? 'this field' : 'these fields'}: ${fields.join(', ')}.`;
};

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
    const errors = issues.map((issue) => ({
      path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path ?? ''),
      message: issue.message
    }));

    return res.status(400).json({
      // Preserved response shape: clients already read `message`.
      message: headline(errors),
      errors
    });
  }

  req.body = result.data; // Parsed data (strips unknown keys, coerces types)
  return next();
};

module.exports = validate;
