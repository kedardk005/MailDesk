/**
 * axios interceptors.
 *
 * This module is the only place the app decides what a failed request MEANS, so
 * a regression here is silent: a 401 that does not redirect leaves the user
 * clicking a dead screen, and a 401 that redirects twice is a login loop. Both
 * were live behaviours before this client existed.
 *
 * `redirectingToLogin` and the toast throttle are MODULE-level state, so every
 * test re-imports the module through `freshApi()` rather than sharing one
 * instance and pretending the order does not matter.
 */
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { API } from '../test/handlers'
import { server } from '../test/server'

const { toastMock } = vi.hoisted(() => ({
  toastMock: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: toastMock, Toaster: () => null }))

/** Re-import the client so module-level flags start clean. */
async function freshApi() {
  vi.resetModules()
  return import('./axios')
}

/** jsdom's Location is not writable in place; swap the whole object. */
function stubLocation(pathname = '/tasks', search = '') {
  const replace = vi.fn()
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { pathname, search, href: `http://localhost${pathname}${search}`, replace, reload: vi.fn() },
  })
  return replace
}

const realLocation = window.location

beforeEach(() => {
  Object.values(toastMock).forEach((fn) => fn.mockClear())
})

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: realLocation,
  })
})

describe('request interceptor', () => {
  it('attaches the stored bearer token', async () => {
    window.localStorage.setItem('token', 'jwt-abc')
    let seen = null
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        seen = request.headers.get('authorization')
        return HttpResponse.json({ data: [], pagination: {} })
      })
    )

    const { default: api } = await freshApi()
    await api.get('/tasks')

    expect(seen).toBe('Bearer jwt-abc')
  })

  it('sends no Authorization header when signed out', async () => {
    let seen = 'unset'
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        seen = request.headers.get('authorization')
        return HttpResponse.json({ data: [], pagination: {} })
      })
    )

    const { default: api } = await freshApi()
    await api.get('/tasks')

    expect(seen).toBeNull()
  })
})

describe('401 — session expired', () => {
  beforeEach(() => {
    window.localStorage.setItem('token', 'jwt-abc')
    window.localStorage.setItem('user', JSON.stringify({ name: 'Asha' }))
    window.localStorage.setItem('cached_inbox_emails', '[{"subject":"secret"}]')
    server.use(
      http.get(`${API}/tasks`, () =>
        HttpResponse.json({ message: 'Session expired.' }, { status: 401 })
      )
    )
  })

  it('clears the session, every cached_* key, and redirects once', async () => {
    const replace = stubLocation('/tasks', '?status=Pending')
    const { default: api } = await freshApi()

    await expect(api.get('/tasks')).rejects.toMatchObject({ userMessage: 'Session expired.' })

    expect(window.localStorage.getItem('token')).toBeNull()
    expect(window.localStorage.getItem('user')).toBeNull()
    expect(window.localStorage.getItem('cached_inbox_emails')).toBeNull()

    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith(`/login?next=${encodeURIComponent('/tasks?status=Pending')}`)
  })

  it('redirects exactly once for a burst of parallel 401s — no login loop', async () => {
    const replace = stubLocation('/tasks')
    const { default: api } = await freshApi()

    await Promise.allSettled([api.get('/tasks'), api.get('/tasks'), api.get('/tasks')])

    expect(replace).toHaveBeenCalledTimes(1)
  })

  it('does not redirect when the 401 came from the sign-in attempt itself', async () => {
    const replace = stubLocation('/login')
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json({ message: 'Invalid credentials.' }, { status: 401 })
      )
    )
    const { default: api } = await freshApi()

    await expect(api.post('/auth/login', {})).rejects.toMatchObject({
      userMessage: 'Invalid credentials.',
    })
    expect(replace).not.toHaveBeenCalled()
  })

  it('does not redirect when the user is already on a public page', async () => {
    const replace = stubLocation('/forgot-password')
    const { default: api } = await freshApi()

    await expect(api.get('/tasks')).rejects.toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })

  it('stays able to redirect after a public-page 401 released the latch', async () => {
    const replace = stubLocation('/reset-password')
    const { default: api } = await freshApi()
    await expect(api.get('/tasks')).rejects.toBeTruthy()
    expect(replace).not.toHaveBeenCalled()

    const replaceAgain = stubLocation('/tasks')
    await expect(api.get('/tasks')).rejects.toBeTruthy()
    expect(replaceAgain).toHaveBeenCalledTimes(1)
  })
})

describe('403 — not permitted', () => {
  it('raises a permission toast and a permission message', async () => {
    server.use(http.get(`${API}/users`, () => new HttpResponse(null, { status: 403 })))
    const { default: api, getErrorMessage } = await freshApi()

    const err = await api.get('/users').catch((e) => e)

    expect(getErrorMessage(err)).toMatch(/don't have permission/i)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
    expect(toastMock.error.mock.calls[0][0]).toMatch(/don't have permission/i)
  })

  it('prefers the message the server sent, when there is one', async () => {
    server.use(
      http.get(`${API}/users`, () =>
        HttpResponse.json({ message: 'Admins only.' }, { status: 403 })
      )
    )
    const { default: api, getErrorMessage } = await freshApi()

    const err = await api.get('/users').catch((e) => e)
    expect(getErrorMessage(err)).toBe('Admins only.')
    expect(toastMock.error).toHaveBeenCalledWith('Admins only.')
  })
})

describe('429 — rate limited', () => {
  it('honours a seconds-scale Retry-After', async () => {
    server.use(
      http.get(`${API}/tasks`, () =>
        HttpResponse.json({ message: 'Too many requests.' }, {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      )
    )
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)

    expect(err.userMessage).toBe('Too many requests. Try again in 30s.')
    expect(toastMock.warning).toHaveBeenCalledWith(err.userMessage, undefined)
  })

  it('rounds a minutes-scale Retry-After up to whole minutes', async () => {
    server.use(
      http.get(`${API}/tasks`, () =>
        new HttpResponse(null, { status: 429, headers: { 'Retry-After': '90' } })
      )
    )
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)
    expect(err.userMessage).toBe('Too many requests. Try again in 2 min.')
  })

  it('omits the hint when Retry-After is missing or nonsense', async () => {
    server.use(
      http.get(`${API}/tasks`, () =>
        new HttpResponse(null, { status: 429, headers: { 'Retry-After': 'soon' } })
      )
    )
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)
    expect(err.userMessage).toBe('Too many requests.')
  })

  it('throttles a burst into a single toast', async () => {
    server.use(http.get(`${API}/tasks`, () => new HttpResponse(null, { status: 429 })))
    const { default: api } = await freshApi()

    await Promise.allSettled([api.get('/tasks'), api.get('/tasks'), api.get('/tasks')])

    expect(toastMock.warning).toHaveBeenCalledTimes(1)
  })
})

describe('network failures', () => {
  it('explains an unreachable server', async () => {
    server.use(http.get(`${API}/tasks`, () => HttpResponse.error()))
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)

    expect(err.response).toBeUndefined()
    expect(err.userMessage).toMatch(/cannot reach the server/i)
    expect(toastMock.error).toHaveBeenCalledTimes(1)
  })

  it('says "offline" when the browser knows it is offline', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    server.use(http.get(`${API}/tasks`, () => HttpResponse.error()))
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)
    expect(err.userMessage).toBe('You are offline. Reconnect and try again.')
  })

  it('throttles repeated network toasts', async () => {
    server.use(http.get(`${API}/tasks`, () => HttpResponse.error()))
    const { default: api } = await freshApi()

    await Promise.allSettled([api.get('/tasks'), api.get('/tasks')])
    expect(toastMock.error).toHaveBeenCalledTimes(1)
  })
})

describe('5xx and unknown statuses', () => {
  it('gives a server-problem message and stays silent — the page decides', async () => {
    server.use(http.get(`${API}/tasks`, () => new HttpResponse(null, { status: 503 })))
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)

    expect(err.userMessage).toBe('The server ran into a problem. Please try again.')
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('falls back to a generic message on an unmapped status', async () => {
    server.use(http.get(`${API}/tasks`, () => new HttpResponse(null, { status: 418 })))
    const { default: api } = await freshApi()

    const err = await api.get('/tasks').catch((e) => e)
    expect(err.userMessage).toBe('Something went wrong. Please try again.')
  })

  it('leaves a 400 validation payload intact for the form to read', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json(
          { message: 'Validation failed', errors: [{ path: 'email', message: 'Not an email.' }] },
          { status: 400 }
        )
      )
    )
    const { default: api } = await freshApi()

    const err = await api.post('/auth/login', {}).catch((e) => e)
    expect(err.response.data.errors).toEqual([{ path: 'email', message: 'Not an email.' }])
    expect(toastMock.error).not.toHaveBeenCalled()
  })
})

describe('cancellation helpers', () => {
  it('abortable() aborts in flight, and the rejection is recognised as a cancel', async () => {
    server.use(
      http.get(`${API}/tasks`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200))
        return HttpResponse.json({ data: [] })
      })
    )
    const { default: api, abortable, isCanceled } = await freshApi()

    const req = abortable((signal) => api.get('/tasks', { signal }))
    req.abort()

    const err = await req.promise.catch((e) => e)
    expect(isCanceled(err)).toBe(true)
    // A cancel is never user-facing.
    expect(toastMock.error).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it('ignoreCancel swallows a cancellation and rethrows anything real', async () => {
    const { ignoreCancel, isCanceled } = await freshApi()

    expect(ignoreCancel({ code: 'ERR_CANCELED' })).toBeUndefined()
    expect(isCanceled({ code: 'ERR_CANCELED' })).toBe(true)

    const real = new Error('boom')
    expect(() => ignoreCancel(real)).toThrow('boom')
    expect(isCanceled(real)).toBe(false)
  })

  it('a superseded request cannot overwrite the winner — last query wins', async () => {
    /* The pattern EmailInbox relies on: abort the old request, keep the new. */
    const bodies = { slow: ['stale'], fast: ['fresh'] }
    server.use(
      http.get(`${API}/tasks`, async ({ request }) => {
        const which = new URL(request.url).searchParams.get('q')
        if (which === 'slow') await new Promise((resolve) => setTimeout(resolve, 150))
        return HttpResponse.json({ data: bodies[which] })
      })
    )
    const { default: api, abortable, isCanceled } = await freshApi()

    const first = abortable((signal) => api.get('/tasks', { params: { q: 'slow' }, signal }))
    const second = abortable((signal) => api.get('/tasks', { params: { q: 'fast' }, signal }))
    first.abort()

    const [a, b] = await Promise.all([first.promise.catch((e) => e), second.promise])
    expect(isCanceled(a)).toBe(true)
    expect(b.data.data).toEqual(['fresh'])
  })
})

describe('getErrorMessage', () => {
  it('prefers userMessage, then the server payload, then the axios message', async () => {
    const { getErrorMessage } = await freshApi()

    expect(getErrorMessage({ userMessage: 'A', response: { data: { message: 'B' } } })).toBe('A')
    expect(getErrorMessage({ response: { data: { message: 'B' } } })).toBe('B')
    expect(getErrorMessage({ response: { data: { error: 'C' } } })).toBe('C')
    expect(getErrorMessage({ message: 'D' })).toBe('D')
    expect(getErrorMessage(null, 'fallback')).toBe('fallback')
  })
})
