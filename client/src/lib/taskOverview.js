/**
 * Authoritative dashboard task numbers.
 *
 * The dashboard used to `GET /tasks` once in legacy mode and derive every tile
 * by filtering the returned array in JS. That response is capped server-side
 * (`LIST_LEGACY_CAP`, 200 rows — server/utils/paginate.js), so every tile
 * silently under-reported for any user with more than 200 tasks: a plausible
 * number that was simply wrong, and got worse as volume grew.
 *
 * This module asks the server to count instead. Every request here is
 * paginated, so `pagination.total` is a `countDocuments()` over the exact
 * filter — correct at any volume. Rows are fetched only where a tile needs
 * data the server cannot filter on:
 *
 *   - deadline windows ("due today", "overdue while still Pending"): the
 *     Pending list is walked in deadline order and the walk stops at the first
 *     page that has moved past today, so the number of requests is bounded by
 *     the near-term workload, not the archive.
 *   - `completedAt` windows ("completed in the last 30 days"): the server has
 *     no completed-after filter, so all Completed rows are paged through. If
 *     that set is implausibly large (> MAX_COMPLETED_ROWS) the tile reports
 *     "not measured" (null) instead of a silently partial count. A server-side
 *     `completedAfter` filter on GET /tasks would remove this walk entirely.
 */
import api from '../api/axios'

export const DAY_MS = 86_400_000
const PAGE_LIMIT = 100

/* Beyond this many Completed rows the 30-day count is reported as null ("not
 * measured") rather than walking an unbounded archive. 2,000 rows ≈ 20
 * requests, far beyond any seeded or realistic near-term dataset. */
export const MAX_COMPLETED_ROWS = 2_000

/** Start of the local day containing `now`, in epoch ms. */
export function startOfDayMs(now = new Date()) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * 'overdue' | 'today' | 'upcoming' | 'none' — the buckets the dashboard acts
 * on. Same semantics the screen has always had: Late is overdue regardless of
 * deadline, Completed is never actionable, and a Pending task is overdue the
 * moment its deadline is before today.
 */
export function dueBucket(task, todayStart) {
  if (task.status === 'Completed') return 'none'
  if (task.status === 'Late') return 'overdue'
  if (!task.deadline) return 'none'
  const due = new Date(task.deadline).getTime()
  if (!Number.isFinite(due)) return 'none'
  if (due < todayStart) return 'overdue'
  if (due < todayStart + DAY_MS) return 'today'
  return 'upcoming'
}

/**
 * Count rows completed at or after `sinceMs`, by `completedAt` — never by
 * `createdAt`, which counted "created recently and happens to be complete"
 * (the exact defect this module replaces).
 *
 * Explicit decision for rows without a usable `completedAt`: they are NOT
 * counted, and if NO row in a non-empty set carries the field at all the
 * result is null ("not measured"). Falling back to `createdAt` would
 * reintroduce the original bug wearing a different hat.
 *
 * @param {Array<Object>} rows - ALL Completed rows for the scope
 * @param {Number} sinceMs - epoch ms window start
 * @returns {Number|null} count, or null when the data cannot answer
 */
export function countCompletedSince(rows, sinceMs) {
  if (rows.length === 0) return 0
  const anyField = rows.some(
    (r) => r && Object.prototype.hasOwnProperty.call(r, 'completedAt')
  )
  if (!anyField) return null
  let count = 0
  for (const r of rows) {
    if (!r?.completedAt) continue
    const at = new Date(r.completedAt).getTime()
    if (Number.isFinite(at) && at >= sinceMs) count += 1
  }
  return count
}

/**
 * One paginated page of GET /tasks.
 * @returns {Promise<{rows: Array, total: Number, totalPages: Number}>}
 */
async function fetchTaskPage(params, signal) {
  const res = await api.get('/tasks', {
    params: { limit: PAGE_LIMIT, page: 1, ...params },
    signal,
  })
  const body = res.data || {}
  const rows = Array.isArray(body.data) ? body.data : []
  const pagination = body.pagination || {}
  return {
    rows,
    total: Number.isFinite(pagination.total) ? pagination.total : rows.length,
    totalPages: Number.isFinite(pagination.totalPages)
      ? Math.max(pagination.totalPages, 1)
      : 1,
  }
}

/**
 * Pending tasks in deadline order, walked only as far as "due before
 * tomorrow". `pagination.total` still reports ALL Pending rows for the scope.
 */
async function fetchPendingNearTerm(base, tomorrowStart, signal) {
  const params = { ...base, status: 'Pending', sort: 'deadline' }
  const first = await fetchTaskPage(params, signal)
  const rows = [...first.rows]

  const lastRowStillNear = () => {
    if (rows.length === 0) return false
    const last = rows[rows.length - 1]
    if (!last.deadline) return true // missing deadlines sort first
    const due = new Date(last.deadline).getTime()
    return !Number.isFinite(due) || due < tomorrowStart
  }

  // `totalPages` comes from the first response, so this loop is finite even if
  // a buggy server said hasMore forever.
  for (let page = 2; page <= first.totalPages && lastRowStillNear(); page += 1) {
    const next = await fetchTaskPage({ ...params, page }, signal)
    if (next.rows.length === 0) break
    rows.push(...next.rows)
  }

  return { rows, total: first.total }
}

/** Every Completed row for the scope, or null rows when the set is too large. */
async function fetchAllCompleted(base, signal) {
  const params = { ...base, status: 'Completed', sort: '-createdAt' }
  const first = await fetchTaskPage(params, signal)
  if (first.total > MAX_COMPLETED_ROWS) {
    return { rows: null, total: first.total }
  }
  const rest = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, i) =>
      fetchTaskPage({ ...params, page: i + 2 }, signal)
    )
  )
  return { rows: [first.rows, ...rest.map((p) => p.rows)].flat(), total: first.total }
}

/**
 * Fetch the complete tile + attention picture for one scope.
 *
 * @param {Object} [options]
 * @param {String} [options.assignedTo] - user id to scope to (Admin/Head
 *        "mine"). Employees omit it: the server already scopes their list.
 * @param {AbortSignal} [options.signal]
 * @param {Date} [options.now]
 * @returns {Promise<{
 *   counts: {open: Number, overdue: Number, dueToday: Number, completed: Number|null},
 *   attention: {rows: Array<{task: Object, bucket: String}>, total: Number}
 * }>}
 */
export async function fetchTaskOverview({ assignedTo, signal, now = new Date() } = {}) {
  const todayStart = startOfDayMs(now)
  const tomorrowStart = todayStart + DAY_MS
  const monthAgo = now.getTime() - 30 * DAY_MS

  const base = assignedTo ? { assignedTo } : {}

  const [late, pending, completed] = await Promise.all([
    // Late rows are all overdue by definition; deadline order puts the
    // longest-overdue first, which is also the attention list's order.
    fetchTaskPage({ ...base, status: 'Late', sort: 'deadline' }, signal),
    fetchPendingNearTerm(base, tomorrowStart, signal),
    fetchAllCompleted(base, signal),
  ])

  let pendingOverdue = 0
  let dueToday = 0
  for (const t of pending.rows) {
    const bucket = dueBucket(t, todayStart)
    if (bucket === 'overdue') pendingOverdue += 1
    else if (bucket === 'today') dueToday += 1
  }

  const counts = {
    // Open = everything not Completed. Both terms are server-side counts.
    open: pending.total + late.total,
    // Late is always overdue; a Pending task past its deadline is overdue too
    // (the cron usually flips it to Late within minutes, but the tile should
    // not depend on that). `pendingOverdue` is exact because the deadline walk
    // covered every row due before tomorrow.
    overdue: late.total + pendingOverdue,
    dueToday,
    completed: completed.rows === null ? null : countCompletedSince(completed.rows, monthAgo),
  }

  const attentionRows = [
    ...late.rows.map((task) => ({ task, bucket: 'overdue' })),
    ...pending.rows
      .map((task) => ({ task, bucket: dueBucket(task, todayStart) }))
      .filter((row) => row.bucket === 'overdue' || row.bucket === 'today'),
  ].sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket === 'overdue' ? -1 : 1
    return new Date(a.task.deadline || 0) - new Date(b.task.deadline || 0)
  })

  return {
    counts,
    attention: {
      rows: attentionRows,
      // Row arrays are page-bounded; the display total is count-derived so
      // "Showing 8 of N" stays right past the page size.
      total: counts.overdue + counts.dueToday,
    },
  }
}
