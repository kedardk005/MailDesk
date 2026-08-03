const { log } = require('./logger');

const logger = log('redis');

/**
 * Optional Redis wiring.
 *
 * REDIS_URL being unset is a FULLY SUPPORTED configuration: every consumer in
 * this codebase (cache, queue, distributed lock, rate-limit store, Socket.io
 * adapter) has an in-process fallback and must keep working. Nothing here ever
 * throws on a connection problem — callers degrade instead.
 */

let shared = null;
const extraClients = new Set();

/**
 * @returns {Boolean} true when a Redis URL is configured
 */
const isRedisConfigured = () => Boolean(process.env.REDIS_URL && process.env.REDIS_URL.trim());

/**
 * Create a new ioredis client. Returns null when Redis is not configured or the
 * driver cannot be loaded, so callers can branch on a falsy value.
 *
 * @param {Object} [overrides] - ioredis options merged over the defaults
 * @param {String} [label] - used in log lines
 * @returns {Object|null} ioredis client
 */
const createConnection = (overrides = {}, label = 'client') => {
  if (!isRedisConfigured()) return null;

  let Redis;
  try {
    Redis = require('ioredis');
  } catch (err) {
    logger.warn({ err: err.message }, 'ioredis is not installed; continuing without Redis');
    return null;
  }

  try {
    const client = new Redis(process.env.REDIS_URL, {
      // Fail fast rather than queueing commands forever when Redis is down.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      connectTimeoutMS: Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000),
      retryStrategy: (times) => Math.min(times * 500, 5000),
      lazyConnect: false,
      ...overrides
    });

    // Without an error listener an ECONNREFUSED becomes an unhandled 'error'
    // event, which under the process-level handlers in index.js would take the
    // whole API down because Redis — an OPTIONAL dependency — is unreachable.
    client.on('error', (err) => {
      logger.warn({ err: err.message, label }, 'Redis connection error (degrading to in-process fallback)');
    });

    if (label !== 'shared') extraClients.add(client);
    return client;
  } catch (err) {
    logger.warn({ err: err.message, label }, 'Failed to create Redis client; continuing without Redis');
    return null;
  }
};

/**
 * The process-wide client used by the cache, the lock and the rate limiter.
 * @returns {Object|null}
 */
const getSharedRedis = () => {
  if (!isRedisConfigured()) return null;
  if (shared) return shared;
  shared = createConnection({}, 'shared');
  return shared;
};

/**
 * Close every Redis connection this module created. Used by graceful shutdown.
 * @returns {Promise<void>}
 */
const closeRedis = async () => {
  const all = [...extraClients];
  if (shared) all.push(shared);
  await Promise.all(
    all.map((c) =>
      c
        .quit()
        .catch(() => c.disconnect())
        .catch(() => {})
    )
  );
  extraClients.clear();
  shared = null;
};

module.exports = { isRedisConfigured, createConnection, getSharedRedis, closeRedis };
