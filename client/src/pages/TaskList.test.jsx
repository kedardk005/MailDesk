/**
 * TaskList — the page whose crash motivated this whole suite.
 *
 * `setSelectedTaskIds` / `setSelectAll` were referenced but never defined. The
 * page rendered fine and blew up on the first filter click, with no error
 * boundary to catch it, so the screen simply went white. Two things follow:
 *
 *   1. filter interaction is asserted here explicitly, not only in the route
 *      smoke test, and
 *   2. the bulk path — the feature those two identifiers belonged to — is
 *      driven end to end down to the POST /api/tasks/bulk body.
 *
 * Everything is queried by role and accessible name so the page can keep being
 * refactored onto the shared primitives.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { API, TEST_USER, listResponse } from '../test/handlers'
import { server } from '../test/server'
import { captureConsoleErrors, renderWithProviders, seedSession } from '../test/utils'

import TaskList from './TaskList'

const TASKS = [
  {
    _id: 't1',
    title: 'Q3 GST filing',
    clientName: 'Acme Exports',
    status: 'Pending',
    priority: 'High',
    deadline: new Date('2026-08-20T00:00:00Z').toISOString(),
    assignedTo: { _id: 'u2', name: 'Ravi Kumar' },
    createdBy: { _id: TEST_USER._id, name: TEST_USER.name },
  },
  {
    _id: 't2',
    title: 'Renew trade licence',
    clientName: 'Meridian Foods',
    status: 'In Progress',
    priority: 'Medium',
    deadline: new Date('2026-09-01T00:00:00Z').toISOString(),
    assignedTo: { _id: 'u3', name: 'Nina Shah' },
    createdBy: { _id: TEST_USER._id, name: TEST_USER.name },
  },
]

function LocationProbe() {
  const { search } = useLocation()
  return <output data-testid="query-string">{search}</output>
}

const queryString = () => screen.getByTestId('query-string').textContent

const renderTasks = (route = '/tasks') =>
  renderWithProviders(
    <>
      <TaskList />
      <LocationProbe />
    </>,
    { route }
  )

function recordTaskRequests(rows = TASKS, total = rows.length) {
  const seen = []
  server.use(
    http.get(`${API}/tasks`, ({ request }) => {
      seen.push(Object.fromEntries(new URL(request.url).searchParams))
      return HttpResponse.json(listResponse(rows, { total }))
    })
  )
  return seen
}

beforeEach(() => {
  seedSession()
})

describe('TaskList — list rendering', () => {
  it('renders rows from the { data, pagination } envelope', async () => {
    recordTaskRequests()
    renderTasks()

    expect(await screen.findByText('Q3 GST filing')).toBeInTheDocument()
    expect(screen.getByText('Renew trade licence')).toBeInTheDocument()
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(TASKS.length + 1)
  })

  it('reports the server total in the pager', async () => {
    recordTaskRequests(TASKS, 137)
    renderTasks()

    expect(await screen.findByText(/of 137 tasks/)).toBeInTheDocument()
  })
})

describe('TaskList — filters do not crash the page', () => {
  it('changing the status filter neither throws nor logs', async () => {
    const console_ = captureConsoleErrors()
    recordTaskRequests()
    const { user, container } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'Completed')

    await waitFor(() => expect(queryString()).toContain('status=Completed'))
    expect(console_.messages()).toEqual([])
    expect(container.querySelector('[role="alert"] h2')).toBeNull()
  })

  it('changing the priority filter neither throws nor logs', async () => {
    const console_ = captureConsoleErrors()
    recordTaskRequests()
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.selectOptions(screen.getByLabelText('Filter by priority'), 'High')

    await waitFor(() => expect(queryString()).toContain('priority=High'))
    expect(console_.messages()).toEqual([])
  })

  it('switching to Board and Calendar and back neither throws nor logs', async () => {
    const console_ = captureConsoleErrors()
    recordTaskRequests()
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    for (const view of ['Board', 'Calendar', 'List']) {
      await user.click(screen.getByRole('radio', { name: view }))
      expect(console_.messages()).toEqual([])
    }

    expect(await screen.findByRole('table')).toBeInTheDocument()
  })

  it('sends the filter to the server and resets to page 1', async () => {
    const seen = recordTaskRequests(TASKS, 200)
    const { user } = renderTasks('/tasks?page=4')
    await screen.findByText('Q3 GST filing')

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'Completed')

    await waitFor(() => expect(seen.at(-1)).toMatchObject({ status: 'Completed' }))
    expect(Number(seen.at(-1).page)).toBe(1)
  })

  it('sorting a column asks the server for the new order rather than reordering locally', async () => {
    const seen = recordTaskRequests()
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')
    const before = seen.length

    /* Whatever the header is called, it is the button inside the column header
     * — asserted structurally so the hand-rolled sort header being replaced by
     * DataTable's own does not break this. */
    const sortable = screen
      .getAllByRole('columnheader')
      .map((h) => within(h).queryByRole('button'))
      .filter(Boolean)
    expect(sortable.length).toBeGreaterThan(0)
    await user.click(sortable.at(-1))

    await waitFor(() => expect(seen.length).toBeGreaterThan(before))
    expect(seen.at(-1).sort).toBeTruthy()
    await waitFor(() => expect(queryString()).toContain('sort='))
  })
})

describe('TaskList — bulk actions', () => {
  it('selecting rows reveals the bulk bar with a live count', async () => {
    recordTaskRequests()
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }))
    expect(await screen.findByText('1 selected')).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: 'Select row 2' }))
    expect(await screen.findByText('2 selected')).toBeInTheDocument()
  })

  it('posts the selected ids to /api/tasks/bulk', async () => {
    recordTaskRequests()
    let body = null
    server.use(
      http.post(`${API}/tasks/bulk`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ success: true, modified: 2 })
      })
    )

    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.click(screen.getByRole('checkbox', { name: 'Select all rows on this page' }))
    await screen.findByText('2 selected')

    await user.click(screen.getByRole('button', { name: /set status/i }))
    await user.click(await screen.findByRole('menuitem', { name: 'Completed' }))

    await waitFor(() => expect(body).not.toBeNull())
    expect(body.action).toBe('status')
    expect(body.value).toBe('Completed')
    expect([...body.taskIds].sort()).toEqual(['t1', 't2'])
  })

  it('"Clear selection" empties the selection and hides the bar', async () => {
    recordTaskRequests()
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }))
    await screen.findByText('1 selected')

    await user.click(screen.getByRole('button', { name: 'Clear selection' }))

    await waitFor(() => expect(screen.queryByText('1 selected')).toBeNull())
  })

  it('a selection cannot survive off screen — bulk only ever acts on visible rows', async () => {
    /* Select a task, then filter it away. The bulk bar must forget it, or a
     * "delete selected" would hit a row the user can no longer see. */
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')
        const rows = status === 'Completed' ? [TASKS[1]] : TASKS
        return HttpResponse.json(listResponse(rows, { total: rows.length }))
      })
    )
    const { user } = renderTasks()
    await screen.findByText('Q3 GST filing')

    await user.click(screen.getByRole('checkbox', { name: 'Select row 1' }))
    await screen.findByText('1 selected')

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'Completed')

    await waitFor(() => expect(screen.queryByText('Q3 GST filing')).toBeNull())
    expect(screen.queryByText('1 selected')).toBeNull()
  })
})
