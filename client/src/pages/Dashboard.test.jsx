/**
 * Dashboard — the two silent-wrong-number defects from the volume audit.
 *
 * Both bugs produced PLAUSIBLE numbers, which is why no test caught them:
 *
 *   D3: the Employee "Completed — last 30 days" tile filtered on `createdAt`,
 *       so it answered "created recently and happens to be complete" (9)
 *       instead of "completed recently" (12).
 *   D4: every tile was derived by filtering ONE legacy `GET /tasks` response,
 *       which the server caps at 200 rows — silently wrong for any user with
 *       more tasks than the cap.
 *
 * The fixtures here are built so the buggy computation and the correct one
 * give DIFFERENT numbers; asserting the correct number therefore fails on the
 * old code by construction.
 */
import { screen, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { API, TEST_USER, listResponse } from '../test/handlers'
import { server } from '../test/server'
import { renderWithProviders, seedSession } from '../test/utils'

import Dashboard from './Dashboard'

const DAY_MS = 86_400_000
const EMPLOYEE = { ...TEST_USER, _id: 'u-emp', name: 'Ravi Kumar', role: 'Employee' }

const todayStart = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

const iso = (ms) => new Date(ms).toISOString()

let taskSeq = 0
function task(overrides = {}) {
  taskSeq += 1
  return {
    _id: `task-${taskSeq}`,
    title: `Task ${taskSeq}`,
    clientName: 'Acme Exports',
    status: 'Pending',
    priority: 'Medium',
    deadline: iso(Date.now() + 5 * DAY_MS),
    createdAt: iso(Date.now() - 2 * DAY_MS),
    assignedTo: { _id: EMPLOYEE._id, name: EMPLOYEE.name },
    createdBy: { _id: 'u-admin', name: 'Asha Rao' },
    ...overrides,
  }
}

/**
 * Serve GET /tasks the way the real endpoint does: filtered by `status`,
 * paginated, with `pagination.total` counting the WHOLE filtered set — not
 * the returned page. Requests are recorded so tests can assert that the page
 * asked for counts (paginated mode) instead of a capped legacy array.
 */
function serveTasks({ pending = [], late = [], completed = [] }) {
  const all = [...pending, ...late, ...completed]
  const seen = []
  server.use(
    http.get(`${API}/tasks`, ({ request }) => {
      const params = Object.fromEntries(new URL(request.url).searchParams)
      seen.push(params)
      const rows =
        { Pending: pending, Late: late, Completed: completed }[params.status] ?? all
      const page = Number(params.page || 1)
      const limit = Number(params.limit || 25)
      return HttpResponse.json(
        listResponse(rows.slice((page - 1) * limit, page * limit), {
          page,
          limit,
          total: rows.length,
        })
      )
    })
  )
  return seen
}

/* Tile names are matched from the string start ("Overdue 42"), so the "My
 * overdue tasks" quick-action link can never satisfy the same query. */
describe('Dashboard tiles (Employee)', () => {
  it('counts "Completed — last 30 days" by completedAt, never createdAt', async () => {
    const now = Date.now()
    serveTasks({
      completed: [
        // Created BEFORE the window, finished inside it — the rows the old
        // createdAt filter dropped. Both must count.
        task({ status: 'Completed', createdAt: iso(now - 40 * DAY_MS), completedAt: iso(now - 2 * DAY_MS) }),
        task({ status: 'Completed', createdAt: iso(now - 35 * DAY_MS), completedAt: iso(now - 10 * DAY_MS) }),
        // Created INSIDE the window with no completion date: the old code
        // counted it; the fix must not (unknown completion time is not
        // "completed in the last 30 days").
        task({ status: 'Completed', createdAt: iso(now - 5 * DAY_MS), completedAt: null }),
        // Finished before the window. Must not count.
        task({ status: 'Completed', createdAt: iso(now - 60 * DAY_MS), completedAt: iso(now - 45 * DAY_MS) }),
      ],
    })
    seedSession({ user: EMPLOYEE })
    renderWithProviders(<Dashboard />, { route: '/dashboard' })

    const tile = await screen.findByRole('link', { name: /^completed/i })
    // correct: 2 (by completedAt). The createdAt bug would say 1.
    expect(within(tile).getByText('2')).toBeInTheDocument()
    expect(within(tile).getByText(/last 30 days/i)).toBeInTheDocument()
  })

  it('renders an em dash — not a fake zero — when completed rows carry no completedAt field', async () => {
    const now = Date.now()
    // Rows WITHOUT the completedAt key at all: the server list projection does
    // not expose the field yet. There is no honest number to show.
    serveTasks({
      completed: [
        task({ status: 'Completed', createdAt: iso(now - 2 * DAY_MS) }),
        task({ status: 'Completed', createdAt: iso(now - 3 * DAY_MS) }),
      ],
    })
    seedSession({ user: EMPLOYEE })
    renderWithProviders(<Dashboard />, { route: '/dashboard' })

    const tile = await screen.findByRole('link', { name: /^completed/i })
    expect(within(tile).getByText('—')).toBeInTheDocument()
    expect(within(tile).getByText(/completion dates unavailable/i)).toBeInTheDocument()
  })

  it('reports true totals past the 200-row legacy cap, from pagination.total', async () => {
    const ts = todayStart()
    const pending = [
      // 2 pending past their deadline (cron has not flipped them yet) …
      task({ deadline: iso(ts - 2 * DAY_MS) }),
      task({ deadline: iso(ts - 1 * DAY_MS + 60_000) }),
      // … 3 due today …
      task({ deadline: iso(ts + 10 * 3_600_000) }),
      task({ deadline: iso(ts + 12 * 3_600_000) }),
      task({ deadline: iso(ts + 14 * 3_600_000) }),
      // … and 175 due later, so Pending alone exceeds one 100-row page.
      ...Array.from({ length: 175 }, (_, i) => task({ deadline: iso(ts + (3 + i) * DAY_MS) })),
    ]
    const late = Array.from({ length: 40 }, () =>
      task({ status: 'Late', deadline: iso(ts - 5 * DAY_MS) })
    )
    // 250 completed rows force a multi-page walk; 30 are inside the window.
    const now = Date.now()
    const completed = [
      ...Array.from({ length: 30 }, () =>
        task({ status: 'Completed', completedAt: iso(now - 5 * DAY_MS) })
      ),
      ...Array.from({ length: 220 }, () =>
        task({ status: 'Completed', completedAt: iso(now - 60 * DAY_MS) })
      ),
    ]
    const seen = serveTasks({ pending, late, completed })
    seedSession({ user: EMPLOYEE })
    renderWithProviders(<Dashboard />, { route: '/dashboard' })

    // 470 tasks total — far past the cap the old single fetch died on.
    const open = await screen.findByRole('link', { name: /^open tasks/i })
    expect(within(open).getByText('220')).toBeInTheDocument() // 180 Pending + 40 Late

    const overdue = screen.getByRole('link', { name: /^overdue/i })
    expect(within(overdue).getByText('42')).toBeInTheDocument() // 40 Late + 2 Pending past due

    const dueToday = screen.getByRole('link', { name: /^due today/i })
    expect(within(dueToday).getByText('3')).toBeInTheDocument()

    const completedTile = screen.getByRole('link', { name: /^completed/i })
    expect(within(completedTile).getByText('30')).toBeInTheDocument()

    // The attention footer is count-derived, not rows.length-derived.
    expect(await screen.findByText(/showing 8 of 45/i)).toBeInTheDocument()

    // Regression guard for the cap itself: every request was paginated (page
    // present), so no response could silently truncate at the legacy cap.
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((q) => q.page)).toBe(true)
  })
})
