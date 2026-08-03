/**
 * The cache as the app actually uses it: a real render, the real AuthProvider,
 * the real axios instance, MSW counting requests.
 *
 * `queryCache.test.js` proves the store's rules. This file proves the two
 * things a user would notice — that revisiting a screen costs nothing, and
 * that a write is visible immediately — plus the one thing they must never be
 * able to notice, which is somebody else's data.
 */
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import api from '../api/axios'
import { API, TEST_USER, listResponse } from '../test/handlers'
import { server } from '../test/server'
import { renderWithProviders, seedSession } from '../test/utils'
import { invalidateForSocketEvent, setCacheOwner } from './queryCache'
import { useCachedQuery } from './useCachedQuery'

const USER_B = {
  _id: 'u-employee',
  name: 'Ravi Kumar',
  email: 'ravi@example.com',
  role: 'Employee',
  status: 'Approved',
}

/** Minimal consumer: renders the row titles and nothing else. */
function TaskProbe({ params = { page: 1 } }) {
  const { data, loading, error } = useCachedQuery('/tasks', params)
  if (loading) return <p>loading</p>
  if (error) return <p>error: {error}</p>
  return (
    <ul aria-label="tasks">
      {(data?.data ?? []).map((t) => (
        <li key={t._id}>{t.title}</li>
      ))}
    </ul>
  )
}

/** Records every GET /tasks and answers with `rows`. */
function countTaskRequests(rows) {
  const seen = []
  server.use(
    http.get(`${API}/tasks`, ({ request }) => {
      seen.push(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json(listResponse(rows, { total: rows.length }))
    })
  )
  return seen
}

const ROWS_A = [{ _id: 't1', title: 'Acme GST filing' }]

beforeEach(() => {
  seedSession()
})

afterEach(() => {
  setCacheOwner(null)
})

describe('cache hit / miss', () => {
  it('fetches on the first visit and serves the second from memory — zero requests', async () => {
    const seen = countTaskRequests(ROWS_A)

    const first = renderWithProviders(<TaskProbe />)
    expect(await screen.findByText('Acme GST filing')).toBeInTheDocument()
    expect(seen).toHaveLength(1)

    first.unmount()

    renderWithProviders(<TaskProbe />)
    // Painted from the cache in the FIRST render: no loading state at all.
    expect(screen.getByText('Acme GST filing')).toBeInTheDocument()
    expect(screen.queryByText('loading')).not.toBeInTheDocument()

    // The assertion this whole feature exists for.
    await waitFor(() => expect(seen).toHaveLength(1))
  })

  it('is a miss for different params — page 2 is not page 1', async () => {
    const seen = countTaskRequests(ROWS_A)

    const first = renderWithProviders(<TaskProbe params={{ page: 1 }} />)
    await screen.findByText('Acme GST filing')
    first.unmount()

    renderWithProviders(<TaskProbe params={{ page: 2 }} />)
    await waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1]).toMatchObject({ page: '2' })
  })

  it('hits regardless of the order the params object was built in', async () => {
    const seen = countTaskRequests(ROWS_A)

    const first = renderWithProviders(<TaskProbe params={{ page: 1, status: 'Late' }} />)
    await screen.findByText('Acme GST filing')
    first.unmount()

    renderWithProviders(<TaskProbe params={{ status: 'Late', page: 1 }} />)
    expect(screen.getByText('Acme GST filing')).toBeInTheDocument()
    await waitFor(() => expect(seen).toHaveLength(1))
  })
})

describe('invalidation on mutation', () => {
  it('a POST /tasks forces the next visit to refetch', async () => {
    const seen = countTaskRequests(ROWS_A)
    server.use(http.post(`${API}/tasks`, () => HttpResponse.json({ success: true })))

    const first = renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')
    expect(seen).toHaveLength(1)
    first.unmount()

    // The axios response interceptor drops /tasks — no call site opts in.
    await api.post('/tasks', { title: 'New' })

    renderWithProviders(<TaskProbe />)
    await waitFor(() => expect(seen).toHaveLength(2))
  })

  it('refetches a MOUNTED page, so a write is visible without navigating away', async () => {
    let rows = ROWS_A
    server.use(
      http.get(`${API}/tasks`, () => HttpResponse.json(listResponse(rows, { total: rows.length }))),
      http.put(`${API}/tasks/:id`, () => HttpResponse.json({ success: true }))
    )

    renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')

    rows = [{ _id: 't1', title: 'Acme GST filing (edited)' }]
    await api.put('/tasks/t1', { title: 'Acme GST filing (edited)' })

    expect(await screen.findByText('Acme GST filing (edited)')).toBeInTheDocument()
  })

  it('leaves an unrelated resource alone', async () => {
    const seen = countTaskRequests(ROWS_A)
    server.use(http.post(`${API}/clients`, () => HttpResponse.json({ success: true })))

    const first = renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')
    first.unmount()

    await api.post('/clients', { name: 'Acme' })

    renderWithProviders(<TaskProbe />)
    await waitFor(() => expect(seen).toHaveLength(1))
  })
})

describe('invalidation on socket event', () => {
  it('a task-shaped newNotification refreshes a mounted list', async () => {
    let rows = ROWS_A
    server.use(
      http.get(`${API}/tasks`, () => HttpResponse.json(listResponse(rows, { total: rows.length })))
    )

    renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')

    rows = [...ROWS_A, { _id: 't2', title: 'Renew trade licence' }]
    // Exactly what ProtectedLayout does with the socket payload.
    invalidateForSocketEvent('newNotification', { type: 'task_assigned', taskId: 't2' })

    expect(await screen.findByText('Renew trade licence')).toBeInTheDocument()
  })

  it('an identity-only event leaves a mounted task list alone', async () => {
    const seen = countTaskRequests(ROWS_A)
    server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(TEST_USER)))
    renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')

    invalidateForSocketEvent('user:updated')
    // Let a real round trip complete, so "no second request" is a measurement
    // rather than an assertion made before anything could have happened.
    await api.get('/auth/me')

    expect(seen).toHaveLength(1)
  })
})

describe('cross-user isolation', () => {
  it("a second user never observes the first user's cached rows, and pays for their own fetch", async () => {
    const seen = countTaskRequests(ROWS_A)

    // --- user A ---------------------------------------------------------
    const asAdmin = renderWithProviders(<TaskProbe />)
    expect(await screen.findByText('Acme GST filing')).toBeInTheDocument()
    expect(seen).toHaveLength(1)
    asAdmin.unmount()

    // --- user B, on the same machine, same tab ---------------------------
    window.localStorage.clear()
    seedSession({ user: USER_B })
    server.use(
      http.get(`${API}/tasks`, () =>
        HttpResponse.json(listResponse([{ _id: 't9', title: "Ravi's own task" }], { total: 1 }))
      )
    )

    renderWithProviders(<TaskProbe />)

    // The load-bearing assertion: A's row is never rendered, not even for one
    // frame before the revalidation lands.
    expect(screen.queryByText('Acme GST filing')).not.toBeInTheDocument()
    expect(await screen.findByText("Ravi's own task")).toBeInTheDocument()
    expect(screen.queryByText('Acme GST filing')).not.toBeInTheDocument()
  })

  it('signing back in as the SAME user does not resurrect the pre-logout cache', async () => {
    const seen = countTaskRequests(ROWS_A)

    const first = renderWithProviders(<TaskProbe />)
    await screen.findByText('Acme GST filing')
    first.unmount()

    // logout(): lib/auth.clearSession() empties the query cache too.
    const { clearSession } = await import('./auth')
    clearSession()

    seedSession({ user: TEST_USER })
    renderWithProviders(<TaskProbe />)

    await waitFor(() => expect(seen).toHaveLength(2))
  })

  it('caches nothing at all while signed out', async () => {
    const seen = countTaskRequests(ROWS_A)
    server.use(http.get(`${API}/auth/me`, () => HttpResponse.json(TEST_USER)))
    window.localStorage.clear()
    setCacheOwner(null)

    const first = renderWithProviders(<TaskProbe />)
    // No user id means no owner, which means the hook is parked: it neither
    // requests nor caches, because an unattributed entry would be readable by
    // whoever signs in next. Awaiting a real round trip first makes this a
    // measurement rather than an assertion that runs before anything could.
    await api.get('/auth/me')
    expect(seen).toHaveLength(0)
    first.unmount()
  })
})
