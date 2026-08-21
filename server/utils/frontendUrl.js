/**
 * FRONTEND_URL serves two different jobs, and conflating them is a bug.
 *
 *  1. A CORS/Socket.io ALLOWLIST — which origins may call this API. That is a
 *     list, because a deployment can have more than one front door (a custom
 *     domain plus the platform-issued address).
 *
 *  2. The CANONICAL address used to BUILD links — password reset emails, task
 *     links, the Gmail OAuth return. That is exactly one URL.
 *
 * When FRONTEND_URL became a comma-separated allowlist, every link-building
 * caller silently kept treating the whole string as a URL, producing
 * `https://a.example.com,https://b.example.com/inbox` — a password reset link
 * that 404s, and an OAuth callback that never lands. It fails only once a
 * second origin is configured, so it would have shipped looking fine.
 *
 * `primaryAppUrl()` is the FIRST entry: put the address you want in emails at
 * the front of FRONTEND_URL.
 */

const DEFAULT_APP_URL = 'http://localhost:5173';

/**
 * Every origin allowed to call this API.
 * @returns {String[]} trimmed, trailing slash removed, empties dropped
 */
const allowedOrigins = () =>
  (process.env.FRONTEND_URL || DEFAULT_APP_URL)
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);

/**
 * The one address used when building a link for a human to click.
 * @returns {String} no trailing slash, safe to concatenate a path onto
 */
const primaryAppUrl = () => allowedOrigins()[0] || DEFAULT_APP_URL;

module.exports = { allowedOrigins, primaryAppUrl, DEFAULT_APP_URL };
