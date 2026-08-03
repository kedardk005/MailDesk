const mongoose = require('mongoose');
const { seedClients } = require('../seeders/clientSeeder');
const { log } = require('../utils/logger');

const logger = log('db');

/**
 * Connection options.
 *
 * `mongoose.connect(uri)` with no options inherits `socketTimeoutMS: 0`, i.e.
 * INFINITE: a query that hangs holds its pool connection until the process
 * dies. It also inherits `maxPoolSize: 100` per replica, which multiplies
 * straight past an Atlas M10's connection ceiling once you scale out, and
 * `minPoolSize: 0`, which adds handshake latency to the first request after an
 * idle period.
 */
/**
 * Wire compression is a large win here because email bodies carry base64 image
 * payloads — but a compressor may only be advertised if the driver can actually
 * load it. `zstd` and `snappy` are OPTIONAL native peer dependencies
 * (`@mongodb-js/zstd`, `snappy`). Listing them when they are not installed lets
 * the handshake negotiate an algorithm the driver cannot run, and the
 * connection is dropped and re-established in a loop: measured here as
 * readyState oscillating 1 → 0 → 1 every few seconds, which made /readyz flap
 * between 200 and 503 and would have taken the service out of the load-balancer
 * rotation permanently.
 *
 * `zlib` needs no native module (it is in Node core), so it is always safe.
 * @returns {String[]}
 */
const availableCompressors = () => {
  const compressors = [];
  for (const [name, mod] of [['zstd', '@mongodb-js/zstd'], ['snappy', 'snappy']]) {
    try {
      require.resolve(mod);
      compressors.push(name);
    } catch {
      // Not installed — do not advertise it.
    }
  }
  compressors.push('zlib');
  return compressors;
};

const connectionOptions = () => ({
  maxPoolSize: Number(process.env.MONGO_POOL_MAX || 20),
  minPoolSize: Number(process.env.MONGO_POOL_MIN || 2),
  serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 45000),
  connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 10000),
  maxIdleTimeMS: Number(process.env.MONGO_MAX_IDLE_TIME_MS || 60000),
  // Only compressors this process can actually load — see availableCompressors.
  compressors: availableCompressors(),
  // Building indexes on every boot of every replica is a production hazard.
  // In production, run `node scripts/syncIndexes.js` as an explicit deploy step.
  autoIndex: process.env.MONGO_AUTO_INDEX
    ? process.env.MONGO_AUTO_INDEX === 'true'
    : process.env.NODE_ENV !== 'production'
});

/**
 * Connects to MongoDB using MONGO_URI.
 *
 * Failure is FATAL. Previously the error was swallowed so `server.listen`
 * succeeded, `/api/health` reported "Server is running", and every real request
 * hung for Mongoose's buffer timeout before returning 500 — an orchestrator saw
 * a healthy pod that served nothing.
 */
const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    logger.fatal('MONGO_URI is not set. Refusing to start without a database.');
    process.exit(1);
  }

  try {
    // Fail fast instead of buffering commands for 10s when the DB is down, so
    // an outage surfaces as an error rather than as a pile of hung requests.
    mongoose.set('bufferCommands', false);

    const options = connectionOptions();
    const conn = await mongoose.connect(process.env.MONGO_URI, options);
    logger.info({ host: conn.connection.host, autoIndex: options.autoIndex, maxPoolSize: options.maxPoolSize },
      'MongoDB connected');

    // Seeding is opt-in. It used to run on every boot, which is what made
    // taskHelper's `clients[0].name` fallback attribute real work to the demo
    // client "Reliance Industries". The env check is repeated here so a boot
    // with seeding disabled does not even load the seeder's query path.
    if (process.env.SEED_CLIENTS === 'true') {
      await seedClients();
    }

    return conn;
  } catch (error) {
    logger.fatal({ err: error.message }, 'MongoDB connection error');
    process.exit(1);
  }
};

/**
 * True when Mongoose currently has a live connection. Used by /api/health so it
 * reports the real dependency state instead of always returning 200.
 * @returns {Boolean}
 */
const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.isDbConnected = isDbConnected;
