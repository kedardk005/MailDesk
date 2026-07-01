const { ZodError } = require('zod');

/**
 * Express middleware to validate request body using a Zod schema
 * @param {ZodSchema} schema - The Zod schema to validate against
 */
const validate = (schema) => (req, res, next) => {
  try {
    const parsed = schema.parse(req.body);
    req.body = parsed; // Use parsed data (strips unknown keys, coerces types)
    next();
  } catch (error) {
    if (error instanceof ZodError) {
      // Return first validation error message in format { message: "..." }
      const firstError = error.errors[0]?.message || 'Validation failed.';
      return res.status(400).json({ message: firstError });
    }
    next(error);
  }
};

module.exports = validate;
