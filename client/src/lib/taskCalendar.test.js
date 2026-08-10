/**
 * `lib/taskCalendar` — the month window the Tasks calendar renders.
 *
 * The defect this covers was silent: the calendar issued ONE
 * `GET /tasks?page=1&limit=100&sort=-createdAt` for its entire lifetime and
 * bucketed whatever came back by deadline, so July 2026 rendered as an empty
 * grid while the database held 104 tasks due that month. No error, no empty
 * state that said "we did not look" — just a month with no work in it.
 *
 * So these assert the two things a rendering test cannot see: WHICH window was
 * asked for, and that rows outside it never reach the grid.
 */
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import { API, listResponse } from '../test/handlers'
import { server } from '../test/server'

import {
  MAX_CALENDAR_PAGES,
  fetchCalendarTasks,
  fetchStatusTotals,
  monthGridRange,
} from './taskCalendar'

const DAY_MS = 86_400_000

/** A task due `iso`. */
const task = (id, iso) => ({ _id: id, title: id, status: 'Pending', deadline: iso })

/**
 * Serve `rows` in deadline order, paged, IGNORING the date range — which is
 * exactly what `getAllTasks` does today. The walk has to be correct anyway.
 */
function serveDeadlineOrdered(rows, { limit = 100 } = {}) {
  const seen = []
  const sorted = [...rows].sort(
    (a, b) => new Date(a.deadline || 0) - new Date(b.deadline || 0)
  )
  server.use(
    http.get(`${API}/tasks`, ({ request }) => {
      const params = Object.fromEntries(new URL(request.url).searchParams)
      seen.push(params)
      const page = Number(params.page) || 1
      const slice = sorted.slice((page - 1) * limit, page * limit)
      return HttpResponse.json({
        data: slice,
        pagination: {
          page,
          limit,
          total: sorted.length,
          totalPages: Math.max(1, Math.ceil(sorted.length / limit)),
          hasMore: page * limit < sorted.length,
        },
      })
    })
  )
  return seen
}

describe('monthGridRange', () => {
  it('covers the 42 cells the grid draws, starting on the Sunday on or before the 1st', () => {
    const { from, to } = monthGridRange(new Date(2026, 6, 1)) // July 2026

    expect(from.getDay()).toBe(0)
    expect(from <= new Date(2026, 6, 1)).toBe(true)
    expect(new Date(2026, 6, 1) - from).toBeLessThan(7 * DAY_MS)
    expect(Math.round((to - from) / DAY_MS)).toBe(42)
    expect(from.getHours()).toBe(0)
  })

  it('a month whose 1st IS a Sunday starts on that day, not a week early', () => {
    const { from } = monthGridRange(new Date(2026, 2, 1)) // 1 Mar 2026 is a Sunday
    expect(from.getDate()).toBe(1)
    expect(from.getMonth()).toBe(2)
  })
})

describe('fetchCalendarTasks', () => {
  it('asks for the visible month in deadline order, not the newest by creation date', async () => {
    const seen = serveDeadlineOrdered([])
    const anchor = new Date(2026, 6, 1)

    await fetchCalendarTasks({ anchor })

    const { from, to } = monthGridRange(anchor)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      sort: 'deadline',
      limit: '100',
      page: '1',
      deadlineFrom: from.toISOString(),
      deadlineTo: to.toISOString(),
    })
  })

  it('returns only tasks inside the window even when the server ignores the range', async () => {
    const anchor = new Date(2026, 6, 1)
    const { from, to } = monthGridRange(anchor)
    const before = new Date(from.getTime() - DAY_MS).toISOString()
    const inside = new Date(from.getTime() + 10 * DAY_MS).toISOString()
    const after = new Date(to.getTime() + DAY_MS).toISOString()

    serveDeadlineOrdered([
      task('before', before),
      task('inside-1', inside),
      task('inside-2', new Date(from.getTime() + 20 * DAY_MS).toISOString()),
      task('after', after),
      { _id: 'no-deadline', title: 'no-deadline', deadline: null },
    ])

    const { rows, truncated } = await fetchCalendarTasks({ anchor })

    expect(rows.map((r) => r._id)).toEqual(['inside-1', 'inside-2'])
    expect(truncated).toBe(false)
  })

  it('walks past the earlier pages and stops at the first row beyond the window', async () => {
    /* 250 tasks one day apart, starting 150 days before the window. In
     * deadline order the window is rows 150-191, so it closes on page 2 — and
     * the walk must stop there rather than paging on through the remaining
     * 58 rows just because `hasMore` is still true. */
    const anchor = new Date(2026, 6, 1)
    const { from } = monthGridRange(anchor)
    const start = from.getTime() - 150 * DAY_MS
    const rows = Array.from({ length: 250 }, (_, i) =>
      task(`t${i}`, new Date(start + i * DAY_MS).toISOString())
    )
    const seen = serveDeadlineOrdered(rows)

    const { rows: got, truncated } = await fetchCalendarTasks({ anchor })

    expect(seen.map((s) => s.page)).toEqual(['1', '2'])
    expect(truncated).toBe(false)
    expect(got).toHaveLength(42)
    expect(got.every((r) => new Date(r.deadline) >= from)).toBe(true)
  })

  it('passes the toolbar filters through so the calendar shows the same scope as the list', async () => {
    const seen = serveDeadlineOrdered([])

    await fetchCalendarTasks({
      anchor: new Date(2026, 6, 1),
      filters: { status: 'Pending', assignedTo: 'u2', q: 'gst' },
    })

    expect(seen[0]).toMatchObject({ status: 'Pending', assignedTo: 'u2', q: 'gst' })
  })

  it('reports itself partial rather than silently showing half a month', async () => {
    /* A server that never runs out of rows: the walk must stop at its own
     * ceiling and SAY so, not return a plausible-looking short month. */
    let pages = 0
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        pages += 1
        const page = Number(new URL(request.url).searchParams.get('page')) || 1
        return HttpResponse.json({
          data: [task(`p${page}`, new Date(2000, 0, 1).toISOString())],
          pagination: { page, limit: 100, total: 1e6, totalPages: 1e4, hasMore: true },
        })
      })
    )

    const { rows, truncated } = await fetchCalendarTasks({ anchor: new Date(2026, 6, 1) })

    expect(pages).toBe(MAX_CALENDAR_PAGES)
    expect(truncated).toBe(true)
    expect(rows).toEqual([])
  })
})

describe('fetchStatusTotals', () => {
  it('reads a real countDocuments per column, not the size of the loaded page', async () => {
    const totals = { Pending: 77, Completed: 224, Late: 126 }
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')
        return HttpResponse.json(listResponse([], { total: totals[status] }))
      })
    )

    await expect(
      fetchStatusTotals({ statuses: ['Pending', 'Completed', 'Late'] })
    ).resolves.toEqual(totals)
  })

  it('does not overwrite an active status filter to answer a question nobody asked', async () => {
    const seen = []
    server.use(
      http.get(`${API}/tasks`, ({ request }) => {
        seen.push(new URL(request.url).searchParams.get('status'))
        return HttpResponse.json(listResponse([], { total: 77 }))
      })
    )

    const totals = await fetchStatusTotals({
      statuses: ['Pending', 'Completed', 'Late'],
      filters: { status: 'Pending' },
    })

    expect(seen).toEqual(['Pending'])
    expect(totals).toEqual({ Pending: 77, Completed: 0, Late: 0 })
  })
})
