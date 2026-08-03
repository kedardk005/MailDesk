import { useCallback, useEffect, useRef, useState } from 'react'
import api, { getErrorMessage, isCanceled } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import {
  DEFAULT_TTL,
  affects,
  cacheKey,
  getCacheOwner,
  normaliseUrl,
  readCache,
  subscribe,
  writeCache,
} from './queryCache'

/**
 * Stale-while-revalidate GET, backed by `lib/queryCache`.
 *
 * Behaviour, which is the whole point of the module:
 *
 *   | cache state           | what the user sees | requests |
 *   |-----------------------|--------------------|----------|
 *   | miss                  | skeleton           | 1        |
 *   | hit, inside the TTL   | the page, instantly| **0**    |
 *   | hit, past the TTL     | the page, instantly| 1, in the background |
 *
 * A background revalidation that returns an identical payload does not
 * re-render, and one that *fails* leaves the rendered page alone rather than
 * blanking it — a stale list beats an error page for data the user is reading.
 *
 * Identity comes from `useAuth()`, and `readCache` refuses to answer unless the
 * entry was fetched for that same user id. See the header of `queryCache.js`.
 *
 * @param {string} url - path relative to the axios baseURL, e.g. `/tasks`
 * @param {object|null} [params] - query params; need not be memoised
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] - `false` parks the hook (no request)
 * @param {number}  [options.ttl]
 * @param {string}  [options.failureMessage]
 * @param {(signal: AbortSignal) => Promise<*>} [options.fetcher] - replaces the
 *        plain GET. `url` then names the cache entry rather than a real
 *        endpoint (e.g. `/tasks/overview`, a derived multi-request read that
 *        still wants to be dropped whenever `/tasks` is invalidated).
 * @returns {{
 *   data: *, error: string|null, loading: boolean, fromCache: boolean,
 *   refetch: () => void, patch: (updater: (data: *) => *) => void
 * }}
 */
export function useCachedQuery(url, params = null, options = {}) {
  const { enabled = true, ttl = DEFAULT_TTL, failureMessage, fetcher } = options
  const { user } = useAuth()
  const owner = user?._id ? String(user._id) : null

  const path = normaliseUrl(url)
  // Transport-faithful (feeds axios and the effect deps) vs. order-independent
  // (feeds the cache key), so `{a,b}` and `{b,a}` share one cache entry.
  const paramsJson = JSON.stringify(params ?? null)
  const key = enabled && path && owner ? cacheKey(path, params) : ''

  const [state, setState] = useState(() => snapshot(key, owner, ttl))
  const [nonce, setNonce] = useState(0)
  const forceRef = useRef(false)

  /* A `fetcher` is almost always an inline arrow, so it cannot be an effect
   * dependency without refetching on every render. It is identified by the
   * cache key instead — which encodes the URL tag and the params — and read
   * through a ref. Declared BEFORE the fetch effect so it is always up to date
   * by the time that effect runs in the same commit. */
  const fetcherRef = useRef(fetcher)
  useEffect(() => {
    fetcherRef.current = fetcher
  })

  /* Follow the key like a prop. Adjusting state during render is the
   * documented alternative to a synchronising effect (ClientList does the same
   * for its search box) and it is what lets a cache hit paint on the FIRST
   * render, with no loading flash and no second render pass. */
  if (state.key !== key) setState(snapshot(key, owner, ttl))

  useEffect(() => {
    if (!key || !owner) return undefined

    const force = forceRef.current
    forceRef.current = false

    // The zero-request path: a fresh entry is already on screen.
    if (!force && readCache(key, owner, ttl)?.fresh) return undefined

    const controller = new AbortController()
    let alive = true

    const run = fetcherRef.current
      ? Promise.resolve().then(() => fetcherRef.current(controller.signal))
      : api
          .get(path, { params: JSON.parse(paramsJson) ?? undefined, signal: controller.signal })
          .then((res) => res.data)

    run
      .then((payload) => {
        if (!alive) return
        // Re-check the owner: a response that was in flight across a user
        // switch must never land in the new user's cache.
        if (ownerStillCurrent(owner)) writeCache(key, path, payload, owner)
        setState((prev) => {
          if (prev.key !== key) return prev
          if (prev.data !== null && sameData(prev.data, payload)) {
            return prev.loading ? { ...prev, loading: false, error: null } : prev
          }
          return { key, data: payload, error: null, loading: false, fromCache: false }
        })
      })
      .catch((err) => {
        if (!alive || isCanceled(err)) return
        setState((prev) => {
          if (prev.key !== key) return prev
          // Background revalidation failed but we have a rendered page: keep it.
          if (prev.data !== null) return { ...prev, loading: false }
          return {
            key,
            data: null,
            error: getErrorMessage(err, failureMessage),
            loading: false,
            fromCache: false,
          }
        })
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [key, path, paramsJson, owner, ttl, nonce, failureMessage])

  /* Refetch when something drops this URL — a mutation anywhere in the app, or
   * a socket event. Without this, an invalidation would only take effect the
   * next time the page mounted. */
  useEffect(() => {
    if (!key) return undefined
    return subscribe((prefixes) => {
      if (!affects(prefixes, path)) return
      forceRef.current = true
      setNonce((n) => n + 1)
    })
  }, [key, path])

  const refetch = useCallback(() => {
    forceRef.current = true
    setNonce((n) => n + 1)
  }, [])

  /**
   * Merge a local change into the rendered payload AND the cache entry, without
   * a round trip. Used for per-row edits (marking mail read, a status change)
   * where refetching the whole list would scroll the user back to the top.
   */
  const patch = useCallback(
    (updater) => {
      setState((prev) => {
        if (prev.key !== key || prev.data === null) return prev
        const next = updater(prev.data)
        if (next === undefined || next === prev.data) return prev
        writeCache(key, path, next, owner)
        return { ...prev, data: next }
      })
    },
    [key, path, owner]
  )

  return {
    data: state.data,
    error: state.error,
    loading: state.loading,
    fromCache: state.fromCache,
    refetch,
    patch,
  }
}

/* -------------------------------------------------------------------------- */

/** Initial (and key-change) state, computed synchronously from the cache. */
function snapshot(key, owner, ttl) {
  const hit = key ? readCache(key, owner, ttl) : null
  if (hit) {
    return { key, data: hit.data, error: null, loading: false, fromCache: true }
  }
  return { key, data: null, error: null, loading: Boolean(key), fromCache: false }
}

/** "Update if changed": an identical revalidation must not re-render the page. */
function sameData(a, b) {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

/**
 * `writeCache` already refuses an unattributed entry and `readCache` refuses to
 * answer the wrong user; this closes the remaining window — a response that was
 * in flight while the session changed underneath it.
 *
 * `setCacheOwner()` runs synchronously from `lib/auth.js` on every session
 * write, so by the time a post-switch response resolves the owner has moved.
 */
function ownerStillCurrent(owner) {
  return Boolean(owner) && getCacheOwner() === owner
}

export default useCachedQuery
