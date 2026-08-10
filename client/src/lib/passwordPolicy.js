/**
 * The client's mirror of the server's password rule (audit L-3).
 *
 * The server is the only authority. This exists so a user is told the rule
 * BEFORE a round trip, not instead of one. It used to be written out by hand in
 * five places (Register, ForgotPassword, Profile ×3, ManageUsers) as the literal
 * "6", which is exactly how a client number and a server number drift apart.
 * One constant, one hint, one validator.
 *
 * MIRRORS `server/middleware/schemas.js`. That file sets the floor to 12 —
 * NIST SP 800-63B's 8 is the absolute minimum, 12 is where an offline attack on
 * a bcrypt hash stops being routine — with no composition rules, and lets an
 * operator tighten it through a `PASSWORD_MIN_LENGTH` environment variable
 * clamped to [8, 64]. The same clamp is applied here so the two cannot be
 * configured into disagreeing in the loosening direction.
 *
 * Note the asymmetry that makes this safe: the rule governs NEW passwords only
 * (`loginSchema` still accepts `min(1)`), so an account created under the old
 * six-character rule signs in unchanged and only has to meet the floor the next
 * time it sets a password.
 *
 * If the two numbers ever do disagree — an operator who tightens the server and
 * forgets the client build — the client is deliberately the softer one.
 * Register, Forgot/Reset password and Profile all pass a 400 through
 * `fieldErrorsFrom()`, which renders the server's own `errors[].message` against
 * the offending input; ManageUsers surfaces it as a toast. A password this file
 * would wave through is still refused, with the server's real reason
 * ("Password must be at least N characters."). The cost of drift is a hint that
 * undersells the rule, never a form that fails without saying why.
 */

const DEFAULT_MIN_LENGTH = 12
const FLOOR = 8
const CEILING = 64

/** @returns {number} */
function readConfiguredMinimum() {
  const raw = Number(import.meta.env?.VITE_PASSWORD_MIN_LENGTH)
  const wanted = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MIN_LENGTH
  return Math.min(CEILING, Math.max(FLOOR, Math.trunc(wanted)))
}

/** Characters a NEW password must have. Login is not subject to this. */
export const PASSWORD_MIN_LENGTH = readConfiguredMinimum()

/** The hint that sits under a new-password field. */
export const PASSWORD_HINT = `At least ${PASSWORD_MIN_LENGTH} characters.`

/** The inline error shown when a new password is too short. */
export const PASSWORD_TOO_SHORT = `Use at least ${PASSWORD_MIN_LENGTH} characters.`

/**
 * @param {string} value
 * @returns {boolean} true when `value` clears the local floor
 */
export function isLongEnough(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH
}

export default PASSWORD_MIN_LENGTH
