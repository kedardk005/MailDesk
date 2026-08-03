const mongoose = require('mongoose');

/**
 * Canonical notification event types (WAVE2 gap S-12).
 *
 * Every `createNotification(... type)` call and every preference-aware
 * `sendEmail(..., { event })` call uses one of these. Anything unrecognised is
 * treated as `system`, which is on by default, so an un-typed notification can
 * never be silently swallowed.
 */
const NOTIFICATION_EVENTS = [
  'task_assigned',
  'task_completed',
  'task_overdue',
  'task_comment',
  'email_assigned',
  'email_approval',
  'system'
];

/** @returns {Object} a mongoose path definition, one boolean per event, all true */
const eventFlags = () =>
  Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, { type: Boolean, default: true }]));

const ChannelPrefsSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    events: { type: new mongoose.Schema(eventFlags(), { _id: false }), default: () => ({}) }
  },
  { _id: false }
);

// "HH:MM", 24-hour. Validated here so a malformed value can never reach the
// quiet-hours comparison and silently suppress everything.
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const QuietHoursSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // Windows may wrap midnight (start 22:00, end 07:00) — handled in
    // utils/notificationPrefs.js.
    start: { type: String, default: '22:00', match: HHMM },
    end: { type: String, default: '07:00', match: HHMM },
    timezone: { type: String, default: process.env.APP_TIMEZONE || 'Asia/Kolkata' }
  },
  { _id: false }
);

const NotificationPreferencesSchema = new mongoose.Schema(
  {
    inApp: { type: ChannelPrefsSchema, default: () => ({}) },
    email: { type: ChannelPrefsSchema, default: () => ({}) },
    quietHours: { type: QuietHoursSchema, default: () => ({}) }
  },
  { _id: false }
);

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    select: false
  },
  role: {
    type: String,
    enum: ['Admin', 'Head', 'Employee'],
    default: 'Employee',
    required: true
  },
  gmailAccessToken: {
    type: String,
    default: null,
    select: false
  },
  gmailRefreshToken: {
    type: String,
    default: null,
    select: false
  },
  gmailEmail: {
    type: String,
    default: ""
  },
  linkedGmailAccounts: {
    type: [
      {
        gmailEmail: { type: String, required: true },
        gmailAccessToken: { type: String, default: null },
        gmailRefreshToken: { type: String, default: null }
      }
    ],
    default: [],
    select: false
  },
  maxConnectedAccounts: {
    type: Number,
    default: 5
  },
  allowedGmailAccounts: {
    type: [String],
    default: []
  },
  birthdate: {
    type: Date,
    default: null
  },
  phoneNumber: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['Pending', 'Approved', 'Rejected'],
    default: 'Approved'
  },
  tokenVersion: {
    type: Number,
    default: 0
  },
  // WAVE2 gap S-4. The admin user list had no last-activity column at all, so
  // there was no way to tell a dormant account from an active one. Written on
  // every successful login (see authController.loginUser).
  lastLoginAt: {
    type: Date,
    default: null
  },
  // WAVE2 gap S-12. Defaults are "everything on", so an account created before
  // this existed behaves exactly as it did — the sub-document is materialised
  // lazily by utils/notificationPrefs.js when it is absent.
  notificationPreferences: {
    type: NotificationPreferencesSchema,
    default: () => ({})
  },
  // Password reset: only the SHA-256 hash of the single-use token is stored, so
  // a database read cannot be replayed into an account takeover.
  resetTokenHash: {
    type: String,
    default: null,
    select: false
  },
  resetTokenExpires: {
    type: Date,
    default: null,
    select: false
  },
  // Soft delete, so a departed user's activity logs and comments survive.
  deletedAt: {
    type: Date,
    default: null
  },
  deletedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  // On soft delete `email` is tombstoned so the unique index is freed and the
  // address can be re-registered; the original is preserved here for the audit.
  deletedEmail: {
    type: String,
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// `role` was scanned by the overdue cron EVERY 60 SECONDS with no index, plus
// on every reports call and every role change.
UserSchema.index({ role: 1 });
UserSchema.index({ status: 1 });
UserSchema.index({ role: 1, status: 1, deletedAt: 1 });
UserSchema.index({ createdAt: -1 });
UserSchema.index({ deletedAt: 1, createdAt: -1 });

// S-4: `lastLoginAt` is exposed AND sortable on GET /api/users, so the
// (filter + sort) compound has to exist or the sort is an in-memory one.
UserSchema.index({ deletedAt: 1, lastLoginAt: -1 });

// Gmail account lookup. Not unique: `gmailEmail` defaults to '' for every user
// who has never connected an inbox, so a unique index would reject the second
// such user. Uniqueness is enforced at the source in the OAuth callback (409).
UserSchema.index({ gmailEmail: 1 });
UserSchema.index({ 'linkedGmailAccounts.gmailEmail': 1 });

// The auto-sync cron selects connected mailboxes; partial keeps the index to
// the (small) subset of users who actually have a token.
UserSchema.index(
  { gmailAccessToken: 1 },
  { partialFilterExpression: { gmailAccessToken: { $type: 'string' } } }
);

const User = mongoose.model('User', UserSchema);

module.exports = User;
module.exports.NOTIFICATION_EVENTS = NOTIFICATION_EVENTS;
