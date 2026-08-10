const { callResilient } = require('./resilience');
const { log } = require('./logger');

const logger = log('mail');

/**
 * Outbound transactional mail via the Brevo (ex-Sendinblue) HTTP API.
 *
 * Replaces the Nodemailer/Gmail-SMTP transport. The API is a single HTTPS
 * POST, so there is no connection pool, no TLS handshake per message and no
 * SMTP greeting/socket timeout to tune — and no Gmail app password to store.
 *
 * `sendEmail()` still only ENQUEUES. An employee marking a task Complete, an
 * Admin approving a user and /forgot-password must never block on a third
 * party. The actual send (`sendEmailNow`) runs in the queue worker with
 * retries, exponential backoff and a dead-letter path.
 */

const BREVO_ENDPOINT = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';

/**
 * True when Brevo is configured well enough to attempt a send.
 * @returns {Boolean}
 */
const isMailConfigured = () =>
  Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);

/**
 * Perform the HTTP send. Called by the queue worker, not by request handlers.
 *
 * @param {{to: String, subject: String, body: String, html: String}} payload
 * @returns {Promise<Object|null>} `{ messageId }`, or null when mail is unconfigured
 * @throws when the send fails, so the queue can retry it
 */
const sendEmailNow = async ({ to, subject, body, html }) => {
  if (!isMailConfigured()) {
    logger.warn('BREVO_API_KEY / BREVO_SENDER_EMAIL are not set; email sending is disabled');
    return null;
  }

  const payload = {
    sender: {
      email: process.env.BREVO_SENDER_EMAIL,
      name: process.env.BREVO_SENDER_NAME || 'K M KOTHARI'
    },
    to: [{ email: to }],
    subject,
    // Brevo requires at least one content field. The callers always supply
    // plain text; html is optional and added only when present.
    textContent: body || ' '
  };
  if (html) payload.htmlContent = html;
  if (process.env.BREVO_REPLY_TO) payload.replyTo = { email: process.env.BREVO_REPLY_TO };

  const send = async () => {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'content-type': 'application/json',
        accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      // Read the body for the reason, but never log it at info level: Brevo
      // echoes the recipient address back in errors.
      let detail = '';
      try {
        detail = JSON.stringify(await res.json()).slice(0, 300);
      } catch {
        detail = `<unparseable ${res.status} body>`;
      }

      const err = new Error(`Brevo responded ${res.status}`);
      err.status = res.status;
      err.detail = detail;
      // 4xx other than 429 will never succeed on retry — a bad key, an
      // unverified sender or a malformed address. Mark it so the queue can
      // dead-letter instead of burning five attempts on a certain failure.
      err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
      throw err;
    }

    return res.json().catch(() => ({}));
  };

  const result = await callResilient('brevo', send, {
    timeoutMs: Number(process.env.BREVO_TIMEOUT_MS || 15000),
    attempts: 1, // the queue owns the retry policy
    failureThreshold: 5,
    resetTimeoutMs: 60000
  });

  logger.info({ to, subject, messageId: result?.messageId || null }, 'email sent');
  // Same shape the queue worker already reads.
  return { messageId: result?.messageId || null };
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
 * working; the return value is a job handle rather than a provider response.
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

module.exports = { sendEmail, sendEmailNow, isMailConfigured, resolveRecipientId };
