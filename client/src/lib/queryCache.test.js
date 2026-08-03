/**
 * The cache store, in isolation.
 *
 * The isolation assertions here are the point of the file. This codebase has
 * already shipped two cross-user leaks — `cached_*` localStorage keys that
 * survived logout, and a missing `Vary: Authorization` that served one role's
 * response to another. A third would be a pattern, so "user B cannot observe
 * user A's cached response" is asserted from four different angles: a direct
 * read with the wrong id, an owner switch, an explicit clear, and the storage
 * surface itself (nothing is written to localStorage at all).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TTL,
  MAX_ENTRIES,
  affects,
  cacheKey,
  cacheKeys,
  cacheStats,
  clearCache,
  invalidate,
  invalidateForMutation,
  invalidateForSocketEvent,
  normaliseUrl,
  readCache,
  setCacheOwner,
  stableStringify,
  subscribe,
  writeCache,
} from './queryCache'

const USER_A = 'user-a'
const USER_B = 'user-b'

beforeEach(() => {
  setCacheOwner(null)
})

describe('keys', () => {
  it('is independent of the order the params object was built in', () => {
    expect(cacheKey('/tasks', { page: 1, status: 'Late' })).toBe(
      cacheKey('/tasks', { status: 'Late', page: 1 })
    )
  })

  it('separates different params, and drops the query string from the url', () => {
    expect(cacheKey('/tasks', { page: 1 })).not.toBe(cacheKey('/tasks', { page: 2 }))
    expect(cacheKey('/tasks?page=9', { page: 1 })).toBe(cacheKey('/tasks', { page: 1 }))
  })

  it('treats absent, null and empty-string params as the same request', () => {
    expect(stableStringify({ q: '', status: null, page: 1 })).toBe(stableStringify({ page: 1 }))
  })

  it('normalises a missing leading slash', () => {
    expect(normaliseUrl('tasks')).toBe('/tasks')
    expect(normaliseUrl('/tasks?x=1')).toBe('/tasks')
  })
})

describe('hit / miss', () => {
  it('misses on an empty cache and hits after a write', () => {
    setCacheOwner(USER_A)
    const key = cacheKey('/tasks', { page: 1 })

    expect(readCache(key, USER_A)).toBeNull()

    writeCache(key, '/tasks', { data: [{ _id: 't1' }] }, USER_A)

    const hit = readCache(key, USER_A)
    expect(hit?.data).toEqual({ data: [{ _id: 't1' }] })
    expect(hit?.fresh).toBe(true)
  })

  it('reports a hit past the TTL as stale, not as a miss — that is what makes it serve-then-revalidate', () => {
    setCacheOwner(USER_A)
    const key = cacheKey('/tasks', null)
    const now = vi.spyOn(Date, 'now')

    now.mockReturnValue(1_000_000)
    writeCache(key, '/tasks', { data: [] }, USER_A)

    now.mockReturnValue(1_000_000 + DEFAULT_TTL + 1)
    const hit = readCache(key, USER_A)
    expect(hit).not.toBeNull()
    expect(hit.fresh).toBe(false)
  })

  it('refuses to store a response it cannot attribute to a user', () => {
    setCacheOwner(null)
    const key = cacheKey('/tasks', null)
    writeCache(key, '/tasks', { data: [1] }, null)
    expect(cacheKeys()).toHaveLength(0)
  })

  it('is bounded: the oldest entry is evicted past MAX_ENTRIES', () => {
    setCacheOwner(USER_A)
    for (let i = 0; i < MAX_ENTRIES + 10; i += 1) {
      const key = cacheKey('/tasks', { page: i })
      writeCache(key, '/tasks', { page: i }, USER_A)
    }
    expect(cacheStats().size).toBe(MAX_ENTRIES)
    // Page 0 is long gone; the most recent write is still there.
    expect(readCache(cacheKey('/tasks', { page: 0 }), USER_A)).toBeNull()
    expect(readCache(cacheKey('/tasks', { page: MAX_ENTRIES + 9 }), USER_A)).not.toBeNull()
  })

  it('keeps a re-read entry alive under eviction pressure (LRU, not FIFO)', () => {
    setCacheOwner(USER_A)
    const first = cacheKey('/tasks', { page: 'keep-me' })
    writeCache(first, '/tasks', { v: 1 }, USER_A)

    for (let i = 0; i < MAX_ENTRIES - 1; i += 1) {
      writeCache(cacheKey('/tasks', { page: i }), '/tasks', { page: i }, USER_A)
      // Touching it on every write moves it back to the end of the queue.
      readCache(first, USER_A)
    }
    writeCache(cacheKey('/tasks', { page: 'overflow' }), '/tasks', {}, USER_A)

    expect(readCache(first, USER_A)).not.toBeNull()
  })
})

describe('cross-user isolation', () => {
  it("refuses to answer a read from a different user's id", () => {
    setCacheOwner(USER_A)
    const key = cacheKey('/tasks', { page: 1 })
    writeCache(key, '/tasks', { data: [{ _id: 'a-secret' }] }, USER_A)

    expect(readCache(key, USER_B)).toBeNull()
    // ...and the mismatched entry is evicted outright, not left to be found later.
    expect(readCache(key, USER_A)).toBeNull()
  })

  it('empties the store when the owner changes', () => {
    setCacheOwner(USER_A)
    writeCache(cacheKey('/tasks', null), '/tasks', { data: ['a'] }, USER_A)
    writeCache(cacheKey('/clients', null), '/clients', { data: ['a'] }, USER_A)
    expect(cacheStats().size).toBe(2)

    setCacheOwner(USER_B)

    expect(cacheStats().size).toBe(0)
    expect(readCache(cacheKey('/tasks', null), USER_B)).toBeNull()
  })

  it('empties the store on logout (owner -> null) and cannot be revived by signing back in', () => {
    setCacheOwner(USER_A)
    writeCache(cacheKey('/tasks', null), '/tasks', { data: ['a'] }, USER_A)

    setCacheOwner(null) // clearSession()
    setCacheOwner(USER_A) // same person signs back in

    expect(readCache(cacheKey('/tasks', null), USER_A)).toBeNull()
  })

  it('never writes anything to localStorage or sessionStorage', () => {
    setCacheOwner(USER_A)
    writeCache(cacheKey('/gmail/emails', { page: 1 }), '/gmail/emails', {
      data: [{ subject: 'Confidential' }],
    }, USER_A)

    expect(window.localStorage.length).toBe(0)
    expect(window.sessionStorage.length).toBe(0)
    expect(JSON.stringify(window.localStorage)).not.toContain('Confidential')
  })
})

describe('invalidation on mutation', () => {
  beforeEach(() => {
    setCacheOwner(USER_A)
  })

  const seed = (url, params = null) => {
    const key = cacheKey(url, params)
    writeCache(key, url, { data: [] }, USER_A)
    return key
  }

  it('drops the task lists when a task is written', () => {
    const tasks = seed('/tasks', { page: 1 })
    const clients = seed('/clients')

    invalidateForMutation('POST', '/tasks')

    expect(readCache(tasks, USER_A)).toBeNull()
    expect(readCache(clients, USER_A)).not.toBeNull()
  })

  it('drops by prefix, so a nested route goes with its parent', () => {
    const comments = seed('/tasks/t1/comments')
    invalidateForMutation('DELETE', '/tasks/t1/comments/c9')
    expect(readCache(comments, USER_A)).toBeNull()
  })

  it('drops the derived dashboard overview along with the raw task lists', () => {
    const overview = seed('/tasks/overview', { scope: 'mine' })
    invalidateForMutation('PUT', '/tasks/t1')
    expect(readCache(overview, USER_A)).toBeNull()
  })

  it('drops tasks as well as mail when mail is assigned — the server creates tasks from it', () => {
    const tasks = seed('/tasks')
    const emails = seed('/gmail/emails')
    invalidateForMutation('POST', '/gmail/emails/bulk-assign')
    expect(readCache(tasks, USER_A)).toBeNull()
    expect(readCache(emails, USER_A)).toBeNull()
  })

  it('ignores GET — reading something never invalidates it', () => {
    const tasks = seed('/tasks')
    expect(invalidateForMutation('GET', '/tasks')).toEqual([])
    expect(readCache(tasks, USER_A)).not.toBeNull()
  })

  it('ignores routes that back nothing cached', () => {
    expect(invalidateForMutation('POST', '/ai/summarize-email')).toEqual([])
    expect(invalidateForMutation('POST', '/auth/login')).toEqual([])
  })
})

describe('invalidation on socket event', () => {
  beforeEach(() => {
    setCacheOwner(USER_A)
  })

  const seed = (url) => {
    const key = cacheKey(url, null)
    writeCache(key, url, { data: [] }, USER_A)
    return key
  }

  it('drops the task lists for a task-shaped notification', () => {
    const tasks = seed('/tasks')
    const notifications = seed('/notifications')
    const emails = seed('/gmail/emails')

    invalidateForSocketEvent('newNotification', { type: 'task_assigned', taskId: 't1' })

    expect(readCache(tasks, USER_A)).toBeNull()
    expect(readCache(notifications, USER_A)).toBeNull()
    expect(readCache(emails, USER_A)).not.toBeNull()
  })

  it('drops mail AND tasks for a mail-shaped notification', () => {
    const tasks = seed('/tasks')
    const emails = seed('/gmail/emails')

    invalidateForSocketEvent('newNotification', { type: 'email_assigned' })

    expect(readCache(tasks, USER_A)).toBeNull()
    expect(readCache(emails, USER_A)).toBeNull()
  })

  it('drops only the bell for an untyped notification with no task', () => {
    const tasks = seed('/tasks')
    const notifications = seed('/notifications')

    invalidateForSocketEvent('newNotification', { message: 'hello' })

    expect(readCache(notifications, USER_A)).toBeNull()
    expect(readCache(tasks, USER_A)).not.toBeNull()
  })

  it('still drops the task lists for an UNTYPED row that carries a taskId — the overdue cron omits `type` for the assignee', () => {
    const tasks = seed('/tasks')
    invalidateForSocketEvent('newNotification', { taskId: 't1' })
    expect(readCache(tasks, USER_A)).toBeNull()
  })

  it('empties everything on session:invalidated', () => {
    seed('/tasks')
    seed('/gmail/emails')
    invalidateForSocketEvent('session:invalidated')
    expect(cacheStats().size).toBe(0)
  })

  it('drops the identity reads on user:updated', () => {
    const me = seed('/auth/me')
    const users = seed('/users')
    const tasks = seed('/tasks')

    invalidateForSocketEvent('user:updated')

    expect(readCache(me, USER_A)).toBeNull()
    expect(readCache(users, USER_A)).toBeNull()
    expect(readCache(tasks, USER_A)).not.toBeNull()
  })

  it('ignores an event it has no rule for', () => {
    const tasks = seed('/tasks')
    expect(invalidateForSocketEvent('thread:viewers', {})).toEqual([])
    expect(readCache(tasks, USER_A)).not.toBeNull()
  })
})

describe('subscribers', () => {
  it('is notified on invalidate and on clear, and can unsubscribe', () => {
    const seen = []
    const off = subscribe((prefixes) => seen.push(prefixes))

    invalidate('/tasks')
    clearCache()
    off()
    invalidate('/tasks')

    expect(seen).toEqual([['/tasks'], null])
  })

  it('fires even when nothing was cached — the screen on display is stale either way', () => {
    const seen = []
    const off = subscribe((p) => seen.push(p))
    invalidate('/clients')
    off()
    expect(seen).toHaveLength(1)
  })

  it('affects() matches a prefix, a full clear, and nothing else', () => {
    expect(affects(['/tasks'], '/tasks')).toBe(true)
    expect(affects(['/tasks'], '/tasks/overview')).toBe(true)
    expect(affects(['/tasks'], '/tasksomething')).toBe(false)
    expect(affects(['/tasks'], '/clients')).toBe(false)
    expect(affects(null, '/anything')).toBe(true)
  })

  it('survives a listener that throws', () => {
    const seen = []
    const offBad = subscribe(() => {
      throw new Error('boom')
    })
    const offGood = subscribe(() => seen.push('ok'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    invalidate('/tasks')

    offBad()
    offGood()
    expect(seen).toEqual(['ok'])
  })
})
