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
    const client = createConnection({}, `ratelimit:${prefix}`);
    if (!client) return undefined;
    return new RedisStore({
      prefix: `rl:${prefix}:`,
      sendCommand: (...args) => client.call(...args)
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'rate-limit-redis unavailable; using the in-memory store');
    return undefined;
  }
};

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_AUTH_MAX || 10),
  message: { message: 'Too many authentication attempts from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  store: buildLimiterStore('auth')
});

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: Number(process.env.RATE_LIMIT_GENERAL_MAX || 300),
  message: { message: 'Too many requests from this IP, please try again after 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
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

// Apply Limiters to routes
app.use('/api', generalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);

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

server.listen(PORT, () => {
  logger.info(
    { port: PORT, queue: queue.backend(), redis: isRedisConfigured(), env: process.env.NODE_ENV || 'development' },
    'server listening'
  );
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
