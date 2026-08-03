const nodemailer = require('nodemailer');
const { callResilient } = require('./resilience');
const { log } = require('./logger');

const logger = log('smtp');

/**
 * Outbound transactional mail.
 *
 * `sendEmail()` no longer performs the SMTP round-trip — it enqueues. An
 * employee marking a task Complete, an Admin approving a user and
 * `/forgot-password` all used to block on `smtp.gmail.com`, which takes
 * 300 ms - 3 s normally and, with no timeouts configured anywhere, could hang
 * for the OS TCP default of about two minutes.
 *
 * The actual send (`sendEmailNow`) runs in the queue worker with retries,
 * exponential backoff and a dead-letter path.
 */

let transporter = null;

/**
 * Pooled transport with real timeouts. Created lazily so requiring this module
 * has no side effects.
 * @returns {Object} nodemailer transport
 */
const getTransporter = () => {
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    // Reuse connections instead of a fresh TLS handshake per message.
    pool: true,
    maxConnections: Number(process.env.SMTP_MAX_CONNECTIONS || 3),
    maxMessages: Number(process.env.SMTP_MAX_MESSAGES || 100),
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 20000),
    auth: {
      user: process.env.SENDER_EMAIL,
      pass: process.env.SENDER_APP_PASSWORD
    }
  });
  return transporter;
};

/**
 * Perform the SMTP send. Called by the queue worker, not by request handlers.
 *
 * @param {{to: String, subject: String, body: String, html: String}} payload
 * @returns {Promise<Object|null>} nodemailer info, or null when SMTP is unconfigured
 * @throws when the send fails, so the queue can retry it
 */
const sendEmailNow = async ({ to, subject, body, html }) => {
  const sender = process.env.SENDER_EMAIL;
  const password = process.env.SENDER_APP_PASSWORD;

  if (!sender || !password) {
    logger.warn('SENDER_EMAIL / SENDER_APP_PASSWORD are not set; email sending is disabled');
    return null;
  }

  const mailOptions = { from: sender, to, subject, text: body };
  if (html) mailOptions.html = html;

  const info = await callResilient('smtp', () => getTransporter().sendMail(mailOptions), {
    timeoutMs: Number(process.env.SMTP_TIMEOUT_MS || 25000),
    attempts: 1, // the queue owns the retry policy
    failureThreshold: 5,
    resetTimeoutMs: 60000
  });

  logger.info({ to, subject, messageId: info?.messageId }, 'email sent');
  return info;
};

/**
 * Resolve the recipient's user id from an address, so a preference-governed
 * send can be checked even when the caller only has the address.
 *
 * @param {String} address
 * @returns {Promise<String|null>}
 */
const resolveRecipientId = async (address) => {
  try {
    const User = require('../models/User');
    const user = await User.findOne({ email: String(address).toLowerCase().trim(), deletedAt: null })
      .select('_id')
      .lean();
    return user ? String(user._id) : null;
  } catch {
    return null;
  }
};

/**
 * Queue an email. Returns as soon as the job is accepted (~1 ms) instead of
 * after the SMTP round-trip.
 *
 * The first four parameters are unchanged so every existing caller keeps
 * working; the return value is a job handle rather than nodemailer info.
 *
 * WAVE2 gap S-12 — preference enforcement is OPT-IN via `options.event`:
 *
 *   sendEmail(to, subject, body, html)                          // transactional; ALWAYS sent
 *   sendEmail(to, subject, body, html, { event: 'task_completed' })  // honours preferences
 *
 * That split is deliberate. Password resets, account-approval mail and anything
 * else the user cannot opt out of pass no `event` and are never suppressed;
 * only notification-style mail is governed. Quiet hours suppress email only.
 *
 * @param {String} to
 * @param {String} subject
 * @param {String} body - plain text
 * @param {String} [html]
 * @param {Object} [options]
 * @param {String} [options.event] - one of User.NOTIFICATION_EVENTS
 * @param {String} [options.userId] - recipient id, saves an address lookup
 * @returns {Promise<Object|null>} null when unsent (no recipient, suppressed, or queue failure)
 */
const sendEmail = async (to, subject, body, html = null, options = {}) => {
  if (!to) {
    logger.warn({ subject }, 'sendEmail called without a recipient');
    return null;
  }

  const { event = null, userId = null } = options || {};

  if (event) {
    try {
      const recipientId = userId || (await resolveRecipientId(to));
      // An address with no matching account is not preference-governed —
      // there are no preferences to consult, so it is delivered.
      if (recipientId) {
        const { shouldDeliver } = require('./notificationPrefs');
        if (!(await shouldDeliver(recipientId, 'email', event))) {
          logger.debug({ to, event }, 'email suppressed by recipient preference');
          return null;
        }
      }
    } catch (err) {
      // Fail open: never lose a message because the preference check broke.
      logger.debug({ err: err.message, to, event }, 'preference check failed; sending anyway');
    }
  }

  try {
    // Required lazily: utils/queue -> jobs/index -> utils/emailHelper would
    // otherwise be a require cycle at module load time.
    const { enqueue, QUEUES } = require('./queue');
    return await enqueue(
      QUEUES.EMAIL_SEND,
      { to, subject, body, html },
      { attempts: Number(process.env.EMAIL_JOB_ATTEMPTS || 5), backoffMs: 10000 }
    );
  } catch (err) {
    // Never let a mail failure break the business operation that triggered it.
    logger.error({ err: err.message, to, subject }, 'failed to queue email');
    return null;
  }
};

module.exports = { sendEmail, sendEmailNow, getTransporter, resolveRecipientId };
