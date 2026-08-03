/**
 * The ONLY module in the client allowed to touch auth-related localStorage.
 *
 * Before this existed the user object was re-read and re-parsed from
 * localStorage in 12 places with 4 different fallback shapes, and `logout()`
 * left 7 `cached_*` keys behind — leaking the previous user's email subjects,
 * senders and body previews to the next person on a shared machine.
 *
 * Token transport stays in localStorage for this wave; when the backend moves
 * to httpOnly cookies only this file changes.
 */

const TOKEN_KEY = 'token'
const USER_KEY = 'user'

/**
 * Every per-user cache written by the pages. `logout()` clears all of them.
 * If a page adds a new cache key, add it here too.
 */
export const CACHE_KEYS = [
  'cached_dashboard_tasks',
  'cached_dashboard_stats',
  'cached_inbox_emails',
  'cached_clients_data',
  'cached_reports_overall',
  'cached_reports_timeline',
  'cached_tasks_data',
]

/** Roles, highest privilege first. */
export const ROLES = ['Admin', 'Head', 'Employee']

/** Single canonical shape for a signed-out / unknown user. */
export const ANONYMOUS_USER = null

const AUTH_EVENT = 'maildesk:auth'

function safeGet(key) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch (err) {
    console.error(`[auth] Unable to persist ${key}:`, err)
  }
}

function safeRemove(key) {
  try {
    window.localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

/** Broadcast an auth change to every listener in this tab. */
function emit() {
  try {
    window.dispatchEvent(new Event(AUTH_EVENT))
    // Legacy pages still listen for 'storage'; keep them in sync.
    window.dispatchEvent(new Event('storage'))
  } catch {
    /* ignore */
  }
}

/** @returns {string|null} the raw JWT, or null. */
export function getToken() {
  return safeGet(TOKEN_KEY) || null
}

export function setToken(token) {
  if (token) safeSet(TOKEN_KEY, token)
  else safeRemove(TOKEN_KEY)
  emit()
}

/**
 * @returns {object|null} the stored user, or null. Never throws, never returns
 * a made-up `{ name: 'Guest' }` placeholder — callers decide how to render an
 * unknown user.
 */
export function getUser() {
  const raw = safeGet(USER_KEY)
  if (!raw) return ANONYMOUS_USER
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : ANONYMOUS_USER
  } catch (err) {
    console.error('[auth] Corrupt user payload in localStorage, discarding:', err)
    safeRemove(USER_KEY)
    return ANONYMOUS_USER
  }
}

export function setUser(user) {
  if (user) safeSet(USER_KEY, JSON.stringify(user))
  else safeRemove(USER_KEY)
  emit()
}

/** Persist both halves of a successful sign-in. */
export function setSession({ token, user }) {
  if (token) safeSet(TOKEN_KEY, token)
  if (user) safeSet(USER_KEY, JSON.stringify(user))
  emit()
}

export function isAuthenticated() {
  return Boolean(getToken())
}

export function getRole(user = getUser()) {
  return user?.role || null
}

export function hasRole(role, user = getUser()) {
  if (!user) return false
  const wanted = Array.isArray(role) ? role : [role]
  return wanted.includes(user.role)
}

export const isAdmin = (user = getUser()) => hasRole('Admin', user)
export const isHead = (user = getUser()) => hasRole('Head', user)
export const isEmployee = (user = getUser()) => hasRole('Employee', user)

/** Remove every per-user cache without touching the session. */
export function clearCaches() {
  CACHE_KEYS.forEach(safeRemove)
}

/**
 * Clear token + user + ALL cached_* payloads.
 * Use `logout()` from AuthProvider when inside React — this is the storage-only
 * primitive, also used by the axios 401 handler.
 */
export function clearSession() {
  safeRemove(TOKEN_KEY)
  safeRemove(USER_KEY)
  clearCaches()
  emit()
}

/**
 * Subscribe to auth changes (this tab and other tabs).
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  window.addEventListener(AUTH_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(AUTH_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export { AUTH_EVENT, TOKEN_KEY, USER_KEY }
