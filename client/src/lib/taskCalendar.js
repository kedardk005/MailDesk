/**
 * Calendar month fetch for the Tasks screen.
 *
 * The calendar used to render whatever happened to be in the single
 * `GET /tasks?page=1&limit=100&sort=-createdAt` the page already made, and
 * changing month fired no request at all. So it showed the newest 100 tasks by
 * CREATION date, projected onto a grid keyed by DEADLINE — which is why July
 * 2026 rendered completely blank while the database held 104 tasks due that
 * month. Nothing errored; the user was simply told there was no work.
 *
 * This module asks for the visible grid instead:
 *
 *   - the window is the 42 cells actually on screen, not the calendar month,
 *     so the leading/trailing days of the neighbouring months are populated
 *     too;
 *   - rows come back in `deadline` order and the walk STOPS at the first row
 *     past the window, so the request count tracks the size of the window, not
 *     the size of the archive;
 *   - `deadlineFrom` / `deadlineTo` narrow it server-side. The walk still
 *     exists on top of them because `limit` is capped at 100 and a busy month
 *     holds more than that (July 2026 holds 104), and because it keeps the view
 *     correct against a server that ignores the range — which is what the whole
 *     defect was. Rows outside the window are dropped here regardless of what
 *     came back, so the grid can never render a task that is not in it.
 *
 * The same "walk a deadline-ordered list and stop early" shape is already used
 * by `lib/taskOverview.js` for the dashboard tiles.
 */
import api from '../api/axios'

/** The contract caps `limit` at 100 (server/utils/paginate.js). */
export const CALENDAR_PAGE_LIMIT = 100

/**
 * Hard ceiling on the walk. Only reachable when the server ignores the date
 * range AND the visible month sits far past the earliest deadline in the
 * scope; 20 pages is 2,000 rows scanned. Past it the view reports itself as
 * partial rather than quietly showing a half-empty month.
 */
export const MAX_CALENDAR_PAGES = 20

/**
 * The half-open [from, to) window covering the 42 cells `buildMonthGrid`
 * renders for `anchor` — six whole weeks starting on the Sunday on or before
 * the 1st.
 *
 * @param {Date} anchor - any date inside the month being displayed
 * @returns {{from: Date, to: Date}}
 */
export function monthGridRange(anchor) {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const lead = new Date(year, month, 1).getDay()
  const from = new Date(year, month, 1 - lead)
  from.setHours(0, 0, 0, 0)
  const to = new Date(from)
  to.setDate(to.getDate() + 42)
  return { from, to }
}

/** @returns {number} epoch ms, or NaN when the value is missing/unparseable. */
function deadlineMs(task) {
  if (!task?.deadline) return NaN
  return new Date(task.deadline).getTime()
}

/**
 * Every task whose deadline falls inside the visible grid.
 *
 * @param {object} args
 * @param {Date} args.anchor - the month on screen
 * @param {object} [args.filters] - the toolbar filters, already in server form
 *        (`status`, `priority`, `assignedTo`, `clientName`, `q`)
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<{rows: Array, from: Date, to: Date, truncated: boolean}>}
 *          `truncated` means the page cap was hit, so `rows` may be incomplete.
 */
export async function fetchCalendarTasks({ anchor, filters = {}, signal }) {
  const { from, to } = monthGridRange(anchor)
  const fromMs = from.getTime()
  const toMs = to.getTime()

  const base = {
    ...filters,
    limit: CALENDAR_PAGE_LIMIT,
    // Ascending, so "the last row is past the window" is a valid stop signal.
    sort: 'deadline',
    deadlineFrom: from.toISOString(),
    deadlineTo: to.toISOString(),
  }

  const rows = []
  let truncated = false

  for (let page = 1; page <= MAX_CALENDAR_PAGES; page += 1) {
    /* Sequential by design: each page decides whether the next one is needed
     * at all, which is the whole reason the walk is bounded. */
    const res = await api.get('/tasks', { params: { ...base, page }, signal })
    const body = res.data || {}
    const list = Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : []
    if (list.length === 0) return { rows, from, to, truncated }

    let pastWindow = false
    for (const task of list) {
      const at = deadlineMs(task)
      // Rows with no deadline sort first and belong on no day of the grid.
      if (!Number.isFinite(at)) continue
      if (at >= toMs) {
        pastWindow = true
        break
      }
      if (at >= fromMs) rows.push(task)
    }
    if (pastWindow) return { rows, from, to, truncated }

    const hasMore = body.pagination ? Boolean(body.pagination.hasMore) : false
    if (!hasMore) return { rows, from, to, truncated }

    if (page === MAX_CALENDAR_PAGES) truncated = true
  }

  return { rows, from, to, truncated }
}

/**
 * True per-status totals for the board columns.
 *
 * The board loads one page of 100 cards, but its column chips sit exactly where
 * every kanban board in existence puts a workspace total — so "Pending 14"
 * was read, and repeated, as the number of pending tasks in the office when it
 * was really the number of pending tasks inside the newest 100 rows. These are
 * `countDocuments` totals over the same filters: three requests for one row
 * each, which is the cheapest honest answer the list contract can give.
 *
 * @param {object} args
 * @param {string[]} args.statuses
 * @param {object} [args.filters]
 * @param {AbortSignal} [args.signal]
 * @returns {Promise<Record<string, number|null>>} null for a status whose count
 *          could not be read, so the caller can fall back to the loaded count.
 */
export async function fetchStatusTotals({ statuses, filters = {}, signal }) {
  const results = await Promise.all(
    statuses.map(async (status) => {
      // A status filter is already on: every other column is empty by
      // definition, and asking the server would OVERWRITE the user's filter
      // and answer a question nobody asked.
      if (filters.status && filters.status !== status) return [status, 0]
      const res = await api.get('/tasks', {
        params: { ...filters, status, page: 1, limit: 1 },
        signal,
      })
      const total = res.data?.pagination?.total
      return [status, Number.isFinite(total) ? total : null]
    })
  )
  return Object.fromEntries(results)
}
