/**
 * The notification centre as it is actually rendered.
 *
 * `lib/notifications.test.js` covers the rules; this covers the wiring — that
 * the badge reads the authoritative count rather than counting visible rows,
 * that a role never sees a type it cannot act on, that mark-read is optimistic
 * and settles, and that every one of the four real states (loading, empty,
 * error, load-more) is reachable.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { API, TEST_USER, listResponse } from '../test/handlers'
import { server } from '../test/server'
import { renderWithProviders, seedSession } from '../test/utils'

import NotificationBell from './NotificationBell'

const EMPLOYEE = {
  _id: 'u-employee',
  name: 'Ravi Kumar',
  email: 'ravi@example.com',
  role: 'Employee',
  status: 'Approved',
}

/* Offsets are deliberately MINUTES, not hours.
 *
 * The component groups rows by local calendar day. With the original "2 hours
 * ago" fixture, any run between midnight and 02:00 local put that row in
 * YESTERDAY — correct behaviour, wrong assumption — and the Today group lost a
 * member. It passed in CI only because CI runs in UTC and never happened to
 * run inside that window; a 01:00 UTC run would have failed for nobody's
 * fault. Reproduced locally at 01:54 IST.
 *
 * Minutes shrink that window from two hours a day to two minutes, and no
 * assertion in this file depends on the rows reading as "hours ago".
 *
 * Freezing the clock would be stricter, but the component calls
 * groupNotifications() without the `now` argument that function documents as
 * "injectable so the tests are not clock-flaky" — so there is no seam to
 * inject through from out here, and fake timers stall MSW. */
const now = Date.now()
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString()
const hoursAgo = (h) => new Date(now - h * 3_600_000).toISOString()

const ROWS = [
  {
    _id: 'n1',
    type: 'task_assigned',
    message: 'New task assigned: Q3 GST filing',
    taskId: 't1',
    read: false,
    createdAt: minutesAgo(1),
  },
  {
    _id: 'n2',
    type: 'email_approval',
    message: 'Mail awaiting your approval',
    taskId: null,
    read: false,
    createdAt: minutesAgo(2),
  },
  {
    _id: 'n3',
    type: 'task_comment',
    message: 'New comment on task "Renew licence"',
    taskId: 't2',
    read: true,
    createdAt: hoursAgo(50),
  },
]

function LocationProbe() {
  const { pathname, search } = useLocation()
  return <output data-testid="route">{`${pathname}${search}`}</output>
}

function mockBell({ rows = ROWS, count, total } = {}) {
  const unread = count ?? rows.filter((r) => !r.read).length
  server.use(
    http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ count: unread })),
    http.get(`${API}/notifications`, ({ request }) => {
      const page = Number(new URL(request.url).searchParams.get('page')) || 1
      return HttpResponse.json(
        listResponse(page === 1 ? rows : [], { page, limit: 30, total: total ?? rows.length })
      )
    })
  )
}

const renderBell = () =>
  renderWithProviders(
    <>
      <NotificationBell />
      <LocationProbe />
    </>
  )

/** Open the popover and return its content element. */
async function openBell(user) {
  await user.click(screen.getByRole('button', { name: /^Notifications/ }))
  return screen.findByRole('heading', { name: 'Notifications' })
}

beforeEach(() => {
  seedSession()
})

describe('the badge', () => {
  it('reads the authoritative unread count, not the number of rows on screen', async () => {
    // 137 unread server-side; only three rows fit on the first page.
    mockBell({ count: 137, total: 400 })
    renderBell()

    expect(
      await screen.findByRole('button', { name: 'Notifications, 137 unread' })
    ).toBeInTheDocument()
  })

  it('announces the count politely, without moving focus', async () => {
    mockBell({ count: 4 })
    renderBell()

    const live = await screen.findByText('4 unread notifications')
    expect(live).toHaveAttribute('aria-live', 'polite')
    expect(document.activeElement).toBe(document.body)
  })

  it('says so explicitly when there is nothing unread, and renders no chip', async () => {
    mockBell({ rows: [], count: 0 })
    renderBell()

    expect(
      await screen.findByRole('button', { name: 'Notifications, none unread' })
    ).toBeInTheDocument()
  })
})

describe('grouping and per-type treatment', () => {
  it('splits the list into day groups instead of one flat run of rows', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByRole('region', { name: 'Today' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Earlier' })).toBeInTheDocument()
  })

  it('labels every row with its type in words, so the icon is never the only cue', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    const today = await screen.findByRole('region', { name: 'Today' })
    expect(within(today).getByText('Task assigned')).toBeInTheDocument()
    expect(within(today).getByText('Approval')).toBeInTheDocument()
  })

  it('marks unread rows in the accessible name, not by colour alone', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    expect(
      await screen.findByRole('button', {
        name: 'Task assigned: New task assigned: Q3 GST filing (unread)',
      })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Comment: New comment on task "Renew licence"' })
    ).toBeInTheDocument()
  })
})

describe('role-appropriate content', () => {
  it('hides the approval type from an Employee and keeps the rest', async () => {
    window.localStorage.clear()
    seedSession({ user: EMPLOYEE })
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByText('New task assigned: Q3 GST filing')).toBeInTheDocument()
    expect(screen.queryByText('Mail awaiting your approval')).not.toBeInTheDocument()
  })

  it('shows the approval type to an Admin', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)
    expect(await screen.findByText('Mail awaiting your approval')).toBeInTheDocument()
  })
})

describe('deep links', () => {
  it('opens the task drawer for a task notification', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    await user.click(
      await screen.findByRole('button', {
        name: 'Task assigned: New task assigned: Q3 GST filing (unread)',
      })
    )

    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/tasks?expandTaskId=t1')
    )
  })

  it('opens the approval queue for an approval notification', async () => {
    mockBell()
    const { user } = renderBell()
    await openBell(user)

    await user.click(
      await screen.findByRole('button', { name: 'Approval: Mail awaiting your approval (unread)' })
    )

    await waitFor(() =>
      expect(screen.getByTestId('route')).toHaveTextContent('/inbox?approval=pending')
    )
  })
})

describe('unread state', () => {
  it('marks one read optimistically and drops the badge by one', async () => {
    mockBell({ count: 2 })
    let marked = null
    server.use(
      http.put(`${API}/notifications/:id/read`, ({ params }) => {
        marked = params.id
        return HttpResponse.json({ success: true })
      })
    )

    const { user } = renderBell()
    await screen.findByRole('button', { name: 'Notifications, 2 unread' })
    await openBell(user)

    await user.click(
      await screen.findByRole('button', {
        name: 'Approval: Mail awaiting your approval (unread)',
      })
    )

    expect(marked).toBe('n2')
    // The count is server-authoritative minus the optimistic mark; the refetch
    // the mutation triggers settles it to the same number.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Notifications, 1 unread/ })).toBeInTheDocument()
    )
  })

  it('marks all read and zeroes the badge without double-counting', async () => {
    mockBell({ count: 2 })
    let calls = 0
    server.use(
      http.put(`${API}/notifications/read-all`, () => {
        calls += 1
        return HttpResponse.json({ success: true })
      })
    )

    const { user } = renderBell()
    await screen.findByRole('button', { name: 'Notifications, 2 unread' })
    await openBell(user)

    await user.click(screen.getByRole('button', { name: 'Mark all read' }))

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications, none unread' })).toBeInTheDocument()
    )
    expect(calls).toBe(1)
    // The action disappears once there is nothing left to mark.
    expect(screen.queryByRole('button', { name: 'Mark all read' })).not.toBeInTheDocument()
  })
})

describe('real states', () => {
  it('renders a caught-up empty state, not a bare "no notifications"', async () => {
    mockBell({ rows: [], count: 0 })
    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument()
  })

  it('surfaces a failed load with a working retry', async () => {
    server.use(
      http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ count: 0 })),
      http.get(`${API}/notifications`, () =>
        HttpResponse.json({ message: 'Notifications unavailable.' }, { status: 500 })
      )
    )

    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByText('Notifications unavailable.')).toBeInTheDocument()

    // Retry succeeds this time.
    server.use(
      http.get(`${API}/notifications`, () => HttpResponse.json(listResponse(ROWS, { total: 3 })))
    )
    await user.click(screen.getByRole('button', { name: /Try again/ }))

    expect(await screen.findByText('New task assigned: Q3 GST filing')).toBeInTheDocument()
  })

  it('offers load-more only while the server says there are older rows', async () => {
    mockBell({ total: 45 })
    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByRole('button', { name: /Load older \(42 more\)/ })).toBeInTheDocument()
  })

  it('hides load-more once everything is on screen', async () => {
    mockBell({ total: 3 })
    const { user } = renderBell()
    await openBell(user)

    await screen.findByText('New task assigned: Q3 GST filing')
    expect(screen.queryByRole('button', { name: /Load older/ })).not.toBeInTheDocument()
  })

  it('asks the server for the documented page and limit', async () => {
    const seen = []
    server.use(
      http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ count: 0 })),
      http.get(`${API}/notifications`, ({ request }) => {
        seen.push(Object.fromEntries(new URL(request.url).searchParams))
        return HttpResponse.json(listResponse([], { total: 0 }))
      })
    )

    renderBell()

    await waitFor(() => expect(seen).toHaveLength(1))
    expect(seen[0]).toMatchObject({ page: '1', limit: '30' })
  })
})

describe('untyped rows', () => {
  it('renders a row the server sent with no type, rather than dropping it', async () => {
    // server/utils/cronJobs.js writes the assignee's own overdue row with no
    // `type` field at all.
    mockBell({
      rows: [
        {
          _id: 'n9',
          message: 'Your task is overdue: Q3 GST filing',
          taskId: 't1',
          read: false,
          createdAt: minutesAgo(1),
        },
      ],
      count: 1,
    })
    const { user } = renderBell()
    await openBell(user)

    expect(await screen.findByText('Your task is overdue: Q3 GST filing')).toBeInTheDocument()
    expect(screen.getByText('Update')).toBeInTheDocument()
  })
})

describe('signed out', () => {
  it('asks for nothing when there is no session', async () => {
    window.localStorage.clear()
    const seen = []
    server.use(
      http.get(`${API}/notifications`, () => {
        seen.push(1)
        return HttpResponse.json(listResponse([]))
      })
    )

    renderWithProviders(<NotificationBell />)
    expect(TEST_USER).toBeTruthy()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Notifications, none unread' })).toBeInTheDocument()
    )
    expect(seen).toHaveLength(0)
  })
})
