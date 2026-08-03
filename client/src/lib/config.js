/**
 * Runtime configuration, read from Vite env vars.
 *
 * Every network endpoint in the client MUST come from here. Hard-coding
 * `http://localhost:5015` anywhere is a deployment blocker.
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

  if (!/^https?:\/\//i.test(value)) {
    throw new Error(
      `[config] ${key} must be an absolute http(s) URL. Received: "${value}"`
    )
  }

  return value.replace(/\/+$/, '')
}

/** REST base URL, including the `/api` prefix. */
export const API_URL = readEnv('VITE_API_URL', DEV_API_FALLBACK)

/** Socket.io origin — no path, no trailing slash. */
export const SOCKET_URL = readEnv('VITE_SOCKET_URL', DEV_SOCKET_FALLBACK)

/** Origin of the API (API_URL minus any path) — handy for absolute asset URLs. */
export const API_ORIGIN = (() => {
  try {
    return new URL(API_URL).origin
  } catch {
    return SOCKET_URL
  }
})()

export const IS_DEV = Boolean(import.meta.env?.DEV)
export const IS_PROD = Boolean(import.meta.env?.PROD)

export default { API_URL, SOCKET_URL, API_ORIGIN, IS_DEV, IS_PROD }
