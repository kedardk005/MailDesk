/**
 * Client-side read cache for list/detail GETs.
 *
 * Why this exists: every page mounted its own fetch effect, so Tasks -> Inbox
 * -> Tasks re-downloaded both lists in full. This is the smallest thing that
 * fixes that without a data-layer migration:
 *
 *   - keyed on `url + serialised params` (the `{data, pagination}` contract in
 *     docs/audits/API-LIST-CONTRACT.md);
 *   - **stale-while-revalidate** — a hit inside the TTL costs zero requests, a
 *     hit past it renders instantly and revalidates in the background;
 *   - dropped explicitly on mutation and on socket events, so freshness never
 *     depends on a timer alone;
 *   - bounded (LRU), so a long session cannot grow it without limit.
 *
 * ## Cross-user isolation — the non-negotiable part
 *
 * This codebase has already shipped two cross-user leaks (`cached_*`
 * localStorage keys surviving logout; a missing `Vary: Authorization`). The
 * rules that keep this from being the third:
 *
 *   1. **Memory only.** Nothing here touches localStorage or sessionStorage,
 *      so nothing survives a tab close, and nothing is readable by the next
 *      person on a shared machine.
 *   2. **Every entry records the user id that fetched it**, and `readCache`
 *      takes the *caller's* current user id and refuses to answer unless the
 *      two match. The caller's id comes from `useAuth()` — React state — not
 *      from this module's own bookkeeping, so a stale internal value can only
 *      cause a miss, never a leak.
 *   3. **`setCacheOwner()` empties the whole store whenever the user id
 *      changes**, and `clearCache()` runs from `auth.clearSession()` (the same
 *      teardown that removes the legacy `cached_*` keys) and from
 *      `session:invalidated`.
 *
 * (2) is the load-bearing rule; (1) and (3) are defence in depth.
 */

/** A cached page is served without a network request for this long. */
export const DEFAULT_TTL = 30_000

/** LRU ceiling. ~80 list pages is far more than a session navigates through. */
export const MAX_ENTRIES = 80

/**
 * @typedef {object} CacheEntry
 * @property {string} url      request path, for prefix invalidation
 * @property {*}      data     the raw axios `response.data`
 * @property {number} storedAt epoch ms
 * @property {string} owner    user id this response was fetched for
 */

/** @type {Map<string, CacheEntry>} insertion-ordered, so the first key is the LRU victim. */
const store = new Map()

/** @type {Set<(prefixes: string[]|null) => void>} */
const listeners = new Set()

/** Bookkeeping only — reads authenticate against the caller's id, not this. */
let ownerId = null

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic JSON: object keys sorted, `undefined`/`null` members dropped.
 * `{page: 1, q: ''}` and `{q: '', page: 1}` must be the same cache key, or the
 * cache silently never hits.
 *
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === undefined || value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (typeof value === 'object') {
    const parts = Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined && value[k] !== null && value[k] !== '')
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
    return `{${parts.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Strip the query string and normalise the leading slash, so `/tasks?x=1` and
 * `tasks` both become `/tasks`.
 * @param {string} url
 * @returns {string}
 */
export function normaliseUrl(url) {
  const path = String(url || '').split('?')[0].trim()
  if (!path) return ''
  return path.startsWith('/') ? path : `/${path}`
}

/**
 * @param {string} url
 * @param {object} [params]
 * @returns {string}
 */
export function cacheKey(url, params) {
  return `${normaliseUrl(url)}|${stableStringify(params)}`
}

/* -------------------------------------------------------------------------- */
/* Read / write                                                                */
/* -------------------------------------------------------------------------- */

/**
 * @param {string} key
 * @param {string|null} owner - the CALLER's current user id (from `useAuth()`)
 * @param {number} [ttl]
 * @returns {{data: *, storedAt: number, fresh: boolean}|null}
 */
export function readCache(key, owner, ttl = DEFAULT_TTL) {
  if (!key || !owner) return null
  const entry = store.get(key)
  if (!entry) return null

  // The isolation check. A response fetched for someone else is not a miss to
  // be revalidated — it is evicted outright.
  if (entry.owner !== String(owner)) {
    store.delete(key)
    return null
  }

  // LRU touch: re-inserting moves the key to the end of the iteration order.
  store.delete(key)
  store.set(key, entry)

  return {
    data: entry.data,
    storedAt: entry.storedAt,
    fresh: Date.now() - entry.storedAt < ttl,
  }
}

/**
 * @param {string} key
 * @param {string} url
 * @param {*} data - raw `response.data`
 * @param {string|null} owner - the user id the request was authenticated as
 */
export function writeCache(key, url, data, owner) {
  // Never cache a response we cannot attribute to a user — an anonymous entry
  // would be readable by whoever signs in next.
  if (!key || !owner) return

  store.delete(key)
  store.set(key, { url: normaliseUrl(url), data, storedAt: Date.now(), owner: String(owner) })

  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest === undefined) break
    store.delete(oldest)
  }
}

/* -------------------------------------------------------------------------- */
/* Invalidation                                                                */
/* -------------------------------------------------------------------------- */

function notify(prefixes) {
  listeners.forEach((listener) => {
    try {
      listener(prefixes)
    } catch (err) {
      console.error('[queryCache] listener failed:', err)
    }
  })
}

/**
 * Drop every entry whose URL starts with one of `prefixes`.
 *
 * Prefix matching deliberately over-invalidates (`/tasks` also drops
 * `/tasks/clients` and `/tasks/abc/comments`): the cost of dropping too much
 * is one refetch, the cost of dropping too little is a stale screen.
 *
 * @param {string|string[]} prefixes
 * @returns {number} entries removed
 */
export function invalidate(prefixes) {
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes]).map(normaliseUrl).filter(Boolean)
  if (list.length === 0) return 0

  let removed = 0
  for (const [key, entry] of store) {
    if (list.some((p) => entry.url === p || entry.url.startsWith(`${p}/`))) {
      store.delete(key)
      removed += 1
    }
  }

  // Mounted hooks refetch on this even when nothing was cached: the point of a
  // socket invalidation is that the screen on display is now wrong.
  notify(list)
  return removed
}

/** Empty the cache. Runs on logout, on `session:invalidated`, on owner change. */
export function clearCache() {
  store.clear()
  notify(null)
}

/**
 * ## The invalidation matrix — mutations
 *
 * Which URL prefixes a non-GET to `url` drops. Wired into the axios response
 * interceptor, so creating/editing/deleting anything invalidates immediately
 * rather than waiting out a TTL, and no mutation call site has to remember.
 *
 * @param {string} method
 * @param {string} url
 * @returns {string[]} the prefixes that were dropped
 */
export function invalidateForMutation(method, url) {
  const verb = String(method || '').toUpperCase()
  if (verb === 'GET' || verb === 'HEAD' || verb === 'OPTIONS') return []

  const path = normaliseUrl(url)
  let prefixes = []

  if (path.startsWith('/tasks')) {
    // A task write moves the task lists, the dashboard overview and every
    // report total.
    prefixes = ['/tasks', '/reports']
  } else if (path.startsWith('/clients')) {
    prefixes = ['/clients', '/tasks/clients', '/reports']
  } else if (path.startsWith('/gmail')) {
    // Assigning or deleting mail also creates/destroys tasks.
    prefixes = ['/gmail', '/tasks', '/reports', '/keyword-rules']
  } else if (path.startsWith('/keyword-rules')) {
    prefixes = ['/keyword-rules', '/gmail', '/tasks', '/reports']
  } else if (path.startsWith('/users')) {
    prefixes = ['/users', '/auth/me', '/reports']
  } else if (path.startsWith('/notifications')) {
    prefixes = ['/notifications']
  }
  // `/auth/*` and `/ai/*` are deliberately absent: sign-in is covered by the
  // owner change (which empties everything) and AI calls read nothing cached.

  if (prefixes.length === 0) return []
  invalidate(prefixes)
  return prefixes
}

/**
 * ## The invalidation matrix — socket events
 *
 * The three events the app already subscribes to. `newNotification` is the
 * useful one: the server only writes a notification when something the user
 * can see changed, so its `type` is a reliable signal for which list is stale.
 *
 * @param {string} event
 * @param {object} [payload] - for `newNotification`, the notification document
 * @returns {string[]} the prefixes that were dropped
 */
export function invalidateForSocketEvent(event, payload) {
  if (event === 'session:invalidated') {
    clearCache()
    return ['*']
  }

  if (event === 'user:updated') {
    const prefixes = ['/auth/me', '/users']
    invalidate(prefixes)
    return prefixes
  }

  if (event !== 'newNotification') return []

  // The notification row itself is always stale now.
  const prefixes = ['/notifications']
  const type = payload?.type

  switch (type) {
    case 'task_assigned':
    case 'task_completed':
    case 'task_overdue':
    case 'task_comment':
      prefixes.push('/tasks', '/reports')
      break
    case 'email_assigned':
    case 'email_approval':
      prefixes.push('/gmail', '/tasks', '/reports', '/keyword-rules')
      break
    default:
      // `type` is optional on the model and the overdue cron omits it for the
      // assignee's own row (server/utils/cronJobs.js). A `taskId` is the next
      // best evidence that a task changed; with neither, only the bell is
      // known to be stale.
      if (payload?.taskId) prefixes.push('/tasks', '/reports')
      break
  }

  invalidate(prefixes)
  return prefixes
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Bind the cache to a user id. **Any change empties the store**, so entries
 * belonging to the previous user cannot outlive the switch.
 *
 * Called synchronously from `lib/auth.js` on every session write and from
 * `AuthProvider` as a backstop for the cross-tab `storage` event.
 *
 * @param {string|null|undefined} nextOwner
 */
export function setCacheOwner(nextOwner) {
  const next = nextOwner ? String(nextOwner) : null
  if (next === ownerId) return
  ownerId = next
  clearCache()
}

/** @returns {string|null} */
export function getCacheOwner() {
  return ownerId
}

/**
 * @param {(prefixes: string[]|null) => void} listener - `null` means "everything"
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * True when an invalidation covering `prefixes` affects `url`.
 * `null` prefixes (a full clear) affects everything.
 *
 * @param {string[]|null} prefixes
 * @param {string} url
 * @returns {boolean}
 */
export function affects(prefixes, url) {
  if (prefixes === null) return true
  const path = normaliseUrl(url)
  return prefixes.some((p) => p === '*' || path === p || path.startsWith(`${p}/`))
}

/** Introspection for tests. Never used by the app. */
export function cacheStats() {
  return { size: store.size, max: MAX_ENTRIES, ttl: DEFAULT_TTL, owner: ownerId }
}

/** Keys currently held, oldest first. Tests only. */
export function cacheKeys() {
  return [...store.keys()]
}
