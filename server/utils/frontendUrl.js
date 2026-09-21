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

/**
 * True for an origin that can only exist inside a private network.
 *
 * The LAN deployment serves the client and the API from one Express process,
 * and people reach it by whatever name their machine resolves —
 * `http://kmk-server`, `http://kmk-server.local`, or the raw
 * `http://192.168.1.40`. FRONTEND_URL can only name ONE of those.
 *
 * Scope, measured rather than assumed: this affects Socket.io's POLLING
 * fallback and cross-origin REST, not the WebSocket transport, which engine.io
 * accepts from any origin because CORS does not apply to WebSocket. So the
 * failure it prevents is narrow — a browser that falls back to polling loses
 * live updates when it reached the app by an address FRONTEND_URL does not
 * list — but it is silent when it happens, and on a LAN the alternate address
 * is the normal case, not the exception.
 *
 * Deliberately narrow — loopback, RFC1918, CGNAT, link-local, `.local`, and
 * dotless single-label hostnames, which cannot be public DNS names. A public
 * hostname still has to be in FRONTEND_URL.
 */
const LAN_HOST = new RegExp(
  '^(' +
    'localhost' +
    '|127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}' +
    '|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}' +
    '|192\\.168\\.\\d{1,3}\\.\\d{1,3}' +
    '|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}' +
    '|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])\\.\\d{1,3}\\.\\d{1,3}' +
    '|169\\.254\\.\\d{1,3}\\.\\d{1,3}' +
    '|[^.]+\\.local' +
    '|[^.:]+' +
  ')$',
  'i'
);

/**
 * @param {String} origin a browser Origin header, e.g. `http://kmk-server`
 * @returns {Boolean} true when it is plain http to a private-network host
 */
const isLanOrigin = (origin) => {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  // http only: an https LAN origin means a proxy is in front, and then the
  // operator can and should name it explicitly.
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === '::1') return true;
  return LAN_HOST.test(host);
};

module.exports = { allowedOrigins, primaryAppUrl, isLanOrigin, DEFAULT_APP_URL };
