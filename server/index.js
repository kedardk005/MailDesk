// Load environment variables from .env
require('dotenv').config();

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const rateLimit = require('express-rate-limit');
const connectDB = require('./config/db');
const { isDbConnected } = require('./config/db');
const mongoKeyGuard = require('./middleware/mongoKeyGuard');
const { logger, httpLogger } = require('./utils/logger');
const { isRedisConfigured, createConnection, closeRedis } = require('./utils/redis');
const queue = require('./utils/queue');
const { registerJobHandlers } = require('./jobs');
const { breakerStats } = require('./utils/resilience');
const {
  attachRateLimitIdentity,
  userOrIpKey,
  accountKey,
  ipOnlyKey
} = require('./middleware/rateLimitKey');

// Create Express app
const app = express();

// Behind a reverse proxy / load balancer / PaaS ingress, req.ip is the proxy's
// address for every request, so express-rate-limit collapses to ONE shared
// bucket: ten failed logins from anyone would lock out every employee. Trust
// exactly one hop — never `true`, which lets clients spoof X-Forwarded-For and
// bypass the limiter entirely.
app.set('trust proxy', 1);

// Connect to MongoDB. Fatal on failure — the process must not serve traffic
// without a database.
connectDB();

// Rate limiting.
//
// `express-rate-limit`'s default MemoryStore is PER PROCESS: with three
// replicas the effective limits silently become 30 and 900, and every counter
// resets on deploy. When Redis is available the counters are shared; when it is
// not, the in-memory store is used exactly as before.
const buildLimiterStore = (prefix) => {
  if (!isRedisConfigured()) return undefined;
  try {
    const { RedisStore } = require('rate-limit-redis');
    /*
     * `enableOfflineQueue: true` is REQUIRED here (audit L-5).
     *
     * The shared Redis client disables the offline queue so a request-path
     * cache read fails fast instead of hanging while Redis is down — correct
     * there. But express-rate-limit calls `store.init()` synchronously at
     * construction, before the socket is writeable, and with the queue disabled
     * that rejected every boot with
     *   "async error during store initialization. Error: Stream isn't writeable
     *    and enableOfflineQueue options is false"
     * The limiter then silently fell back to per-process in-memory counting —
     * i.e. setting REDIS_URL, the whole point of the shared store, is what
     * broke the shared store. Same reasoning as the Socket.io adapter below.
     */
    const client = createConnection(
      { enableOfflineQueue: true, maxRetriesPerRequest: null },
      `ratelimit:${prefix}`
    );
    if (!client) return undefined;
    client.on('error', (err) => logger.warn({ err: err.message, prefix }, 'rate-limit Redis error'));
    return new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args) => client.call(...args)
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'rate-limit-redis unavailable; using the in-memory store');
    return undefined;
  }
};

/*
 * Limiter keying — audit H-8.
 *
 * These were per-IP, and an office is one public NAT address, so 300/15min and
 * 10 logins/15min were budgets for the WHOLE FIRM. A dashboard load costs ~11
 * counted API calls (≈27 dashboard loads per 15 minutes for everyone combined)
 * and the eleventh person to sign in on a Monday morning got
 * "Too many authentication attempts from this IP" — as did everyone after them.
 *
 * The general limiter now counts per authenticated user, falling back to the IP
 * only for anonymous requests. The login limiter is split in two:
 *
 *   authAccountLimiter  the real credential-stuffing control — FAILED attempts
 *                       per ACCOUNT. Per-account is the correct axis: it does
 *                       not care how many addresses an attacker spreads over,
 *                       and it cannot be tripped by a colleague at the next
 *                       desk. `skipSuccessfulRequests` means a staff member who
 *                       types their password correctly spends nothing.
 *   authIpLimiter       a coarse anti-abuse ceiling per IP, raised to a number
 *                       a 15-person office survives.
 */
const attachedIdentity = attachRateLimitIdentity();

const authIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  // RATE_LIMIT_AUTH_MAX is still read, so an existing deployment's override
  // keeps working; the default rises from 10 to 200.
  max: Number(process.env.RATE_LIMIT_AUTH_IP_MAX || process.env.RATE_LIMIT_AUTH_MAX || 200),
  message: { message: 'Too many authentication attempts from this network, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: ipOnlyKey,
  store: buildLimiterStore('auth-ip')
});

const authAccountLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_AUTH_ACCOUNT_MAX || 10),
  message: {
    message: 'Too many failed attempts for this account. Please wait 15 minutes or reset your password.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: accountKey,
  // Only FAILED attempts count. This is what lets the office sign in freely
  // while still stopping a password-guessing run against one account.
  skipSuccessfulRequests: true,
  store: buildLimiterStore('auth-account')
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_GENERAL_MAX || 1000),
  message: { message: 'Too many requests, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userOrIpKey,
  store: buildLimiterStore('general')
});

// Apply Middlewares
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));

// Request-scoped structured logging with a request id, replacing the ~80
// `console.*` calls. `console.log` to a pipe (Docker/PM2) is a SYNCHRONOUS
// write that blocks the event loop.
app.use(httpLogger());

// Email/task JSON is HTML-heavy and typically compresses 8-15x. Registered
// before the routes so every response benefits.
app.use(
  compression({
    threshold: Number(process.env.COMPRESSION_THRESHOLD || 1024),
    filter: (req, res) => (req.headers['x-no-compression'] ? false : compression.filter(req, res))
  })
);

app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));

// Reject Mongo operator-like keys ($-prefixed / dotted) anywhere in the request,
// then apply the existing body sanitization. Replaces the previous in-place
// sanitize of req.query, which is a no-op under Express 5 because req.query is
// a getter that re-parses req.url on every access.
app.use(mongoKeyGuard);

/*
 * Every /api response is scoped to the caller, so none of them may be reused
 * for a different Authorization header.
 *
 * Several read endpoints send `Cache-Control: private, max-age=…,
 * stale-while-revalidate=…` to stop the browser re-asking on every mount. That
 * is correct, but `private` only excludes SHARED caches — the browser's own
 * cache is a private cache, and without `Vary: Authorization` it happily
 * reuses one user's entry for the next. Observed: signing out of Admin and in
 * as Head inside the same browser rendered the Admin's workspace-wide SLA
 * backlog (220) on the Head's dashboard, whose real figure is 62.
 *
 * `res.vary()` appends, so the existing `Origin, Accept-Encoding` is kept.
 * Applied globally rather than at the two call sites that cache today, so an
 * endpoint that starts caching tomorrow is covered by construction.
 */
app.use('/api', (req, res, next) => {
  res.vary('Authorization');
  next();
});

// Apply Limiters to routes.
//
// `attachedIdentity` must run BEFORE generalLimiter: it is what turns the
// office-wide per-IP bucket into a per-user one. It reads the bearer token's
// signature only and makes no authorization decision — see
// middleware/rateLimitKey.js.
app.use('/api', attachedIdentity, generalLimiter);

// Order matters: the per-account limiter is the control that actually stops
// credential stuffing, so it is evaluated first and its message is the one a
// guessing run sees.
app.use('/api/auth/login', authAccountLimiter, authIpLimiter);
app.use('/api/auth/register', authIpLimiter);
// Per-account too: without it, one address can be mail-bombed with reset links
// from a single request loop.
app.use('/api/auth/forgot-password', authAccountLimiter, authIpLimiter);

// Import routes and middleware
const authRoutes = require('./routes/authRoutes');
const { protect } = require('./middleware/authMiddleware');

// Liveness and readiness, OUTSIDE the /api prefix so they are not subject to
// the general rate limiter — a burst of probes from a shared-IP orchestrator
// could otherwise rate-limit the health check itself.
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

app.get('/readyz', (req, res) => {
  const dbConnected = isDbConnected();
  const shuttingDownNow = app.get('shuttingDown') === true;
  const ready = dbConnected && !shuttingDownNow;
  return res.status(ready ? 200 : 503).json({
    ok: ready,
    db: dbConnected,
    shuttingDown: shuttingDownNow,
    queue: queue.backend(),
    breakers: breakerStats(),
    uptime: process.uptime()
  });
});

// Base health route.
// Reports the REAL dependency state: it used to always return 200 "Server is
// running" even with Mongo unreachable, so orchestrators saw a healthy pod that
// served nothing but 500s.
app.get('/api/health', (req, res) => {
  const dbConnected = isDbConnected();
  const shuttingDown = app.get('shuttingDown') === true;
  const healthy = dbConnected && !shuttingDown;

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'Server is running' : 'Server is unhealthy',
    database: dbConnected ? 'connected' : 'disconnected',
    shuttingDown,
    uptime: process.uptime()
  });
});

// Auth routes
app.use('/api/auth', authRoutes);

// User CRUD routes (Admin only)
const userRoutes = require('./routes/userRoutes');
app.use('/api/users', userRoutes);

// Gmail routes
const gmailRoutes = require('./routes/gmailRoutes');
app.use('/api/gmail', gmailRoutes);

// Task routes
const taskRoutes = require('./routes/taskRoutes');
app.use('/api/tasks', taskRoutes);

const commentRoutes = require('./routes/commentRoutes');
app.use('/api/tasks/:id/comments', commentRoutes);

// Notification routes
const notificationRoutes = require('./routes/notificationRoutes');
app.use('/api/notifications', notificationRoutes);

// Reports routes
const reportsRoutes = require('./routes/reportsRoutes');
app.use('/api/reports', reportsRoutes);

// AI routes
const aiRoutes = require('./routes/aiRoutes');
app.use('/api/ai', aiRoutes);

// Client routes
const clientRoutes = require('./routes/clientRoutes');
app.use('/api/clients', clientRoutes);

// Keyword rule routes
const keywordRuleRoutes = require('./routes/keywordRuleRoutes');
app.use('/api/keyword-rules', keywordRuleRoutes);

// Protected test route - returns logged-in user profile
app.get('/api/auth/me', protect, (req, res) => {
  res.json(req.user);
});

// JSON 404 for unmatched routes — Express's default is an HTML page, which
// breaks the JSON contract the client expects.
app.use((req, res) => {
  res.status(404).json({ message: `Not found: ${req.method} ${req.originalUrl}` });
});

// Global Express Error Handler. Consistent { message } shape, and never a stack
// trace in production.
app.use((err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;

  if (statusCode >= 500) {
    (req.log || logger).error({ err: err.message, stack: err.stack }, 'unhandled request error');
  } else {
    (req.log || logger).warn({ statusCode, err: err.message }, 'request error');
  }

  // Only expose the message for client errors (4xx); 5xx is always generic.
  const message = statusCode < 500 ? err.message : 'Internal Server Error';

  const body = { message };
  // Stack traces are exposed only outside production, for local debugging.
  if (process.env.NODE_ENV !== 'production' && statusCode >= 500) {
    body.stack = err.stack;
  }

  if (res.headersSent) {
    return next(err);
  }

  return res.status(statusCode).json(body);
});

// Create HTTP server
const server = http.createServer(app);

// Initialize Socket.io on the HTTP server
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    methods: ["GET", "POST"]
  }
});

// Horizontal scaling: the default in-memory adapter only reaches sockets
// connected to THIS process, so with three replicas roughly two thirds of every
// `io.to(userId).emit(...)` was silently dropped.
if (isRedisConfigured()) {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');

    /*
     * These two clients MUST override `enableOfflineQueue: false`.
     *
     * The shared client sets it so a request-path cache read fails fast instead
     * of hanging while Redis is down — correct there. But the RedisAdapter
     * constructor calls `psubscribe`/`subscribe` SYNCHRONOUSLY, and with the
     * offline queue disabled those reject the instant the socket is not yet
     * writeable. Nothing awaits the constructor, so the rejection reached the
     * process-level unhandledRejection handler and shut the server down on
     * boot — meaning `REDIS_URL` being set, the whole point of the adapter,
     * made the API fail to start.
     *
     * Queueing is right for pub/sub: the subscribe is a one-off setup command
     * that must survive a reconnect, not a latency-sensitive read.
     */
    const adapterOptions = { enableOfflineQueue: true, maxRetriesPerRequest: null };
    const pubClient = createConnection(adapterOptions, 'socket-pub');
    const subClient = pubClient ? pubClient.duplicate(adapterOptions) : null;

    if (pubClient && subClient) {
      subClient.on('error', (err) => logger.warn({ err: err.message }, 'Socket.io Redis sub error'));
      io.adapter(createAdapter(pubClient, subClient));
      logger.info('Socket.io Redis adapter enabled');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Socket.io Redis adapter unavailable; single-instance mode');
  }
}

// Expose io object to req.app for controllers
app.set('io', io);

// Socket.io connection authentication middleware
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const { checkAccountState, loadUser } = require('./middleware/authMiddleware');
// F-4 — collision detection. Attaches to the rooms that already exist here and
// builds on the handshake below; it never re-implements authentication.
const presence = require('./utils/presence');

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('Authentication error. Token missing.'));
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    // Shares the cached, lean lookup with the HTTP `protect` middleware; this
    // used to be its own uncached, hydrated findById per handshake.
    const user = await loadUser(decoded.id);

    // Shared with the HTTP `protect` middleware, so a deactivated, rejected or
    // soft-deleted account cannot keep a live socket session either — the
    // status check was previously missing on both transports.
    const state = checkAccountState(user, decoded);
    if (!state.ok) {
      return next(new Error(`Authentication error. ${state.message}`));
    }

    socket.data = socket.data || {};
    socket.data.user = user;
    next();
  } catch (err) {
    logger.debug({ err: err.message }, 'socket authentication failed');
    next(new Error('Authentication error. Invalid token.'));
  }
});

// Socket.io connection and room joins
io.on('connection', (socket) => {
  logger.debug({ socketId: socket.id }, 'socket connected');
  
  // Automatically join the user to their own notification channel
  if (socket.data?.user?._id) {
    const userId = socket.data.user._id.toString();
    socket.join(userId);
    logger.debug({ socketId: socket.id, room: userId }, 'socket joined room');
  }

  // Fallback join handler (ignores argument, scopes to session user)
  socket.on('join', () => {
    if (socket.data?.user?._id) {
      const userId = socket.data.user._id.toString();
      socket.join(userId);
      logger.debug({ socketId: socket.id, room: userId }, 'socket joined room (event)');
    }
  });

  // F-4: thread:viewing / thread:composing / thread:leave, and the
  // thread:viewers / thread:composers broadcasts. Every room join is
  // authorized against the same ownership rule the thread endpoints use.
  presence.registerPresenceHandlers(io, socket);

  socket.on('disconnect', () => {
    logger.debug({ socketId: socket.id }, 'socket disconnected');
  });
});

// Import cron evaluation scheduler
const { startCronJobs } = require('./utils/cronJobs');

// Start listening on PORT
const PORT = process.env.PORT || 5000;

// Request/socket timeouts. Without these a slow handler pins a connection
// indefinitely, and keepAlive shorter than the load balancer's idle timeout
// produces random 502s.
server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 60000);
server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 66000);
server.keepAliveTimeout = Number(process.env.KEEPALIVE_TIMEOUT_MS || 65000);

// Register the job processors BEFORE the workers start consuming.
registerJobHandlers();

/*
 * L-4 — say at BOOT whether OAuth refresh tokens are sitting in the database in
 * plaintext.
 *
 * Before this, the only evidence was a `console.warn` emitted once per mailbox
 * per sync, buried in request logs, that named a script nobody had run. An
 * operator who wants to know the state of their credentials should not have to
 * grep for it: this asks once, at startup, and says nothing at all when there
 * is nothing to say.
 *
 * Read-only, non-fatal, and deliberately not awaited by `listen` — a slow or
 * unavailable database must not hold the port closed.
 *
 * @returns {Promise<void>}
 */
const auditLegacyTokens = async () => {
  try {
    // `bufferCommands` is false (config/db.js), so a query issued before the
    // handshake completes THROWS rather than queueing. The listen callback
    // usually wins that race, which is why this waits for the connection
    // instead of assuming it.
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('database not connected in time')), 15000);
        mongoose.connection.once('connected', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    const { allowLegacyPlaintext } = require('./utils/tokenCrypto');
    // A plaintext Google token contains no ':'; every encrypted one is
    // `iv:ciphertext:tag`. This is a cheap negative match for the report only —
    // `tokenCrypto.isEncrypted` is the authority on the read path.
    const plaintext = { $exists: true, $nin: [null, ''], $not: /:/ };
    const count = await User.countDocuments({
      $or: [
        { gmailRefreshToken: plaintext },
        { gmailAccessToken: plaintext },
        { 'linkedGmailAccounts.gmailRefreshToken': plaintext },
        { 'linkedGmailAccounts.gmailAccessToken': plaintext }
      ]
    });

    if (count === 0) return;

    logger.warn(
      {
        accounts: count,
        allowLegacyPlaintextTokens: allowLegacyPlaintext(),
        remediation: 'node scripts/encryptExistingTokens.js --apply',
        then: 'set ALLOW_LEGACY_PLAINTEXT_TOKENS=false and restart'
      },
      'OAuth tokens are stored in PLAINTEXT for some accounts. See docs/DEPLOY-WINDOWS.md.'
    );
  } catch (err) {
    logger.debug({ err: err.message }, 'legacy token audit skipped');
  }
};

server.listen(PORT, () => {
  logger.info(
    { port: PORT, queue: queue.backend(), redis: isRedisConfigured(), env: process.env.NODE_ENV || 'development' },
    'server listening'
  );
  auditLegacyTokens();
  queue.startWorkers();
  // F-4: expire stale presence entries and re-broadcast a roster that changed
  // because somebody's tab went away without a clean disconnect.
  presence.startPresenceSweeper(io);
  // Start overdue checking / auto-sync schedulers
  startCronJobs(io);
});

// ---------------------------------------------------------------------------
// Graceful shutdown & process-level crash handling
// ---------------------------------------------------------------------------

const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 10000);
let shuttingDown = false;

/**
 * Stop accepting new work, drain in-flight requests, then close Socket.io and
 * Mongo before exiting.
 * @param {String} signal
 * @param {Number} exitCode
 */
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.set('shuttingDown', true); // /api/health starts reporting 503 immediately

  logger.info({ signal }, '[SHUTDOWN] draining connections');

  // Hard stop if draining hangs, so a stuck socket cannot block the deploy.
  const forceExit = setTimeout(() => {
    logger.error('[SHUTDOWN] drain timed out; forcing exit');
    process.exit(exitCode || 1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    // Stop firing new scheduled work before anything else is torn down.
    const { stopCronJobs } = require('./utils/cronJobs');
    stopCronJobs();

    // F-4 presence is ephemeral by design; the sweeper is simply stopped and
    // the in-process rosters dropped. Nothing needs persisting.
    presence.stopPresence();

    await queue.shutdownQueues();
    logger.info('[SHUTDOWN] job queues closed');

    await new Promise((resolve) => io.close(resolve));
    logger.info('[SHUTDOWN] Socket.io closed');

    await new Promise((resolve) => server.close(resolve));
    logger.info('[SHUTDOWN] HTTP server closed');

    await mongoose.connection.close(false);
    logger.info('[SHUTDOWN] MongoDB connection closed');

    await closeRedis();

    clearTimeout(forceExit);
    process.exit(exitCode);
  } catch (err) {
    logger.error({ err: err.message }, '[SHUTDOWN] error while draining');
    process.exit(1);
  }
};

process.on('SIGTERM', () => shutdown('SIGTERM', 0));
process.on('SIGINT', () => shutdown('SIGINT', 0));

// After an uncaught exception the process state is undefined — a half-finished
// save may hold an open transaction, a `finally` may never have run. Continuing
// to serve traffic converts a fail-fast crash into silent data corruption, so
// exit and let the supervisor (pm2/systemd/k8s) restart a clean process.
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
  shutdown('uncaughtException', 1);
});

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason.message : String(reason) }, 'unhandled rejection');
  shutdown('unhandledRejection', 1);
});
