const User = require('../models/User');
const cache = require('./cache');
const { log } = require('./logger');

const logger = log('notif-prefs');

/**
 * Notification preference resolution and ENFORCEMENT (WAVE2 gap S-12).
 *
 * A preference that does not actually suppress anything is worse than no
 * preference at all, so this module is required by BOTH delivery paths:
 *
 *   utils/notificationHelper.js -> in-app notifications
 *   utils/emailHelper.js        -> outbound email
 *
 * Fail-OPEN by design: if the lookup fails, or the user has no preferences yet,
 * or the event type is unknown, the notification is DELIVERED. Losing an
 * "your account was approved" mail because Redis blipped is worse than sending
 * one the user had muted.
 *
 * TRANSACTIONAL MAIL IS NEVER SUPPRESSED. `sendEmail()` only consults
 * preferences when the caller passes an explicit `event`, so password resets and
 * account-approval mails go out regardless of the user's settings.
 */

const { NOTIFICATION_EVENTS } = User;

const CHANNELS = ['inApp', 'email'];

/** @returns {Object} a fresh, fully-populated default preference object */
const defaultPreferences = () => ({
  inApp: {
    enabled: true,
    events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true]))
  },
  email: {
    enabled: true,
    events: Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, true]))
  },
  quietHours: {
    enabled: false,
    start: '22:00',
    end: '07:00',
    timezone: process.env.APP_TIMEZONE || 'Asia/Kolkata'
  }
});

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Fill in anything missing from a stored (or partial) preference object, so
 * every consumer sees the complete shape. Unknown keys are dropped.
 *
 * @param {Object} [raw]
 * @returns {Object} complete preferences
 */
const normalizePreferences = (raw) => {
  const base = defaultPreferences();
  if (!raw || typeof raw !== 'object') return base;

  const source = typeof raw.toObject === 'function' ? raw.toObject() : raw;

  for (const channel of CHANNELS) {
    const incoming = source[channel];
    if (!incoming || typeof incoming !== 'object') continue;
    if (typeof incoming.enabled === 'boolean') base[channel].enabled = incoming.enabled;
    const events = incoming.events && typeof incoming.events === 'object'
      ? (typeof incoming.events.toObject === 'function' ? incoming.events.toObject() : incoming.events)
      : null;
    if (events) {
      for (const event of NOTIFICATION_EVENTS) {
        if (typeof events[event] === 'boolean') base[channel].events[event] = events[event];
      }
    }
  }

  const quiet = source.quietHours;
  if (quiet && typeof quiet === 'object') {
    if (typeof quiet.enabled === 'boolean') base.quietHours.enabled = quiet.enabled;
    if (typeof quiet.start === 'string' && HHMM.test(quiet.start)) base.quietHours.start = quiet.start;
    if (typeof quiet.end === 'string' && HHMM.test(quiet.end)) base.quietHours.end = quiet.end;
    if (typeof quiet.timezone === 'string' && quiet.timezone.trim()) {
      base.quietHours.timezone = quiet.timezone.trim().slice(0, 64);
    }
  }

  return base;
};

/**
 * Apply a PARTIAL update on top of the current preferences.
 *
 * The endpoint is a PUT but behaves as a deep merge, so a client can send only
 * the toggle it changed without having to round-trip the whole object (and
 * without a concurrent tab clobbering an unrelated flag).
 *
 * @param {Object} current - normalized current preferences
 * @param {Object} patch - arbitrary caller input
 * @returns {{preferences: Object, errors: String[]}}
 */
const mergePreferences = (current, patch) => {
  const next = normalizePreferences(current);
  const errors = [];

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { preferences: next, errors: ['A preferences object is required.'] };
  }

  for (const channel of CHANNELS) {
    const incoming = patch[channel];
    if (incoming === undefined) continue;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      errors.push(`${channel} must be an object.`);
      continue;
    }
    if (incoming.enabled !== undefined) {
      if (typeof incoming.enabled !== 'boolean') errors.push(`${channel}.enabled must be a boolean.`);
      else next[channel].enabled = incoming.enabled;
    }
    if (incoming.events !== undefined) {
      if (!incoming.events || typeof incoming.events !== 'object' || Array.isArray(incoming.events)) {
        errors.push(`${channel}.events must be an object.`);
        continue;
      }
      for (const [event, value] of Object.entries(incoming.events)) {
        if (!NOTIFICATION_EVENTS.includes(event)) {
          errors.push(`Unknown notification event "${event}".`);
          continue;
        }
        if (typeof value !== 'boolean') {
          errors.push(`${channel}.events.${event} must be a boolean.`);
          continue;
        }
        next[channel].events[event] = value;
      }
    }
  }

  if (patch.quietHours !== undefined) {
    const quiet = patch.quietHours;
    if (!quiet || typeof quiet !== 'object' || Array.isArray(quiet)) {
      errors.push('quietHours must be an object.');
    } else {
      if (quiet.enabled !== undefined) {
        if (typeof quiet.enabled !== 'boolean') errors.push('quietHours.enabled must be a boolean.');
        else next.quietHours.enabled = quiet.enabled;
      }
      for (const bound of ['start', 'end']) {
        if (quiet[bound] === undefined) continue;
        if (typeof quiet[bound] !== 'string' || !HHMM.test(quiet[bound])) {
          errors.push(`quietHours.${bound} must be a 24-hour "HH:MM" time.`);
        } else {
          next.quietHours[bound] = quiet[bound];
        }
      }
      if (quiet.timezone !== undefined) {
        if (typeof quiet.timezone !== 'string' || !isValidTimezone(quiet.timezone)) {
          errors.push('quietHours.timezone must be a valid IANA time zone.');
        } else {
          next.quietHours.timezone = quiet.timezone.trim();
        }
      }
    }
  }

  return { preferences: next, errors };
};

/**
 * @param {String} tz
 * @returns {Boolean}
 */
const isValidTimezone = (tz) => {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
};

/**
 * Minutes past local midnight for `at` in `timezone`.
 * @param {Date} at
 * @param {String} timezone
 * @returns {Number}
 */
const minutesInZone = (at, timezone) => {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    // Some ICU builds render midnight as "24".
    return ((hour % 24) * 60) + minute;
  } catch {
    return at.getHours() * 60 + at.getMinutes();
  }
};

/**
 * Is `at` inside the configured quiet window? Windows that wrap midnight
 * (22:00 -> 07:00) are handled; an equal start and end means "never".
 *
 * @param {Object} prefs - normalized preferences
 * @param {Date} [at]
 * @returns {Boolean}
 */
const inQuietHours = (prefs, at = new Date()) => {
  const quiet = prefs?.quietHours;
  if (!quiet || !quiet.enabled) return false;

  const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  };

  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;

  const now = minutesInZone(at, quiet.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
};

/**
 * Load one user's preferences, cached.
 *
 * Cached for the same reason the auth lookup is: this runs on every
 * notification write, and the overdue cron fans out to every supervisor.
 *
 * @param {String} userId
 * @returns {Promise<Object>} normalized preferences (defaults on any failure)
 */
const getPreferences = async (userId) => {
  if (!userId) return defaultPreferences();
  try {
    return await cache.wrap(
      cache.KEYS.notificationPrefs(String(userId)),
      cache.TTL.notificationPrefs,
      async () => {
        const user = await User.findById(userId).select('notificationPreferences').lean();
        return normalizePreferences(user?.notificationPreferences);
      }
    );
  } catch (err) {
    // Fail open.
    logger.debug({ err: err.message, userId: String(userId) }, 'preference lookup failed; delivering');
    return defaultPreferences();
  }
};

/**
 * Should `event` be delivered to `userId` over `channel` right now?
 *
 * @param {String} userId
 * @param {'inApp'|'email'} channel
 * @param {String} [event] - one of User.NOTIFICATION_EVENTS
 * @param {Date} [at]
 * @returns {Promise<Boolean>}
 */
const shouldDeliver = async (userId, channel, event, at = new Date()) => {
  // No event type => not a preference-governed message (transactional mail).
  if (!event) return true;
  if (!CHANNELS.includes(channel)) return true;

  const prefs = await getPreferences(userId);
  return allows(prefs, channel, event, at);
};

/**
 * Pure predicate over an already-loaded preference object. Used by the batch
 * path so N recipients cost N cache reads and zero extra logic.
 *
 * @param {Object} prefs - normalized preferences
 * @param {'inApp'|'email'} channel
 * @param {String} event
 * @param {Date} [at]
 * @returns {Boolean}
 */
const allows = (prefs, channel, event, at = new Date()) => {
  if (!event) return true;
  const channelPrefs = prefs?.[channel];
  if (!channelPrefs) return true;
  if (channelPrefs.enabled === false) return false;

  // An unrecognised event type is treated as `system`, which is on by default,
  // so a new notification type can never be silently swallowed by a stale
  // preference document.
  const key = NOTIFICATION_EVENTS.includes(event) ? event : 'system';
  if (channelPrefs.events?.[key] === false) return false;

  // Quiet hours suppress EMAIL only. An in-app notification is a passive inbox
  // item — dropping it would destroy the record rather than defer a ping.
  if (channel === 'email' && inQuietHours(prefs, at)) return false;

  return true;
};

/** Drop the cached copy after a preference write. @param {String} userId @returns {Promise<void>} */
const invalidate = (userId) => cache.del(cache.KEYS.notificationPrefs(String(userId)));

module.exports = {
  NOTIFICATION_EVENTS,
  CHANNELS,
  defaultPreferences,
  normalizePreferences,
  mergePreferences,
  getPreferences,
  shouldDeliver,
  allows,
  inQuietHours,
  isValidTimezone,
  invalidate
};
