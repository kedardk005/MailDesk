/**
 * Deadline / timezone normalization.
 *
 * Previously raw client strings were assigned straight into a Mongoose `Date`,
 * which produced two distinct bugs:
 *   1. A `datetime-local` value with no offset ("2026-08-05T17:00") is parsed as
 *      local time of the SERVER, so a UTC-hosted API shifted every IST deadline
 *      by 5h30m.
 *   2. A bare date ("2026-08-05") is spec-mandated to parse as UTC midnight,
 *      i.e. 05:30 IST, so a task due "today" flipped to Late before work began.
 *
 * Everything is now resolved explicitly against APP_TIMEZONE and stored as a
 * UTC instant.
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

const getAppTimezone = () => process.env.APP_TIMEZONE || DEFAULT_TIMEZONE;

// "2026-08-05"
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// "2026-08-05T17:00" / "2026-08-05T17:00:00" / "2026-08-05 17:00" — no offset
const NAIVE_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
// Any explicit offset designator: Z, +05:30, -0800
const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * How far ahead of UTC the given zone is at the given instant, in milliseconds.
 */
const timezoneOffsetMs = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
    .formatToParts(date)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  // formatToParts only resolves to whole seconds, so compare against the input
  // truncated to the same granularity — otherwise the sub-second remainder is
  // folded into the offset and shifts the result (end-of-day landing at
  // 00:00:00.997 of the NEXT day instead of 23:59:59.999).
  return asIfUtc - (date.getTime() - date.getUTCMilliseconds());
};

/**
 * Convert a wall-clock reading in `timeZone` into the corresponding UTC instant.
 * Applied twice so a DST transition resolves correctly (a no-op for IST).
 */
const zonedWallClockToUtc = (year, month, day, hour, minute, second, ms, timeZone) => {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  let instant = naive - timezoneOffsetMs(new Date(naive), timeZone);
  instant = naive - timezoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
};

/**
 * Normalize any accepted deadline representation to a UTC `Date`.
 *
 * - ISO-8601 carrying an explicit offset (or `Z`) is unambiguous: used as-is.
 * - A naive date-time is interpreted as wall-clock time in APP_TIMEZONE.
 * - A bare date is interpreted as END OF DAY in APP_TIMEZONE, so a task due
 *   "today" stays on time until the working day is actually over.
 *
 * @param {String|Date|Number} value
 * @returns {Date|null} null when the value is absent or unparseable
 */
const parseDeadline = (value) => {
  if (value === null || value === undefined || value === '') return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === 'number') {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;
  const timeZone = getAppTimezone();

  if (DATE_ONLY.test(raw)) {
    const [year, month, day] = raw.split('-').map(Number);
    return zonedWallClockToUtc(year, month, day, 23, 59, 59, 999, timeZone);
  }

  const naive = raw.match(NAIVE_DATETIME);
  if (naive && !HAS_OFFSET.test(raw)) {
    return zonedWallClockToUtc(
      Number(naive[1]),
      Number(naive[2]),
      Number(naive[3]),
      Number(naive[4]),
      Number(naive[5]),
      Number(naive[6] || 0),
      0,
      timeZone
    );
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * True when the value can be normalized. Used by the Zod schemas.
 * @param {*} value
 * @returns {Boolean}
 */
const isValidDeadline = (value) => parseDeadline(value) !== null;

module.exports = {
  DEFAULT_TIMEZONE,
  getAppTimezone,
  parseDeadline,
  isValidDeadline,
  zonedWallClockToUtc
};
