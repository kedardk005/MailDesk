const crypto = require('crypto');
const pino = require('pino');

/**
 * Structured logging.
 *
 * `console.log` to a pipe (which is what stdout is under Docker/PM2/systemd) is
 * a SYNCHRONOUS write on Linux: every call blocks the event loop until the pipe
 * drains. The sync path used to emit one line per saved email, one per socket
 * emit and one per cron tick, so a 150-message sync meant 150+ blocking writes.
 * pino writes JSON through sonic-boom and is roughly 5x faster.
 *
 * Everything that could carry a credential is redacted centrally here, because
 * error objects thrown by googleapis routinely embed the request config —
 * including the bearer token.
 */

const DEFAULT_LEVEL = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'newPassword',
  'currentPassword',
  '*.password',
  '*.gmailAccessToken',
  '*.gmailRefreshToken',
  '*.resetTokenHash',
  'gmailAccessToken',
  'gmailRefreshToken',
  'access_token',
  'refresh_token',
  '*.access_token',
  '*.refresh_token',
  'config.headers.Authorization',
  'response.config.headers.Authorization'
];

const logger = pino({
  level: process.env.LOG_LEVEL || DEFAULT_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'maildesk-api', pid: process.pid }
});

/**
 * Request-scoped logging middleware. Attaches `req.id` (a UUID, or the inbound
 * `x-request-id` when a proxy already assigned one) and `req.log`, so a single
 * request can be traced across the whole log stream.
 * @returns {Function} express middleware
 */
const httpLogger = () => {
  const pinoHttp = require('pino-http');
  return pinoHttp({
    logger,
    genReqId: (req, res) => {
      const existing = req.headers['x-request-id'];
      const id = (typeof existing === 'string' && existing.length <= 100 && existing) || crypto.randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // Health and readiness probes fire constantly; logging them at info level
    // buries everything else.
    autoLogging: {
      ignore: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/api/health'
    },
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({ id: req.id, method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode })
    }
  });
};

/**
 * A child logger for a subsystem, e.g. `log('gmail-sync')`.
 * @param {String} component
 * @returns {Object} pino child logger
 */
const log = (component) => logger.child({ component });

module.exports = { logger, httpLogger, log };
