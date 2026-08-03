/**
 * F-2 — effective SLA policy resolution.
 *
 * Layering, cheapest first:
 *   1. environment defaults (always present, so the endpoints work on a
 *      database that has never been configured),
 *   2. the single `global` SlaPolicy row, if one exists,
 *   3. a per-client SlaPolicy row, if one exists for that client.
 *
 * The whole policy set is at most one row per client, so it is loaded once and
 * cached rather than joined per thread.
 */

const SlaPolicy = require('../models/SlaPolicy');
const cache = require('./cache');
const { getAppTimezone } = require('./dateHelper');

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const envDefaults = () => ({
  scope: 'default',
  client: null,
  firstResponseMinutes: num(process.env.SLA_FIRST_RESPONSE_MINUTES, 240),
  resolutionMinutes: num(process.env.SLA_RESOLUTION_MINUTES, 1440),
  businessHours: {
    enabled: String(process.env.SLA_BUSINESS_HOURS || 'false').toLowerCase() === 'true',
    startHour: num(process.env.SLA_BUSINESS_START_HOUR, 9),
    endHour: num(process.env.SLA_BUSINESS_END_HOUR, 18),
    workingDays: String(process.env.SLA_BUSINESS_DAYS || '1,2,3,4,5')
      .split(',')
      .map((d) => parseInt(d.trim(), 10))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7),
    timezone: process.env.SLA_TIMEZONE || getAppTimezone()
  }
});

/**
 * Merge a stored row over a base policy. A null/absent field on the row means
 * "inherit", never "zero".
 * @param {Object} base
 * @param {Object|null} row
 * @returns {Object}
 */
const mergePolicy = (base, row) => {
  if (!row) return base;
  const merged = {
    scope: row.scope || base.scope,
    client: row.client || null,
    firstResponseMinutes: num(row.firstResponseMinutes, base.firstResponseMinutes),
    resolutionMinutes: num(row.resolutionMinutes, base.resolutionMinutes),
    businessHours: { ...base.businessHours }
  };

  const bh = row.businessHours;
  if (bh) {
    if (typeof bh.enabled === 'boolean') merged.businessHours.enabled = bh.enabled;
    merged.businessHours.startHour = num(bh.startHour, merged.businessHours.startHour);
    merged.businessHours.endHour = num(bh.endHour, merged.businessHours.endHour);
    if (Array.isArray(bh.workingDays) && bh.workingDays.length > 0) {
      merged.businessHours.workingDays = bh.workingDays;
    }
    if (bh.timezone) merged.businessHours.timezone = bh.timezone;
  }

  return merged;
};

/**
 * Load every policy row and resolve them into
 * `{ default, byClient: { <clientId>: policy } }`.
 *
 * Cached: `sla:policies`, invalidated explicitly on every policy write.
 *
 * @returns {Promise<{default: Object, byClient: Object}>}
 */
const getEffectivePolicies = async () => {
  const rows = await cache.wrap(cache.KEYS.slaPolicies(), cache.TTL.slaPolicy, async () =>
    SlaPolicy.find({}).select('scope client firstResponseMinutes resolutionMinutes businessHours').lean()
  );

  const base = envDefaults();
  const globalRow = (rows || []).find((r) => r.scope === 'global') || null;
  const effectiveDefault = mergePolicy(base, globalRow);
  effectiveDefault.scope = globalRow ? 'global' : 'default';

  const byClient = {};
  for (const row of rows || []) {
    if (row.scope !== 'client' || !row.client) continue;
    byClient[String(row.client)] = mergePolicy(effectiveDefault, row);
  }

  return { default: effectiveDefault, byClient };
};

/**
 * Build the aggregation expression that yields the SLA target (in
 * MILLISECONDS) applicable to a row, given its `clientId`.
 *
 * A `$switch` over the per-client overrides. The branch count is the number of
 * clients that actually have an override — normally zero, in which case this
 * collapses to a constant.
 *
 * @param {Object} policies - result of getEffectivePolicies
 * @param {'firstResponseMinutes'|'resolutionMinutes'} field
 * @param {String} [clientField='$clientId']
 * @returns {Object|Number} an aggregation expression
 */
const targetMsExpr = (policies, field, clientField = '$clientId') => {
  const defaultMs = policies.default[field] * 60000;
  const overrides = Object.entries(policies.byClient).filter(
    ([, policy]) => policy[field] !== policies.default[field]
  );

  // `$literal` is REQUIRED. A bare number at the top level of a `$project` is an
  // inclusion flag, not a value: `{ targetMs: 14400000 }` includes a field that
  // does not exist, so `targetMs` came out MISSING — and `<number> $gt missing`
  // is true, which reported every conversation as a breach.
  if (overrides.length === 0) return { $literal: defaultMs };

  return {
    $switch: {
      branches: overrides.map(([clientId, policy]) => ({
        case: { $eq: [clientField, { $toObjectId: clientId }] },
        then: policy[field] * 60000
      })),
      default: defaultMs
    }
  };
};

module.exports = {
  getEffectivePolicies,
  targetMsExpr,
  envDefaults,
  mergePolicy
};
