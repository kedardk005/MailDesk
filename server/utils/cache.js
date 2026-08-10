const { LRUCache } = require('lru-cache');
const { getSharedRedis, isRedisConfigured } = require('./redis');
const { log } = require('./logger');

const logger = log('cache');

/**
 * Cache-aside helper with two interchangeable backends.
 *
 *   REDIS_URL set   -> Redis (shared across replicas, survives a restart)
 *   REDIS_URL unset -> a bounded in-process LRU with per-entry TTL
 *
 * The in-memory backend is NOT a toy: it is the supported single-instance
 * configuration. It is bounded (`CACHE_MAX_ITEMS`) so it cannot grow into an
 * OOM, and every entry carries a TTL.
 *
 * Values are JSON-serialised in BOTH backends so a cache hit can never hand a
 * caller a mutable reference to another request's object.
 *
 * Every operation is failure-tolerant: a Redis outage degrades to a cache miss,
 * never to a request error.
 */

const MAX_ITEMS = Number(process.env.CACHE_MAX_ITEMS || 2000);
const DEFAULT_TTL_SECONDS = Number(process.env.CACHE_DEFAULT_TTL || 60);
const PREFIX = process.env.CACHE_PREFIX || 'md';

const memory = new LRUCache({
  max: MAX_ITEMS,
  ttl: DEFAULT_TTL_SECONDS * 1000,
  ttlAutopurge: true
});

const useRedis = () => isRedisConfigured();
const namespaced = (key) => `${PREFIX}:${key}`;

/**
 * @param {String} key
 * @returns {Promise<*>} the cached value, or undefined on a miss
 */
const get = async (key) => {
  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        const raw = await client.get(namespaced(key));
        return raw === null || raw === undefined ? undefined : JSON.parse(raw);
      } catch (err) {
        logger.debug({ err: err.message, key }, 'cache get failed; treating as miss');
        return undefined;
      }
    }
  }
  const raw = memory.get(namespaced(key));
  return raw === undefined ? undefined : JSON.parse(raw);
};

/**
 * @param {String} key
 * @param {*} value - must be JSON-serialisable
 * @param {Number} [ttlSeconds]
 * @returns {Promise<void>}
 */
const set = async (key, value, ttlSeconds = DEFAULT_TTL_SECONDS) => {
  if (value === undefined) return;
  let raw;
  try {
    raw = JSON.stringify(value);
  } catch (err) {
    logger.debug({ err: err.message, key }, 'value is not serialisable; not cached');
    return;
  }

  const ttl = Math.max(1, Math.floor(ttlSeconds));

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        await client.set(namespaced(key), raw, 'EX', ttl);
        return;
      } catch (err) {
        logger.debug({ err: err.message, key }, 'cache set failed');
        return;
      }
    }
  }
  memory.set(namespaced(key), raw, { ttl: ttl * 1000 });
};

/**
 * Delete one or more exact keys.
 * @param {...String} keys
 * @returns {Promise<void>}
 */
const del = async (...keys) => {
  const flat = keys.flat().filter(Boolean);
  if (flat.length === 0) return;

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        await client.del(...flat.map(namespaced));
        return;
      } catch (err) {
        logger.debug({ err: err.message }, 'cache del failed');
        return;
      }
    }
  }
  for (const key of flat) memory.delete(namespaced(key));
};

/**
 * Delete every key beginning with `prefix`. Uses SCAN (never KEYS) so it cannot
 * block the Redis event loop on a large keyspace.
 * @param {String} prefix
 * @returns {Promise<void>}
 */
const delPrefix = async (prefix) => {
  if (!prefix) return;

  if (useRedis()) {
    const client = getSharedRedis();
    if (client) {
      try {
        const match = `${namespaced(prefix)}*`;
        let cursor = '0';
        do {
          const [next, found] = await client.scan(cursor, 'MATCH', match, 'COUNT', 200);
          cursor = next;
          if (found.length > 0) await client.del(...found);
        } while (cursor !== '0');
        return;
      } catch (err) {
        logger.debug({ err: err.message, prefix }, 'cache delPrefix failed');
        return;
      }
    }
  }

  const full = namespaced(prefix);
  for (const key of [...memory.keys()]) {
    if (typeof key === 'string' && key.startsWith(full)) memory.delete(key);
  }
};

/**
 * Cache-aside: return the cached value, otherwise run `producer`, cache and
 * return its result. A producer error is never cached.
 *
 * @param {String} key
 * @param {Number} ttlSeconds
 * @param {Function} producer - async () => value
 * @returns {Promise<*>}
 */
const wrap = async (key, ttlSeconds, producer) => {
  const hit = await get(key);
  if (hit !== undefined) return hit;
  const value = await producer();
  await set(key, value, ttlSeconds);
  return value;
};

/** Drop everything. Test/ops helper. @returns {Promise<void>} */
const clear = async () => {
  if (useRedis()) {
    await delPrefix('');
    return;
  }
  memory.clear();
};

/**
 * Canonical cache keys and TTLs, so producers and invalidators cannot drift.
 */
const KEYS = {
  activeRules: () => 'rules:active',
  allClients: () => 'clients:all',
  clientMatcher: () => 'clients:matcher',
  report: (type, range, userId) => `report:${type}:${range || 'all'}:${userId || 'all'}`,
  reportPrefix: () => 'report:',
  dashboard: (userId, role) => `dash:${userId}:${role}`,
  dashboardPrefix: () => 'dash:',
  gmailToken: (userId, inbox) => `gtok:${userId}:${inbox}`,
  user: (userId) => `user:${userId}`,
  // S-12: read on every notification write and on every preference-governed
  // email, including the overdue cron's fan-out to every supervisor.
  notificationPrefs: (userId) => `nprefs:${userId}`,
  aiSummary: (hash) => `ai:sum:${hash}`,
  // F-3. Content-addressed like the summary key: the hash covers the prompt
  // version, the model and the whole document, so a prompt change cannot serve
  // a stale shape and no role-scoped slice is ever derived. See the note on
  // `utils/aiExtraction.documentHash`.
  aiActions: (hash) => `ai:act:${hash}`,
  // F-2. The policy set is at most one row per client, read by both SLA
  // endpoints on every miss.
  slaPolicies: () => 'sla:policies'
};

const TTL = {
  activeRules: Number(process.env.CACHE_TTL_RULES || 300),
  clients: Number(process.env.CACHE_TTL_CLIENTS || 600),
  report: Number(process.env.CACHE_TTL_REPORT || 900),
  dashboard: Number(process.env.CACHE_TTL_DASHBOARD || 60),
  user: Number(process.env.CACHE_TTL_USER || 30),
  notificationPrefs: Number(process.env.CACHE_TTL_NOTIF_PREFS || 60),
  aiSummary: Number(process.env.CACHE_TTL_AI || 60 * 60 * 24 * 30),
  aiActions: Number(process.env.CACHE_TTL_AI_ACTIONS || 60 * 60 * 24 * 30),
  slaPolicy: Number(process.env.CACHE_TTL_SLA_POLICY || 300),
  sla: Number(process.env.CACHE_TTL_SLA || 900)
};

/** Invalidate everything that depends on the keyword-rule set. @returns {Promise<void>} */
const invalidateRules = () => del(KEYS.activeRules());

/**
 * Invalidate everything that depends on the client list.
 *
 * L-8: the `dash:` prefix goes too. The dashboard payload carries
 * `totalClients`, but only `invalidateStats` (task/email/user writes) dropped
 * it — so creating a client moved `GET /api/clients` immediately and left the
 * tile above it reading the old number for up to CACHE_TTL_DASHBOARD. Every
 * other tile on that payload is already invalidated by the write that changes
 * it; this makes the Clients tile behave the same.
 *
 * @returns {Promise<void>}
 */
const invalidateClients = async () => {
  await del(KEYS.allClients(), KEYS.clientMatcher());
  await delPrefix(KEYS.reportPrefix());
  await delPrefix(KEYS.dashboardPrefix());
};

/** Invalidate report + dashboard aggregates after a task/email write. @returns {Promise<void>} */
const invalidateStats = async () => {
  await delPrefix(KEYS.reportPrefix());
  await delPrefix(KEYS.dashboardPrefix());
};

/**
 * Invalidate a cached authenticated-user lookup.
 *
 * Also drops the notification-preference entry: `updateUser` / `deleteUser`
 * re-save the whole document, and a stale preference copy would keep delivering
 * to (or muting) an account whose settings just changed.
 *
 * @returns {Promise<void>}
 */
const invalidateUser = (userId) =>
  del(KEYS.user(String(userId)), KEYS.notificationPrefs(String(userId)));

/** Invalidate only the cached notification preferences. @returns {Promise<void>} */
const invalidateNotificationPrefs = (userId) => del(KEYS.notificationPrefs(String(userId)));

/**
 * Invalidate the SLA policy set and every aggregate derived from it.
 *
 * The SLA endpoints cache under the `report:` prefix, so they are already
 * dropped by `invalidateStats()` on a task/email write. This is the other
 * direction: changing a TARGET moves every breach count without any task or
 * email having changed at all.
 *
 * @returns {Promise<void>}
 */
const invalidateSlaPolicies = async () => {
  await del(KEYS.slaPolicies());
  await delPrefix(KEYS.reportPrefix());
};

module.exports = {
  get,
  set,
  del,
  delPrefix,
  wrap,
  clear,
  KEYS,
  TTL,
  invalidateRules,
  invalidateClients,
  invalidateStats,
  invalidateUser,
  invalidateNotificationPrefs,
  invalidateSlaPolicies,
  backend: () => (useRedis() ? 'redis' : 'memory')
};
