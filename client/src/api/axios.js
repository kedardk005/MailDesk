import axios from 'axios'
import { toast } from 'sonner'
import { API_URL } from '../lib/config'
import { getToken, clearSession } from '../lib/auth'
import { invalidateForMutation } from '../lib/queryCache'

/**
 * Shared API client.
 *
 * Request  — attaches the bearer token.
 * Response — normalises the four failure modes the UI must react to:
 *              401  session gone      -> clear state, redirect to /login ONCE
 *              403  not permitted     -> permission toast
 *              429  rate limited      -> toast with retry-after
 *              net  offline / DNS     -> clear offline message
 */
const api = axios.create({
  baseURL: API_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 30000,
})

api.interceptors.request.use(
  (config) => {
    const token = getToken()
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  },
  (error) => Promise.reject(error)
)

/* --------------------------------------------------------------------------
 * 401 handling — must fire exactly once, no redirect loop.
 * ------------------------------------------------------------------------ */
let redirectingToLogin = false
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password', '/reset-password']

function onSessionExpired(message) {
  if (redirectingToLogin) return
  redirectingToLogin = true

  clearSession()

  const path = window.location.pathname
  if (PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    redirectingToLogin = false
    return
  }

  if (message) toast.error(message)

  // Preserve where the user was so login can bounce them back.
  const next = encodeURIComponent(path + window.location.search)
  window.location.replace(`/login?next=${next}`)
}

/* Rate-limit / offline toasts are deduped: a burst of parallel requests must
 * not stack ten identical toasts. */
let lastNetworkToastAt = 0
function throttledToast(kind, message, options) {
  const now = Date.now()
  if (now - lastNetworkToastAt < 3000) return
  lastNetworkToastAt = now
  toast[kind](message, options)
}

function retryAfterText(headers) {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After']
  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  if (seconds < 60) return ` Try again in ${Math.ceil(seconds)}s.`
  return ` Try again in ${Math.ceil(seconds / 60)} min.`
}

api.interceptors.response.use(
  (response) => {
    /*
     * Cache invalidation on mutation, in ONE place.
     *
     * Every successful POST/PUT/PATCH/DELETE drops the query-cache entries its
     * URL affects (the matrix lives in lib/queryCache.js), so creating,
     * editing or deleting a task makes the task lists refetch immediately
     * instead of waiting out a TTL — and no mutation call site has to remember
     * to say so. 40+ call sites; a per-site convention would have been missed.
     */
    invalidateForMutation(response.config?.method, response.config?.url)
    return response
  },
  (error) => {
    // Request cancelled via AbortController / CancelToken — never user-facing.
    if (axios.isCancel?.(error) || error?.code === 'ERR_CANCELED') {
      return Promise.reject(error)
    }

    const { response, config } = error || {}

    // ---- network layer ----------------------------------------------------
    if (!response) {
      if (error?.code === 'ECONNABORTED') {
        error.userMessage = 'The server took too long to respond. Please retry.'
      } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        error.userMessage = 'You are offline. Reconnect and try again.'
      } else {
        error.userMessage =
          'Cannot reach the server. Check your connection or try again shortly.'
      }
      throttledToast('error', error.userMessage)
      return Promise.reject(error)
    }

    const status = response.status
    const serverMessage = response.data?.message || response.data?.error

    /*
     * An auth request owns its own error presentation: the sign-in form renders
     * the message in an inline <Alert> next to the fields. Toasting it as well
     * showed the user the same sentence twice, and a 4s toast is the weaker
     * affordance on a form built to hold the error. `error.userMessage` is still
     * set, so the page always has the text.
     */
    const isAuthAttempt = /\/auth\/(login|register|forgot-password|reset-password)/.test(
      config?.url || ''
    )

    switch (status) {
      case 401: {
        error.userMessage = serverMessage || 'Your session has expired. Please sign in again.'
        // Don't hijack the login/registration request itself.
        if (!isAuthAttempt) onSessionExpired(error.userMessage)
        break
      }
      case 403: {
        error.userMessage =
          serverMessage ||
          "You don't have permission to do that. Ask an administrator for access."
        if (!isAuthAttempt) toast.error(error.userMessage)
        break
      }
      case 429: {
        error.userMessage =
          (serverMessage || 'Too many requests.') + retryAfterText(response.headers)
        throttledToast('warning', error.userMessage)
        break
      }
      case 500:
      case 502:
      case 503:
      case 504: {
        error.userMessage = serverMessage || 'The server ran into a problem. Please try again.'
        break
      }
      default: {
        error.userMessage = serverMessage || 'Something went wrong. Please try again.'
      }
    }

    return Promise.reject(error)
  }
)

/**
 * Human-readable message for any error thrown by this client.
 * Pages should render `getErrorMessage(err)` instead of digging through
 * `err.response.data.message` themselves.
 */
export function getErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) return fallback
  return (
    error.userMessage ||
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.message ||
    fallback
  )
}

/** True when the rejection is just a cancelled request. */
export function isCanceled(error) {
  return Boolean(axios.isCancel?.(error)) || error?.code === 'ERR_CANCELED'
}

/**
 * Rethrow helper for effects: swallows cancellation, rethrows anything real.
 *
 *   useEffect(() => {
 *     const ctrl = new AbortController()
 *     api.get('/tasks', { signal: ctrl.signal })
 *        .then(r => setTasks(r.data))
 *        .catch(ignoreCancel)
 *     return () => ctrl.abort()
 *   }, [])
 */
export function ignoreCancel(error) {
  if (isCanceled(error)) return undefined
  throw error
}

/**
 * AbortController-friendly wrapper.
 *
 *   const req = abortable((signal) => api.get('/tasks', { signal }))
 *   req.promise.then(...)
 *   req.abort()
 */
export function abortable(fn) {
  const controller = new AbortController()
  return {
    promise: fn(controller.signal),
    abort: () => controller.abort(),
    signal: controller.signal,
  }
}

export default api
