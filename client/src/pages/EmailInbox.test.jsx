/**
 * EmailInbox — the list contract, the URL as state, and search racing.
 *
 * The race is the interesting one. The old inbox fired a request per keystroke
 * with no cancellation, so the rendered result was whichever response arrived
 * LAST — type fast enough and you were looking at results for a prefix of what
 * you typed. The page now debounces into the query string and aborts the
 * superseded request, which makes it last-QUERY-wins.
 *
 * These assertions go through roles, labels and the URL, never class names, so
 * the page can keep being refactored onto the new primitives underneath them.
 */
import { screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { API, listResponse } from '../test/handlers'
import { server } from '../test/server'
import { renderWithProviders, seedSession } from '../test/utils'

import EmailInbox from './EmailInbox'

const EMAILS = [
  {
    _id: 'e1',
    subject: 'GST filing for Q3',
    from: 'accounts@acme.test',
    accountEmail: 'office@example.com',
    status: 'unassigned',
    date: new Date('2026-07-30T09:00:00Z').toISOString(),
  },
  {
    _id: 'e2',
    subject: 'Invoice 4471 attached',
    from: 'billing@meridian.test',
    accountEmail: 'office@example.com',
    status: 'assigned',
    date: new Date('2026-07-29T09:00:00Z').toISOString(),
  },
]

/** Renders the current query string so URL syncing is assertable. */
function LocationProbe() {
  const { search } = useLocation()
  return <output data-testid="query-string">{search}</output>
}

const queryString = () => screen.getByTestId('query-string').textContent

const renderInbox = (route = '/inbox') =>
  renderWithProviders(
    <>
      <EmailInbox />
      <LocationProbe />
    </>,
    { route }
  )

/** Record every /gmail/emails request the page makes. */
function recordListRequests(respond = () => HttpResponse.json(listResponse(EMAILS, { total: 2 }))) {
  const seen = []
  server.use(
    http.get(`${API}/gmail/emails`, (info) => {
      seen.push(Object.fromEntries(new URL(info.request.url).searchParams))
      return respond(info)
    })
  )
  return seen
}

beforeEach(() => {
  seedSession()
})

describe('EmailInbox — list rendering', () => {
  it('renders rows from the { data, pagination } envelope', async () => {
    recordListRequests()
    renderInbox()

    expect(await screen.findByText(/GST filing for Q3/)).toBeInTheDocument()
    expect(screen.getByText(/Invoice 4471 attached/)).toBeInTheDocument()

    const table = screen.getByRole('table')
    // Header row plus one row per email.
    expect(within(table).getAllByRole('row')).toHaveLength(EMAILS.length + 1)
  })

  it('reports the server total in the pager, not the row count', async () => {
    server.use(
      http.get(`${API}/gmail/emails`, () =>
        HttpResponse.json(listResponse(EMAILS, { total: 1284, limit: 25 }))
      )
    )
    renderInbox()

    expect(await screen.findByText(/Showing 1–25 of 1,284 emails/)).toBeInTheDocument()
  })

  it('asks for the documented page/limit params on first load', async () => {
    const seen = recordListRequests()
    renderInbox()
    await screen.findByText(/GST filing for Q3/)

    expect(seen[0]).toMatchObject({ page: '1' })
    expect(Number(seen[0].limit)).toBeGreaterThan(0)
  })

  it('surfaces a failed load without blanking the screen', async () => {
    server.use(
      http.get(`${API}/gmail/emails`, () =>
        HttpResponse.json({ message: 'Mailbox unavailable.' }, { status: 500 })
      )
    )
    renderInbox()

    expect(await screen.findByText('Mailbox unavailable.')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})

describe('EmailInbox — filters are URL state', () => {
  it('writes a status filter into the query string', async () => {
    recordListRequests()
    const { user } = renderInbox()
    await screen.findByText(/GST filing for Q3/)

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'assigned')

    await waitFor(() => expect(queryString()).toContain('status=assigned'))
  })

  it('sends the filter to the server', async () => {
    const seen = recordListRequests()
    const { user } = renderInbox()
    await screen.findByText(/GST filing for Q3/)

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'assigned')

    await waitFor(() => expect(seen.at(-1)).toMatchObject({ status: 'assigned' }))
  })

  it('resets to page 1 when a filter changes', async () => {
    server.use(
      http.get(`${API}/gmail/emails`, () => HttpResponse.json(listResponse(EMAILS, { total: 200 })))
    )
    const { user } = renderInbox('/inbox?page=3')
    await screen.findByText(/GST filing for Q3/)
    expect(queryString()).toContain('page=3')

    await user.selectOptions(screen.getByLabelText('Filter by status'), 'assigned')

    await waitFor(() => expect(queryString()).not.toContain('page=3'))
  })

  it('restores the view from the URL on load — the inbox is shareable', async () => {
    const seen = recordListRequests()
    renderInbox('/inbox?status=assigned&tab=sent&page=2')
    await screen.findByText(/GST filing for Q3/)

    expect(seen[0]).toMatchObject({ status: 'assigned', page: '2' })
    expect(screen.getByLabelText('Filter by status')).toHaveValue('assigned')
  })

  it('"Clear filters" empties the query string', async () => {
    recordListRequests()
    const { user } = renderInbox('/inbox?status=assigned')
    await screen.findByText(/GST filing for Q3/)

    await user.click(await screen.findByRole('button', { name: /clear filters/i }))

    await waitFor(() => expect(queryString()).not.toContain('status='))
  })
})

describe('EmailInbox — search is debounced and abortable', () => {
  it('collapses a burst of keystrokes into one request', async () => {
    const seen = recordListRequests()
    const { user } = renderInbox()
    await screen.findByText(/GST filing for Q3/)
    const before = seen.length

    await user.type(screen.getByLabelText(/search emails/i), 'GST')

    await waitFor(() => expect(queryString()).toContain('q=GST'), { timeout: 2000 })
    await new Promise((resolve) => setTimeout(resolve, 250))

    const searches = seen.slice(before).filter((p) => p.q !== undefined)
    expect(searches).toHaveLength(1)
    expect(searches[0].q).toBe('GST')
  })

  it('is last-QUERY-wins: a slow earlier search cannot overwrite a later one', async () => {
    server.use(
      http.get(`${API}/gmail/emails`, async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') || ''
        if (q === 'a') {
          // The stale request resolves well after its successor.
          await new Promise((resolve) => setTimeout(resolve, 600))
          return HttpResponse.json(
            listResponse([{ ...EMAILS[0], _id: 'stale', subject: 'STALE RESULT' }], { total: 1 })
          )
        }
        if (q === 'ab') {
          return HttpResponse.json(
            listResponse([{ ...EMAILS[0], _id: 'fresh', subject: 'FRESH RESULT' }], { total: 1 })
          )
        }
        return HttpResponse.json(listResponse(EMAILS, { total: 2 }))
      })
    )

    const { user } = renderInbox()
    const box = await screen.findByLabelText(/search emails/i)

    await user.type(box, 'a')
    // Let the debounce fire so the slow request is genuinely in flight.
    await new Promise((resolve) => setTimeout(resolve, 450))

    await user.type(box, 'b')
    expect(await screen.findByText(/FRESH RESULT/, {}, { timeout: 3000 })).toBeInTheDocument()

    // Now outlive the stale response and prove it never lands.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(screen.queryByText(/STALE RESULT/)).toBeNull()
    expect(screen.getByText(/FRESH RESULT/)).toBeInTheDocument()
  })
})
