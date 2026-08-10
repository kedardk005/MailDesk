/**
 * Rate-limit key resolution (audit H-8).
 *
 * The limiters used to key on `req.ip`. Every member of one office shares a
 * single public NAT address, so 300 requests / 15 min and 10 logins / 15 min
 * were *office-wide* budgets: a single dashboard load costs ~11 counted API
 * calls, i.e. ~27 dashboard loads per quarter hour for the whole firm, and a
 * 15-person office could not all sign in on a Monday morning.
 *
 * The general limiter must therefore key on the authenticated USER. That has
 * an ordering problem: `generalLimiter` is mounted on `/api` in index.js, long
 * before any router's `protect` has run, so `req.user` does not exist yet.
 * `attachRateLimitIdentity` closes that gap with a cheap, side-effect-free JWT
 * *signature* check — no database round trip, no session load, no
 * authorization decision. It only answers "which key does this request count
 * against". Authentication is still entirely `protect`'s job: a forged or
 * expired token simply falls back to the IP bucket and is rejected downstream.
 *
 * Login is the opposite problem. Per-IP throttling of `/api/auth/login` is a
 * bad credential-stuffing control (it punishes the office and barely
 * inconveniences a botnet), so the per-account limiter below is the real
 * defence: attempts are counted against the *email being tried*, and successful
 * logins do not count at all.
 */

const jwt = require('jsonwebtoken');
const { ipKeyGenerator } = require('express-rate-limit');

// A JWT longer than this is not a session token this server issued; refuse to
// spend CPU verifying it.
const MAX_TOKEN_LENGTH = Number(process.env.RATE_LIMIT_MAX_TOKEN_LENGTH || 4096);

/**
 * Best-effort identification of the caller, for limiter keying only.
 *
 * Sets `req.rateLimitUserId` when the bearer token verifies. Never throws,
 * never writes a response, never grants access.
 *
 * @returns {Function} express middleware
 */
const attachRateLimitIdentity = () => (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ') || header.length > MAX_TOKEN_LENGTH + 7) return next();
    if (!process.env.JWT_SECRET) return next();

    // Same algorithm pin as `protect`, so an `alg: none` token cannot claim a
    // bucket that is not its own.
    const decoded = jwt.verify(header.slice(7), process.env.JWT_SECRET, { algorithms: ['HS256'] });
    if (decoded && decoded.id) req.rateLimitUserId = String(decoded.id);
  } catch {
    // Expired, forged, or malformed: this request counts against its IP, and
    // `protect` will reject it a few middlewares later.
  }
  return next();
};

/**
 * Per-user key with an IP fallback for anonymous routes.
 *
 * `ipKeyGenerator` (not `req.ip`) is required by express-rate-limit v7+: a raw
 * IPv6 address gives every client in a /64 its own bucket, which is no limit at
 * all.
 *
 * @param {Object} req
 * @returns {String}
 */
const userOrIpKey = (req) => (req.rateLimitUserId ? `u:${req.rateLimitUserId}` : ipOnlyKey(req));

/**
 * Per-account key for the auth routes: the email being attempted, falling back
 * to the IP when the body carries none (a malformed request must still be
 * bounded).
 *
 * Lower-cased and length-bounded so `A@b.test` and `a@b.test` share one bucket
 * and a 100 KB string cannot become a cache key.
 *
 * @param {Object} req
 * @returns {String}
 */
const accountKey = (req) => {
  const raw = req.body && typeof req.body.email === 'string' ? req.body.email : '';
  const email = raw.trim().toLowerCase().slice(0, 254);
  return email ? `acct:${email}` : ipOnlyKey(req);
};

/** IP-only key, for the coarse anti-abuse ceiling on the auth routes. */
const ipOnlyKey = (req) => `ip:${ipKeyGenerator(req.ip || 'unknown')}`;

module.exports = { attachRateLimitIdentity, userOrIpKey, accountKey, ipOnlyKey };
