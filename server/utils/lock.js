const crypto = require('crypto');
const { getSharedRedis, isRedisConfigured } = require('./redis');
const { log } = require('./logger');
const { withTimeout } = require('./resilience');

// A lock acquisition must never outlive a cron tick; if Redis is slow or down,
// fall through to the in-process guard instead of blocking the scheduler.
const LOCK_OP_TIMEOUT_MS = Number(process.env.LOCK_REDIS_TIMEOUT_MS || 3000);

const logger = log('lock');

/**
 * Cross-instance mutual exclusion for scheduled jobs.
 *
 * `node-cron` is an in-process timer with no coordination: run three replicas
 * and the overdue scan fires three times a minute, each creating its own
 * duplicate notification rows, and three Gmail syncs race to insert the same
 * messageId.
 *
 * With Redis this is a `SET key value NX PX` lease, released with a
 * compare-and-delete Lua script so a lease that already expired cannot be
 * released by its previous (now overrunning) holder.
 *
 * WITHOUT Redis the lock is a no-op that still guards against OVERLAPPING
 * executions inside this process — which is the single-instance behaviour the
 * app has today, only safer.
 */

// Held names for the no-Redis path, so a slow tick cannot overlap the next one.
const localHeld = new Set();

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

/**
 * Try to acquire `name` for `ttlMs`.
 * @param {String} name
 * @param {Number} ttlMs
 * @returns {Promise<{acquired: Boolean, release: Function}>}
 */
const acquire = async (name, ttlMs) => {
  const key = `lock:${name}`;

  if (isRedisConfigured()) {
    const client = getSharedRedis();
    if (client) {
      const token = crypto.randomUUID();
      try {
        const result = await withTimeout(
          client.set(key, token, 'PX', Math.max(1000, ttlMs), 'NX'),
          LOCK_OP_TIMEOUT_MS,
          'lock.set'
        );
        if (result !== 'OK') return { acquired: false, release: async () => {} };
        return {
          acquired: true,
          release: async () => {
            try {
              await withTimeout(client.eval(RELEASE_SCRIPT, 1, key, token), LOCK_OP_TIMEOUT_MS, 'lock.release');
            } catch (err) {
              logger.debug({ err: err.message, name }, 'lock release failed (lease will expire)');
            }
          }
        };
      } catch (err) {
        // Redis unreachable: fall through to the in-process guard rather than
        // silently skipping the job entirely.
        logger.warn({ err: err.message, name }, 'Redis lock unavailable; using in-process guard');
      }
    }
  }

  if (localHeld.has(name)) return { acquired: false, release: async () => {} };
  localHeld.add(name);
  return {
    acquired: true,
    release: async () => {
      localHeld.delete(name);
    }
  };
};

/**
 * Run `fn` only if the lock can be taken. Returns `undefined` when another
 * instance (or an overlapping tick) already holds it.
 *
 * @param {String} name
 * @param {Number} ttlMs - lease length; must exceed the expected run time
 * @param {Function} fn - async () => result
 * @returns {Promise<*>}
 */
const withLock = async (name, ttlMs, fn) => {
  const lock = await acquire(name, ttlMs);
  if (!lock.acquired) {
    logger.debug({ name }, 'lock held elsewhere; skipping this run');
    return undefined;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
};

module.exports = { withLock, acquire };
