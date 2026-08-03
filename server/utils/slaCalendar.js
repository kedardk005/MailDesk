/**
 * F-2 — business-hours arithmetic for SLA elapsed time.
 *
 * THE APPROACH, and why it is this one:
 *
 * Expressing "working minutes between two instants, in APP_TIMEZONE, skipping
 * weekends" directly as an aggregation expression means re-deriving weekday
 * arithmetic and DST inside `$switch`/`$mod`. `utils/dateHelper.js` already does
 * the zone maths correctly — including a subtle end-of-day bug that was found
 * and fixed — so this module reuses it rather than reimplementing it.
 *
 * So: JS enumerates the working windows for the reporting range ONCE (bounded
 * by the range length, and the range itself is clamped by the caller), and the
 * pipeline sums the overlap of each thread's interval with those windows via a
 * `$reduce` over a literal array. The percentile work therefore still happens
 * entirely in the aggregation — nothing is pulled into JS per document — which
 * is the constraint that matters.
 *
 * With business hours DISABLED (the default) none of this runs: elapsed time is
 * plain wall-clock milliseconds.
 */

const { getAppTimezone, zonedWallClockToUtc } = require('./dateHelper');

// Hard ceiling on the number of working windows materialised into one pipeline.
// 400 days of windows is ~2 KB of literal array; anything beyond that means the
// caller asked for a range the report endpoints already clamp.
const MAX_WINDOWS = Number(process.env.SLA_MAX_BUSINESS_WINDOWS || 500);

// A response can land after the end of the reporting range (a mail received on
// the last day answered the next morning), so the window list is extended past
// `to` by this many days.
const WINDOW_LOOKAHEAD_DAYS = Number(process.env.SLA_WINDOW_LOOKAHEAD_DAYS || 14);

/**
 * ISO weekday (1 = Monday … 7 = Sunday) of a UTC instant, read in `timeZone`.
 * @param {Date} date
 * @param {String} timeZone
 * @returns {Number}
 */
const isoWeekdayInZone = (date, timeZone) => {
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[short] || 1;
};

/**
 * Calendar date parts of a UTC instant, read in `timeZone`.
 * @param {Date} date
 * @param {String} timeZone
 * @returns {{year: Number, month: Number, day: Number}}
 */
const zonedDateParts = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
  const [year, month, day] = parts.split('-').map(Number);
  return { year, month, day };
};

/**
 * Enumerate the working windows covering [from, to], as UTC instants.
 *
 * @param {Date} from
 * @param {Date} to
 * @param {Object} policy - effective SLA policy (see utils/slaPolicy.js)
 * @returns {Array<{start: Date, end: Date}>} empty when business hours are off
 */
const businessWindows = (from, to, policy) => {
  const hours = policy?.businessHours;
  if (!hours?.enabled) return [];

  const timeZone = hours.timezone || getAppTimezone();
  const startHour = Number.isFinite(hours.startHour) ? hours.startHour : 9;
  const endHour = Number.isFinite(hours.endHour) ? hours.endHour : 18;
  const workingDays = new Set(
    Array.isArray(hours.workingDays) && hours.workingDays.length > 0 ? hours.workingDays : [1, 2, 3, 4, 5]
  );

  // A window that ends at or before it starts would make every elapsed time
  // zero, which reads as "instant response" — refuse it and fall back to
  // wall-clock by returning no windows.
  if (!(endHour > startHour)) return [];

  const windows = [];
  const cursor = new Date(from.getTime());
  const limit = new Date(to.getTime() + WINDOW_LOOKAHEAD_DAYS * 86400000);

  while (cursor.getTime() <= limit.getTime() && windows.length < MAX_WINDOWS) {
    const { year, month, day } = zonedDateParts(cursor, timeZone);
    const dayStart = zonedWallClockToUtc(year, month, day, startHour, 0, 0, 0, timeZone);

    if (workingDays.has(isoWeekdayInZone(dayStart, timeZone))) {
      const dayEnd =
        endHour >= 24
          ? zonedWallClockToUtc(year, month, day, 23, 59, 59, 999, timeZone)
          : zonedWallClockToUtc(year, month, day, endHour, 0, 0, 0, timeZone);
      windows.push({ start: dayStart, end: dayEnd });
    }

    // Step a day forward from NOON in-zone, so a DST transition cannot land the
    // cursor back on the same calendar date (or skip one).
    const noon = zonedWallClockToUtc(year, month, day, 12, 0, 0, 0, timeZone);
    cursor.setTime(noon.getTime() + 86400000);
  }

  return windows;
};

/**
 * JS reference implementation, used by the backfill scripts and for verifying
 * the pipeline expression below.
 *
 * @param {Date} start
 * @param {Date} end
 * @param {Array<{start: Date, end: Date}>} windows
 * @returns {Number} milliseconds
 */
const businessElapsedMs = (start, end, windows) => {
  if (!start || !end) return 0;
  const a = start.getTime();
  const b = end.getTime();
  if (b <= a) return 0;
  if (!windows || windows.length === 0) return b - a;

  let total = 0;
  for (const w of windows) {
    const lo = Math.max(a, w.start.getTime());
    const hi = Math.min(b, w.end.getTime());
    if (hi > lo) total += hi - lo;
  }
  return total;
};

/**
 * The aggregation expression for elapsed milliseconds between two date fields.
 *
 * With no windows this is a plain `$subtract`. With windows it is a `$reduce`
 * summing the overlap of [start, end] with each window — the exact analogue of
 * `businessElapsedMs` above, evaluated by the server.
 *
 * @param {String|Object} startExpr - e.g. '$firstInboundAt'
 * @param {String|Object} endExpr
 * @param {Array<{start: Date, end: Date}>} windows
 * @returns {Object} an aggregation expression yielding a Number (ms) or null
 */
const elapsedMsExpr = (startExpr, endExpr, windows) => {
  const plain = { $subtract: [endExpr, startExpr] };

  if (!windows || windows.length === 0) {
    return {
      $cond: [
        { $and: [{ $ne: [startExpr, null] }, { $ne: [endExpr, null] }, { $gte: [endExpr, startExpr] }] },
        plain,
        null
      ]
    };
  }

  const reduced = {
    $reduce: {
      input: { $literal: windows.map((w) => [w.start, w.end]) },
      initialValue: 0,
      in: {
        $add: [
          '$$value',
          {
            $let: {
              vars: {
                lo: { $max: [startExpr, { $arrayElemAt: ['$$this', 0] }] },
                hi: { $min: [endExpr, { $arrayElemAt: ['$$this', 1] }] }
              },
              in: {
                $cond: [{ $gt: ['$$hi', '$$lo'] }, { $subtract: ['$$hi', '$$lo'] }, 0]
              }
            }
          }
        ]
      }
    }
  };

  return {
    $cond: [
      { $and: [{ $ne: [startExpr, null] }, { $ne: [endExpr, null] }, { $gte: [endExpr, startExpr] }] },
      reduced,
      null
    ]
  };
};

module.exports = {
  businessWindows,
  businessElapsedMs,
  elapsedMsExpr,
  isoWeekdayInZone,
  MAX_WINDOWS,
  WINDOW_LOOKAHEAD_DAYS
};
