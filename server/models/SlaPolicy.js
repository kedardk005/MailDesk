const mongoose = require('mongoose');

/**
 * F-2 — SLA targets.
 *
 * Deliberately a tiny collection: exactly one `global` row plus at most one row
 * per client. There is no per-user, per-queue or per-priority policy in this
 * wave; FEATURE-SPEC.md says "start with a single global default and a
 * per-client override" and anything richer is un-evictable complexity in the
 * breach calculation.
 *
 * When no row exists at all the effective policy comes from the environment
 * (SLA_FIRST_RESPONSE_MINUTES / SLA_RESOLUTION_MINUTES / SLA_BUSINESS_*), so
 * the endpoints work on a database that has never been configured.
 */
const SlaPolicySchema = new mongoose.Schema({
  scope: {
    type: String,
    enum: ['global', 'client'],
    default: 'global'
  },
  // Null for the global row. The unique compound index below therefore also
  // enforces "at most one global policy".
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    default: null
  },
  firstResponseMinutes: {
    type: Number,
    default: null,
    min: 1,
    max: 60 * 24 * 365
  },
  resolutionMinutes: {
    type: Number,
    default: null,
    min: 1,
    max: 60 * 24 * 365
  },
  // Optional business-hours calendar. When enabled, elapsed time is measured
  // only inside the working windows, resolved in APP_TIMEZONE (or `timezone`
  // when set) by utils/slaCalendar.js.
  businessHours: {
    enabled: { type: Boolean, default: false },
    // Wall-clock hours in the policy timezone. `endHour` is exclusive.
    startHour: { type: Number, default: 9, min: 0, max: 23 },
    endHour: { type: Number, default: 18, min: 1, max: 24 },
    // ISO weekday numbers, 1 = Monday … 7 = Sunday.
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    // Null means "use APP_TIMEZONE".
    timezone: { type: String, default: null }
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// One row per scope+client. `client` is null on the global row, and a plain
// unique compound index treats null as a value, so this is also what stops a
// second global policy from ever being created.
SlaPolicySchema.index({ scope: 1, client: 1 }, { unique: true });

module.exports = mongoose.model('SlaPolicy', SlaPolicySchema);
