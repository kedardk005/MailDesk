/**
 * Runtime configuration, read from Vite env vars.
 *
 * Every network endpoint in the client MUST come from here. Hard-coding
 * `http://localhost:5015` anywhere is a deployment blocker.
 *
 * Two shapes are accepted:
 *
 *   ABSOLUTE  `https://api.example.com/api` — client and API on different
 *             hosts, as when the client is on a CDN.
 *
 *   RELATIVE  `/api`, or `/` for the socket — client and API served by the
 *             SAME origin, which is how the office deployment works: one
 *             Express process serves both over the LAN.
 *
 * Relative matters more than it looks. Vite bakes these values in at BUILD
 * time, so an absolute URL pins the bundle to one hostname — rebuild the day
 * the machine's IP changes, or the day somebody reaches it by name instead of
 * by address. A relative path just follows whatever host the page was loaded
 * from, so `http://kmk-server/`, `http://192.168.0.12/` and `http://localhost/`
 * all work from a single build.
 */

const DEV_API_FALLBACK = 'http://localhost:5015/api'
const DEV_SOCKET_FALLBACK = 'http://localhost:5015'

function readEnv(key, devFallback) {
  const raw = import.meta.env?.[key]
  const value = typeof raw === 'string' ? raw.trim() : ''

  if (!value) {
    if (import.meta.env?.PROD) {
      // Fail loudly: a production build pointed at localhost is worse than a
      // clear error at boot.
      throw new Error(
        `[config] Missing required environment variable ${key}. ` +
          `Add it to client/.env (see client/.env.example) before building.`
      )
    }
    console.warn(
      `[config] ${key} is not set — falling back to "${devFallback}". ` +
        `Copy client/.env.example to client/.env to silence this.`
    )
    return devFallback
  }

  const isAbsolute = /^https?:\/\//i.test(value)
  const isRelative = value.startsWith('/')

  if (!isAbsolute && !isRelative) {
    throw new Error(
      `[config] ${key} must be an absolute http(s) URL (https://host/api) ` +
        `or a same-origin path (/api). Received: "${value}"`
    )
  }

  // A bare "/" means "this origin" and must survive; stripping its trailing
  // slash would leave an empty string, which reads as "unset" everywhere else.
  if (value === '/') return value

  return value.replace(/\/+$/, '')
}

/** REST base URL, including the `/api` prefix. */
export const API_URL = readEnv('VITE_API_URL', DEV_API_FALLBACK)

/**
 * Socket.io origin — no path, no trailing slash. `/` means this page's origin,
 * which is what socket.io-client assumes when given a path rather than a host.
 */
export const SOCKET_URL = readEnv('VITE_SOCKET_URL', DEV_SOCKET_FALLBACK)

/**
 * Origin of the API (API_URL minus any path) — for the few places that need an
 * absolute URL, such as an attachment link.
 *
 * When API_URL is relative the API lives on this page's own origin, so that is
 * the answer. `new URL('/api')` throws without a base, which is why this is not
 * simply a try/catch around it.
 */
export const API_ORIGIN = (() => {
  if (API_URL.startsWith('/')) {
    return typeof window !== 'undefined' ? window.location.origin : ''
  }
  try {
    return new URL(API_URL).origin
  } catch {
    return SOCKET_URL
  }
})()

export const IS_DEV = Boolean(import.meta.env?.DEV)
export const IS_PROD = Boolean(import.meta.env?.PROD)

export default { API_URL, SOCKET_URL, API_ORIGIN, IS_DEV, IS_PROD }
