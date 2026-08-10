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

/*
 * L-3 — the password minimum was SIX characters, on an application that holds
 * a firm's entire client correspondence.
 *
 * Twelve is the floor now. The reasoning, in order of weight:
 *
 *  - NIST SP 800-63B requires 8 as an absolute minimum and explicitly favours
 *    length over composition rules; 12 is the length at which an offline
 *    attack on a bcrypt hash stops being routine, and it is what CIS and the
 *    UK NCSC's "three random words" guidance land on in practice.
 *  - There is no composition requirement to go with it, deliberately: forced
 *    symbol/digit classes push users to `Passw0rd!` (11 characters, minutes to
 *    guess) while a 12-character passphrase is not guessable at all. Length is
 *    the only rule here.
 *  - No maximum was lowered: 128 stays, so a password manager's output fits.
 *
 * THIS GOVERNS NEW PASSWORDS ONLY. `loginSchema` keeps `min(1)`, so every
 * existing account — including any created under the old six-character rule —
 * still signs in unchanged. The next password they SET must meet the new floor.
 *
 * PASSWORD_MIN_LENGTH tunes it for an operator with a stricter policy; it is
 * clamped to [8, 64] so the variable can only ever be used to tighten past the
 * defensible minimum, never to reopen the six-character hole.
 */
const PASSWORD_MIN_LENGTH = Math.min(
  64,
  Math.max(8, Number(process.env.PASSWORD_MIN_LENGTH) || 12)
);
const PASSWORD_MAX_LENGTH = 128;

/**
 * The field every "set a new password" payload uses.
 * @param {String} label - how the field is named to the user
 * @returns {import('zod').ZodType}
 */
const newPasswordField = (label = 'Password') =>
  z
    .string({ error: `${label} must be text.` })
    .min(PASSWORD_MIN_LENGTH, `${label} must be at least ${PASSWORD_MIN_LENGTH} characters.`)
    .max(PASSWORD_MAX_LENGTH, `${label} is too long.`);

// Auth Schemas
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
  email: z.string().trim().email('Invalid email address.').max(254),
  password: newPasswordField(),
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
  password: newPasswordField()
});

// User Schemas
const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
  email: z.string().trim().email('Invalid email address.').max(254),
  password: newPasswordField(),
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
})
  /*
   * M-13 (related) — every field here is optional, so `PUT /api/users/:id`
   * with `{}` answered 200 and the unchanged user: a malformed edit was a
   * silent no-op write that looked like a successful save, and an Admin who
   * mistyped a key was told the change had been applied. `updateTaskSchema`
   * and `updateClientSchema` already refuse an empty payload; this one now
   * matches them.
   *
   * Zod strips unknown keys BEFORE this runs, so `{"emial": "x"}` is empty by
   * the time it gets here and is refused for the same reason.
   */
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No updatable fields were provided.'
  });

const updateUserProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').max(120, 'Name is too long.').optional(),
  email: z.string().trim().email('Invalid email address.').max(254).optional(),
  birthdate: z.string().nullable().optional(),
  phoneNumber: z.string().max(40).optional()
});

const changePasswordSchema = z.object({
  // The CURRENT password is only ever compared against a stored hash, so it
  // must not carry the new minimum: an account created under the old
  // six-character rule has to be able to type its existing password in order
  // to replace it (L-3).
  currentPassword: z.string().min(1, 'Current password is required.').max(PASSWORD_MAX_LENGTH),
  newPassword: newPasswordField('New password')
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

/**
 * H-2 — POST /api/ai/summarize-email.
 *
 * The id form (`{ emailId }`) is what the client has always sent and is the
 * only shape that avoids posting a multi-megabyte body back at the server. The
 * legacy `{ subject, from, body }` form is still accepted so nothing that
 * predates the fix breaks; deliberately NOT `.strict()` for the same reason.
 *
 * "Exactly one of emailId/threadId" is enforced here; "there is something to
 * summarise at all" stays in the controller, which already answers 400 with the
 * message existing callers match on.
 */
const summarizeEmailSchema = z
  .object({
    emailId: objectId('Email ID').optional(),
    threadId: z.string().trim().min(1, 'Thread ID is required.').max(200, 'Thread ID is too long.').optional(),
    subject: z.string().max(2000, 'Subject is too long.').optional(),
    from: z.string().max(320, 'Sender is too long.').optional(),
    body: z.string().max(500000, 'Email body is too long.').optional()
  })
  .refine((data) => !(data.emailId && data.threadId), {
    message: 'Provide either emailId or threadId, not both.'
  });

/**
 * H-9 — POST /api/clients had NO validation at all. `{"name":[]}` reached
 * `name.trim()` and returned 500 `"name.trim is not a function"`; a 5,000
 * character name was accepted with 201. Bounds mirror `createUserSchema`
 * (names capped at 120 there, 200 here to match `createTaskSchema.clientName`,
 * which is the field these names are joined against).
 */
const clientEmailList = z
  .union(
    [
      z
        .array(z.string({ error: 'Associated emails must be text.' }).trim().email('Associated emails must be valid email addresses.').max(254))
        .max(50, 'Too many associated email addresses.'),
      // The UI also submits a comma-separated string; the controller splits it.
      z.string().max(5000, 'Associated emails list is too long.')
    ],
    { error: 'Associated emails must be a list of email addresses.' }
  )
  .optional();

const createClientSchema = z.object({
  // The explicit type-level `error` matters: without it `{"name":[]}` leads
  // with Zod's own "Invalid input: expected string, received array", which is
  // the wire format's complaint rather than the user's.
  name: z
    .string({ error: 'Client name must be text.' })
    .trim()
    .min(1, 'Client name is required.')
    .max(200, 'Client name is too long.'),
  associatedEmails: clientEmailList,
  contactPerson: z.string().trim().max(200, 'Contact person is too long.').optional(),
  email: z.union([z.literal(''), z.string().trim().email('Invalid email address.').max(254)]).optional(),
  phone: z.string().trim().max(40, 'Phone number is too long.').optional(),
  notes: z.string().max(20000, 'Notes are too long.').optional(),
  status: z.enum(['Active', 'Inactive'], { error: 'Status must be Active or Inactive.' }).optional()
});

const updateClientSchema = createClientSchema
  .partial()
  .refine((data) => Object.keys(data).length > 0, { message: 'No updatable fields were provided.' });

module.exports = {
  PASSWORD_MIN_LENGTH,
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
  extractActionsSchema,
  summarizeEmailSchema,
  createClientSchema,
  updateClientSchema
};
