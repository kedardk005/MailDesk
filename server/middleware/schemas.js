const { z } = require('zod');

// Auth Schemas
const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  email: z.string().trim().email('Invalid email address.'),
  password: z.string().min(6, 'Password must be at least 6 characters.'),
  role: z.string().optional()
});

const loginSchema = z.object({
  email: z.string().trim().email('Invalid email address.'),
  password: z.string().min(1, 'Password is required.')
});

const forgotPasswordSchema = z.object({
  email: z.string().trim().email('Invalid email address.')
});

// User Schemas
const createUserSchema = z.object({
  name: z.string().trim().min(1, 'Name is required.'),
  email: z.string().trim().email('Invalid email address.'),
  password: z.string().min(6, 'Password must be at least 6 characters.'),
  role: z.enum(['Head', 'Employee'], {
    errorMap: () => ({ message: 'Invalid role selection. Must be Head or Employee.' })
  })
});

const updateUserSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').optional(),
  email: z.string().trim().email('Invalid email address.').optional(),
  role: z.enum(['Admin', 'Head', 'Employee'], {
    errorMap: () => ({ message: 'Invalid role selection.' })
  }).optional(),
  status: z.enum(['Pending', 'Approved', 'Rejected'], {
    errorMap: () => ({ message: 'Invalid status selection.' })
  }).optional()
});

const updateUserProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty.').optional(),
  email: z.string().trim().email('Invalid email address.').optional(),
  birthdate: z.string().nullable().optional(),
  phoneNumber: z.string().optional()
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required.'),
  newPassword: z.string().min(6, 'New password must be at least 6 characters.')
});

// Gmail Schemas
const replyToEmailSchema = z.object({
  replyBody: z.string().trim().min(1, 'Reply body is required.')
});

const bulkAssignEmailsSchema = z.object({
  emailIds: z.array(z.string()).min(1, 'At least one email ID is required.'),
  assignedTo: z.string().min(1, 'Assigned user ID is required.'),
  deadline: z.string().optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional()
});

const disconnectLinkedAccountSchema = z.object({
  gmailEmail: z.string().trim().email('Invalid email address.').optional(),
  userId: z.string().optional()
}).refine((data) => data.gmailEmail || data.userId, {
  message: 'Either gmailEmail or userId is required.'
});

// Task Schemas
const createTaskSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  clientName: z.string().trim().min(1, 'Client Name is required.'),
  description: z.string().optional(),
  assignedTo: z.string().min(1, 'Assignee is required.'),
  deadline: z.string().min(1, 'Deadline is required.'),
  isRecurring: z.boolean().optional(),
  recurrence: z.string().nullable().optional(),
  linkedEmail: z.string().nullable().optional(),
  notes: z.string().optional(),
  priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional()
});

const bulkTaskSchema = z.object({
  taskIds: z.array(z.string()).min(1, 'At least one task ID is required.'),
  action: z.enum(['delete', 'status', 'reassign'], {
    errorMap: () => ({ message: "Action must be delete, status, or reassign." })
  }),
  value: z.string().optional()
});

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  createUserSchema,
  updateUserSchema,
  updateUserProfileSchema,
  changePasswordSchema,
  replyToEmailSchema,
  bulkAssignEmailsSchema,
  disconnectLinkedAccountSchema,
  createTaskSchema,
  bulkTaskSchema
};
