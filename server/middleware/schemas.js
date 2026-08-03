const { z } = require('zod');
const { parseDeadline, isValidDeadline } = require('../utils/dateHelper');

// Mongo ObjectId shape. Validating this up front turns what used to be a
// Mongoose CastError -> 500 into a clean 400.
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const objectId = (label) => z.string().regex(OBJECT_ID, `${label} must be a valid ID.`);

/**
 * Deadline field: accepts ISO-8601 (with or without offset) or a bare date, and
 * normalizes to a UTC Date against APP_TIMEZONE. See utils/dateHelper.js.
 */
const deadlineField = z
  .union([z.string(), z.date()])
  .refine(isValidDeadline, 'Deadline must be a valid date.')
  .transform(parseDeadline);

/**
 * Nullable deadline for update payloads. An empty string from a cleared form
 * input is treated as "clear the deadline" rather than a validation failure.
 */
const nullableDeadlineField = z.preprocess(
  (value) => (value === '' ? null : value),
  deadlineField.nullable()
);

// Auth Schemas
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
  email: z.string().trim().email('Invalid email address.').max(254),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128, 'Password is too long.'),
  role: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address.').max(254),
  password: z.string().min(1, 'Password is required.').max(128)
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Invalid email address.').max(254)
});

const resetPasswordSchema = z.object({
  token: z.string().trim().min(1, 'Reset token is required.').max(256),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128, 'Password is too long.')
});

// User Schemas
const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
  email: z.string().trim().email('Invalid email address.').max(254),
  password: z.string().min(6, 'Password must be at least 6 characters.').max(128, 'Password is too long.'),
  // Zod 4 replaced `errorMap` with the unified `error` param; `errorMap` is
  // silently ignored, which is why these custom messages never appeared.
  role: z.enum(['Head', 'Employee'], { error: 'Invalid role selection. Must be Head or Employee.' })
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(120, 'Name is too long.').optional(),
  email: z.string().trim().email('Invalid email address.').max(254).optional(),
  role: z.enum(['Admin', 'Head', 'Employee'], { error: 'Invalid role selection.' }).optional(),
  status: z.enum(['Pending', 'Approved', 'Rejected'], { error: 'Invalid status selection.' }).optional(),
  // These two were previously absent, so Zod stripped them and the Admin's
  // Gmail permission controls were a silent no-op.
  maxConnectedAccounts: z.coerce
    .number()
    .int('Maximum connected accounts must be a whole number.')
    .min(0, 'Maximum connected accounts cannot be negative.')
    .max(50, 'Maximum connected accounts cannot exceed 50.')
    .optional(),
  allowedGmailAccounts: z
    .union([
      z.array(z.string().trim().email('Allowed Gmail accounts must be valid email addresses.')).max(100),
      // The UI also submits a comma-separated string; the controller splits it.
      z.string().max(5000)
    ])
    .optional()
});

const updateUserProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(120, 'Name is too long.').optional(),
  email: z.string().trim().email('Invalid email address.').max(254).optional(),
  birthdate: z.string().nullable().optional(),
  phoneNumber: z.string().max(40).optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.').max(128),
  newPassword: z.string().min(6, 'New password must be at least 6 characters.').max(128, 'Password is too long.')
});

// Gmail Schemas
const replyToEmailSchema = z.object({
  replyBody: z.string().trim().min(1, 'Reply body is required.').max(50000, 'Reply is too long.')
});

const bulkAssignEmailsSchema = z.object({
  emailIds: z
    .array(objectId('Email ID'))
    .min(1, 'At least one email ID is required.')
    .max(200, 'Cannot assign more than 200 emails at once.'),
  assignedTo: objectId('Assigned user ID'),
  deadline: deadlineField.optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent'], { error: 'Invalid priority.' }).optional()
});

const disconnectLinkedAccountSchema = z
  .object({
    gmailEmail: z.string().trim().email('Invalid email address.').optional(),
    userId: objectId('User ID').optional()
  })
  .refine((data) => data.gmailEmail || data.userId, {
    message: 'Either gmailEmail or userId is required.'
  });

// Task Schemas
const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.').max(300, 'Title is too long.'),
  clientName: z.string().trim().min(1, 'Client Name is required.').max(200, 'Client name is too long.'),
  description: z.string().max(20000, 'Description is too long.').optional(),
  assignedTo: objectId('Assignee'),
  deadline: deadlineField,
  isRecurring: z.boolean().optional(),
  recurrence: z.enum(['Daily', 'Weekly', 'Monthly'], { error: 'Invalid recurrence.' }).nullable().optional(),
  linkedEmail: objectId('Linked email').nullable().optional(),
  notes: z.string().max(20000, 'Notes are too long.').optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent'], { error: 'Invalid priority.' }).optional()
});

// PUT /api/tasks/:id previously had NO validation at all: `{"title":123}` hit
// `title.trim is not a function` -> 500, a bad status hit the Mongoose enum
// -> 500, and every string field was unbounded.
const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1, 'Title cannot be empty.').max(300, 'Title is too long.').optional(),
    description: z.string().max(20000, 'Description is too long.').optional(),
    clientName: z.string().trim().min(1, 'Client name cannot be empty.').max(200, 'Client name is too long.').optional(),
    notes: z.string().max(20000, 'Notes are too long.').optional(),
    deadline: nullableDeadlineField.optional(),
    status: z.enum(['Pending', 'Completed', 'Late'], { error: 'Status must be Pending, Completed, or Late.' }).optional(),
    priority: z.enum(['Low', 'Medium', 'High', 'Urgent'], { error: 'Priority must be Low, Medium, High, or Urgent.' }).optional(),
    assignedTo: objectId('Assignee').nullable().optional(),
    isRecurring: z.boolean().optional(),
    recurrence: z.enum(['Daily', 'Weekly', 'Monthly'], { error: 'Invalid recurrence.' }).nullable().optional()
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No updatable fields were provided.'
  });

const bulkTaskSchema = z.object({
  taskIds: z
    .array(objectId('Task ID'))
    .min(1, 'At least one task ID is required.')
    .max(500, 'Cannot act on more than 500 tasks at once.'),
  action: z.enum(['delete', 'status', 'reassign'], { error: 'Action must be delete, status, or reassign.' }),
  value: z.string().max(200).optional()
});

// Keyword Rule Schemas
const bulkApproveSchema = z.object({
  // A missing keyword previously swept EVERY pending email in the workspace.
  keyword: z
    .string({ error: 'A keyword is required for bulk approval.' })
    .trim()
    .min(1, 'A keyword is required for bulk approval.')
    .max(100),
  targetUserId: objectId('Target user ID').optional()
});

const updateKeywordRuleSchema = z.object({
  assignedTo: objectId('Assigned user ID').optional(),
  autoApprove: z.boolean().optional(),
  isActive: z.boolean().optional()
});

// F-2 — SLA policy. `clientId` absent means the single global policy row.
// Every bound here exists so a policy cannot be configured into a state that
// makes the breach calculation meaningless (a zero-length working day, a
// target of zero minutes, a 400-entry working-day list).
const slaPolicySchema = z
  .object({
    clientId: objectId('Client ID').optional(),
    firstResponseMinutes: z.coerce
      .number()
      .int('First-response target must be a whole number of minutes.')
      .min(1, 'First-response target must be at least 1 minute.')
      .max(60 * 24 * 365, 'First-response target is too large.')
      .optional(),
    resolutionMinutes: z.coerce
      .number()
      .int('Resolution target must be a whole number of minutes.')
      .min(1, 'Resolution target must be at least 1 minute.')
      .max(60 * 24 * 365, 'Resolution target is too large.')
      .optional(),
    businessHours: z
      .object({
        enabled: z.boolean().optional(),
        startHour: z.coerce.number().int().min(0).max(23).optional(),
        endHour: z.coerce.number().int().min(1).max(24).optional(),
        workingDays: z.array(z.coerce.number().int().min(1).max(7)).min(1).max(7).optional(),
        timezone: z.string().trim().max(64).nullable().optional()
      })
      .optional()
  })
  .refine(
    (data) =>
      data.firstResponseMinutes !== undefined ||
      data.resolutionMinutes !== undefined ||
      data.businessHours !== undefined,
    { message: 'Nothing to update. Provide a target or a business-hours calendar.' }
  )
  .refine(
    (data) =>
      !data.businessHours ||
      data.businessHours.startHour === undefined ||
      data.businessHours.endHour === undefined ||
      data.businessHours.endHour > data.businessHours.startHour,
    { message: 'Business hours must end after they start.' }
  );

/**
 * F-3 — POST /api/ai/extract-actions.
 *
 * An ID, never a body payload. `.strict()` is deliberate: a client that tries
 * to POST `{ emailId, body: '<3 MB of html>' }` gets a 400 that names the
 * offending key rather than a 413 from `express.json()`.
 */
const extractActionsSchema = z
  .object({
    emailId: objectId('Email ID').optional(),
    // Gmail thread ids are opaque strings, not ObjectIds.
    threadId: z.string().trim().min(1, 'Thread ID is required.').max(200, 'Thread ID is too long.').optional()
  })
  .strict('Only emailId or threadId may be sent. Never send the email body.')
  .refine((data) => Boolean(data.emailId) !== Boolean(data.threadId), {
    message: 'Provide exactly one of emailId or threadId.'
  });

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  createUserSchema,
  updateUserSchema,
  updateUserProfileSchema,
  changePasswordSchema,
  replyToEmailSchema,
  bulkAssignEmailsSchema,
  disconnectLinkedAccountSchema,
  createTaskSchema,
  updateTaskSchema,
  bulkTaskSchema,
  bulkApproveSchema,
  updateKeywordRuleSchema,
  slaPolicySchema,
  extractActionsSchema
};
