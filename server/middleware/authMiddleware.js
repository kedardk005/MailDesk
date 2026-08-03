const jwt = require('jsonwebtoken');
const User = require('../models/User');
const cache = require('../utils/cache');
const { log } = require('../utils/logger');

const logger = log('auth');

/**
 * Load the authenticated user, cache-aside.
 *
 * Every single API request used to issue an uncached `User.findById` returning
 * a HYDRATED Mongoose document — one extra round-trip and one hydration per
 * request, typically 15-25% of total request latency and double the pool
 * checkout rate.
 *
 * Correctness note: this cache is deliberately short-lived AND explicitly
 * invalidated. `tokenVersion`, `status` and `deletedAt` are the revocation
 * signals, so every write path that changes them (`updateUser`, `deleteUser`,
 * `changePassword`, `resetPassword`) calls `cache.invalidateUser`. Without that
 * invalidation, a deactivated account would keep working for the TTL.
 *
 * @param {String} userId
 * @returns {Promise<Object|null>} a lean user object
 */
const loadUser = async (userId) => {
  try {
    return await cache.wrap(cache.KEYS.user(String(userId)), cache.TTL.user, async () => {
      // `.lean()`: nothing downstream calls `.save()` on req.user.
      const user = await User.findById(userId).select('-password').lean();
      // `null` is not cacheable through wrap()'s undefined check, so normalise.
      return user || null;
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'cached user lookup failed; falling back to a direct read');
    return User.findById(userId).select('-password').lean();
  }
};

// The single status that grants access. Mirrors the `status` enum on the User
// model ('Pending' | 'Approved' | 'Rejected').
const ACTIVE_STATUS = 'Approved';

/**
 * Shared account-state gate used by both the HTTP `protect` middleware and the
 * Socket.io handshake, so a deactivated session cannot survive on either
 * transport.
 *
 * @param {Object} user - User document
 * @param {Object} decoded - Verified JWT payload
 * @returns {{ ok: Boolean, status?: Number, message?: String }}
 */
const checkAccountState = (user, decoded) => {
  if (!user) {
    return { ok: false, status: 401, message: 'Not authorized. User not found.' };
  }

  // Soft-deleted accounts must not be able to keep using an issued token.
  if (user.deletedAt) {
    return { ok: false, status: 401, message: 'Not authorized. Account no longer exists.' };
  }

  // Token revocation (password change, status change, role change).
  if (user.tokenVersion !== undefined && decoded.tokenVersion !== user.tokenVersion) {
    return { ok: false, status: 401, message: 'Not authorized. Token has been revoked.' };
  }

  // Previously absent: rejecting or suspending a user left their JWT valid for
  // the remaining 7 days, and a self-registered 'Pending' account was fully
  // usable via the token handed out at registration.
  if (user.status !== ACTIVE_STATUS) {
    return { ok: false, status: 403, message: 'Account is not active. Please contact an administrator.' };
  }

  return { ok: true };
};

/**
 * Protect routes by verifying JWT tokens
 */
const protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // Require the trailing space so `Bearerfoo` is not treated as a Bearer token.
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authorized. No token provided.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ message: 'Not authorized. No token provided.' });
  }

  try {
    // Pin the algorithm rather than letting it be inferred from the secret.
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });

    const user = await loadUser(decoded.id);

    const state = checkAccountState(user, decoded);
    if (!state.ok) {
      return res.status(state.status).json({ message: state.message });
    }

    req.user = user;
    return next();
  } catch (error) {
    logger.debug({ err: error.message }, 'JWT verification failed');
    return res.status(401).json({ message: 'Not authorized. Token verification failed.' });
  }
};

/**
 * Authorize specific roles
 * @param {...String} roles - Allowed user roles
 */
const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authorized. User context missing.' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Forbidden. Role '${req.user.role}' is not authorized to access this resource.`
      });
    }

    next();
  };
};

module.exports = {
  protect,
  authorizeRoles,
  checkAccountState,
  loadUser,
  ACTIVE_STATUS
};
