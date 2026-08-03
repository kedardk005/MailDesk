const jwt = require('jsonwebtoken');

/**
 * Session JWT minting.
 *
 * Extracted from authController so `PUT /api/users/change-password` can hand
 * back a replacement token (WAVE2 gap S-6) without one controller requiring
 * another. There is exactly ONE place that decides what goes in the payload,
 * so the `tokenVersion` revocation claim cannot drift between call sites.
 *
 * `tokenVersion` is the revocation signal: `middleware/authMiddleware.js`
 * rejects any token whose version is behind the user document's.
 *
 * @param {Object} user - the user document (needs _id, role, tokenVersion)
 * @returns {String} a signed JWT
 */
const generateToken = (user) =>
  jwt.sign(
    { id: user._id, role: user.role, tokenVersion: user.tokenVersion || 0 },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

module.exports = { generateToken };
