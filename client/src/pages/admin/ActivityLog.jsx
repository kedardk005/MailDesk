import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download, Filter, RefreshCw, ScrollText, Search, X } from 'lucide-react'
import api, { getErrorMessage, isCanceled } from '../../api/axios'
import { useAuth } from '../../components/AuthProvider'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  DataTable,
  Drawer,
  DrawerContent,
  Input,
  PageBody,
  PageHeader,
  Select,
  Toolbar,
  Tooltip,
  toast,
} from '../../components/ui'
import { formatNumber, timeAgo } from '../../lib/utils'

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

const DEFAULT_SORT = '-createdAt'
const DEFAULT_LIMIT = 25
const PAGE_SIZES = [25, 50, 100]
const EXPORT_CAP = 5000
const EXPORT_PAGE_SIZE = 100

/** Mirrors `ACTIVITY_SORT_FIELDS` in `server/controllers/userController.js`.
 *  Only these two columns get a sortable header. */
const SORT_FIELDS = ['createdAt', 'action']

/**
 * The action vocabulary written by server/utils/activityLogger.js call sites.
 * Kept as a fallback so the filter is complete even when the current page of
 * results happens not to contain a given action.
 */
const KNOWN_ACTIONS = [
  'Login',
  'User Registration',
  'User Creation',
  'User Update',
  'User Role Change',
  'User Status Change',
  'User Deletion',
  'Password Change',
  'Password Reset',
  'Password Reset Request',
  'Task Creation',
  'Task Update',
  'Task Deletion',
  'Task Comment',
  'Task Comment Delete',
  'Bulk Task Delete',
  'Bulk Task Status',
  'Bulk Task Reassign',
  'Client Creation',
  'Client Update',
  'Client Deletion',
  'Gmail Connection',
  'Gmail Disconnect',
  'Gmail Link Extra',
  'Gmail Unlink Account',
  'Gmail Delete All',
  'Gmail Delete Single',
  'Gmail Clean Blank Accounts',
  'Email Reply',
]

/**
 * `ActivityLog.targetType` enum, from `server/models/ActivityLog.js`. Indexed
 * server-side as `{targetType, targetId, createdAt}`, so both are real filters
 * rather than a client-side scan (WAVE2 gap S-2).
 */
const TARGET_TYPES = ['User', 'Task', 'Email', 'Client', 'KeywordRule', 'Notification', 'System']

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'medium',
})

/* ---------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

function formatAbsolute(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFormatter.format(d)
}

/**
 * `action` is a free-form string written by 30-odd call sites and is `required`
 * in the schema — but a legacy or partially-written row can still carry null,
 * which used to throw on `log.action.includes(...)` and white-screened the page.
 */
function actionText(log) {
  return typeof log?.action === 'string' ? log.action : ''
}

function actionVariant(log) {
  const action = actionText(log).toLowerCase()
  if (!action) return 'neutral'
  if (action.includes('delet') || action.includes('reject') || action.includes('unlink')) {
    return 'danger'
  }
  if (action.includes('creat') || action.includes('login') || action.includes('connect')) {
    return 'success'
  }
  if (action.includes('role') || action.includes('status') || action.includes('password')) {
    return 'warning'
  }
  if (action.includes('updat') || action.includes('reply') || action.includes('comment')) {
    return 'info'
  }
  return 'neutral'
}

/** Fields added by the security work; older rows simply do not have them. */
function logIp(log) {
  return log?.ip || log?.ipAddress || log?.meta?.ip || ''
}

/** The human half of the target: a label if one was recorded, else the raw id. */
function targetLabel(log) {
  const label = log?.targetLabel ?? log?.target ?? log?.targetEmail ?? log?.targetName
  if (label) return String(label)
  return log?.targetId ? String(log.targetId) : ''
}

/** Type + label, for CSV and for the free-text fallback filter. */
function logTarget(log) {
  const label = targetLabel(log)
  if (log?.targetType && label) return `${log.targetType} ${label}`
  if (log?.targetType) return String(log.targetType)
  return label
}

function logChange(log) {
  const before = log?.before ?? log?.changes?.before ?? log?.previous
  const after = log?.after ?? log?.changes?.after ?? log?.next
  if (before === undefined && after === undefined) return null
  if (before === null && after === null) return null
  return { before, after }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Render a stored before/after value as a single readable cell. */
function formatChangeValue(value) {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? '(empty list)' : value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === '') return '(empty)'
  return String(value)
}

/**
 * Field-by-field diff of the structured `before`/`after` snapshots S-2 added.
 *
 * Returns `null` when either side is not an object — a creation logs
 * `before: null`, a deletion logs `after: null`, and both are better shown as
 * the raw snapshot than as a table of "— → value" rows.
 *
 * @returns {{key:String, before:*, after:*, changed:Boolean}[]|null}
 */
function diffFields(before, after) {
  if (!isPlainObject(before) || !isPlainObject(after)) return null
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()
  if (keys.length === 0) return null
  return keys.map((key) => ({
    key,
    before: before[key],
    after: after[key],
    changed: JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null),
  }))
}

/** See docs/audits/API-LIST-CONTRACT.md — paginated and legacy shapes. */
function readList(payload) {
  if (Array.isArray(payload)) return { rows: payload, pagination: null }
  if (payload && Array.isArray(payload.data)) {
    return { rows: payload.data, pagination: payload.pagination || null }
  }
  return { rows: [], pagination: null }
}

function matchesFilters(log, { q, actor, action, targetType, targetId, from, to }) {
  if (actor && String(log?.userId?._id || log?.userId || '') !== actor) return false
  if (action && actionText(log) !== action) return false
  if (targetType && String(log?.targetType || '') !== targetType) return false
  if (targetId && String(log?.targetId || '') !== targetId) return false

  const created = log?.createdAt ? new Date(log.createdAt).getTime() : NaN
  if (from) {
    const start = new Date(`${from}T00:00:00`).getTime()
    if (Number.isFinite(start) && (!Number.isFinite(created) || created < start)) return false
  }
  if (to) {
    const end = new Date(`${to}T23:59:59.999`).getTime()
    if (Number.isFinite(end) && (!Number.isFinite(created) || created > end)) return false
  }

  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const haystack = [
    actionText(log),
    log?.details,
    log?.userId?.name,
    log?.userId?.email,
    logTarget(log),
    logIp(log),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

/** Fallback paging/sorting for the legacy (un-paginated) response shape. */
function applyLocalView(rows, filters) {
  const filtered = rows.filter((log) => matchesFilters(log, filters))
  const desc = filters.sort.startsWith('-')
  const field = desc ? filters.sort.slice(1) : filters.sort

  const sorted = [...filtered].sort((a, b) => {
    const cmp =
      field === 'createdAt'
        ? new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()
        : actionText(a).localeCompare(actionText(b), undefined, { sensitivity: 'base' })
    return desc ? -cmp : cmp
  })

  const start = (filters.page - 1) * filters.limit
  return { rows: sorted.slice(start, start + filters.limit), total: sorted.length }
}

/** Quotes a CSV cell and neutralises spreadsheet formula injection. */
function csvCell(value) {
  const raw = value === null || value === undefined ? '' : String(value)
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replace(/"/g, '""')}"`
}

function buildCsv(rows) {
  const header = [
    'Timestamp (ISO)',
    'Timestamp (local)',
    'Actor name',
    'Actor email',
    'Actor role',
    'Action',
    'Target type',
    'Target',
    'Target ID',
    'IP address',
    'User agent',
    'Details',
    'Before',
    'After',
  ]
  const body = rows.map((log) =>
    [
      log?.createdAt ? new Date(log.createdAt).toISOString() : '',
      formatAbsolute(log?.createdAt),
      log?.userId?.name || '',
      log?.userId?.email || '',
      log?.userId?.role || '',
      actionText(log),
      log?.targetType || '',
      targetLabel(log),
      log?.targetId || '',
      logIp(log),
      log?.userAgent || '',
      log?.details || '',
      log?.before === undefined || log?.before === null ? '' : JSON.stringify(log.before),
      log?.after === undefined || log?.after === null ? '' : JSON.stringify(log.after),
    ].map(csvCell)
  )
  return [header.map(csvCell).join(','), ...body.map((r) => r.join(','))].join('\r\n')
}

function downloadCsv(csv, filename) {
  // Leading BOM so Excel reads the file as UTF-8 rather than the system codepage.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

export default function ActivityLog() {
  const { user: currentUser } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  /* --- URL-owned view state ------------------------------------------- */
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const limitParam = Number(searchParams.get('limit')) || DEFAULT_LIMIT
  const limit = PAGE_SIZES.includes(limitParam) ? limitParam : DEFAULT_LIMIT
  const sortParam = searchParams.get('sort') || DEFAULT_SORT
  const sortField = sortParam.startsWith('-') ? sortParam.slice(1) : sortParam
  const sort = SORT_FIELDS.includes(sortField) ? sortParam : DEFAULT_SORT
  const qParam = searchParams.get('q') || ''
  const actorParam = searchParams.get('actor') || ''
  const actionParam = searchParams.get('action') || ''
  const targetTypeRaw = searchParams.get('targetType') || ''
  const targetTypeParam = TARGET_TYPES.includes(targetTypeRaw) ? targetTypeRaw : ''
  const targetIdRaw = searchParams.get('targetId') || ''
  const targetIdParam = OBJECT_ID_RE.test(targetIdRaw) ? targetIdRaw : ''
  const fromParam = searchParams.get('from') || ''
  const toParam = searchParams.get('to') || ''
  const hasFilters = Boolean(
    qParam || actorParam || actionParam || targetTypeParam || targetIdParam || fromParam || toParam
  )

  const setParams = useCallback(
    (patch, { replace = false } = {}) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          Object.entries(patch).forEach(([key, value]) => {
            if (value === null || value === undefined || value === '') next.delete(key)
            else next.set(key, String(value))
          })
          return next
        },
        { replace }
      )
    },
    [setSearchParams]
  )

  /* Real sortable headers, driven off `?sort=` so the view stays bookmarkable
   * and the server is the thing that actually orders the rows. */
  const sorting = useMemo(
    () => [{ id: sort.startsWith('-') ? sort.slice(1) : sort, desc: sort.startsWith('-') }],
    [sort]
  )

  const handleSortingChange = useCallback(
    (next) => {
      const [s] = next
      setParams({ sort: s ? `${s.desc ? '-' : ''}${s.id}` : null, page: 1 })
    },
    [setParams]
  )

  /* --- Data ------------------------------------------------------------ */
  const [reloadToken, setReloadToken] = useState(0)
  const [debouncedQ, setDebouncedQ] = useState(qParam)
  const [result, setResult] = useState({ key: null, rows: [], total: 0, error: null })
  const [actors, setActors] = useState([])
  const [selected, setSelected] = useState(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(qParam), 300)
    return () => clearTimeout(timer)
  }, [qParam])

  const filters = useMemo(
    () => ({
      page,
      limit,
      sort,
      q: debouncedQ,
      actor: actorParam,
      action: actionParam,
      targetType: targetTypeParam,
      targetId: targetIdParam,
      from: fromParam,
      to: toParam,
    }),
    [
      page,
      limit,
      sort,
      debouncedQ,
      actorParam,
      actionParam,
      targetTypeParam,
      targetIdParam,
      fromParam,
      toParam,
    ]
  )
  const filterKey = useMemo(
    () => `${reloadToken}:${JSON.stringify(filters)}`,
    [reloadToken, filters]
  )

  const buildParams = useCallback((f, overrides = {}) => {
    const params = { page: f.page, limit: f.limit, sort: f.sort, ...overrides }
    if (f.q) params.q = f.q
    // S-3 settled the actor filter: `userId` is canonical, `actor` is only a
    // back-compat alias. This used to send both because the name was open.
    if (f.actor) params.userId = f.actor
    if (f.action) params.action = f.action
    if (f.targetType) params.targetType = f.targetType
    if (f.targetId) params.targetId = f.targetId
    // The contract's date range is `dateFrom`/`dateTo`. Sending `from`/`to`
    // here matched nothing: on this endpoint the server only reads the
    // `dateFrom`/`dateTo` spelling, so the range filter did nothing at all.
    if (f.from) params.dateFrom = `${f.from}T00:00:00.000`
    if (f.to) params.dateTo = `${f.to}T23:59:59.999`
    return params
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/users/activity-logs', {
        params: buildParams(filters),
        signal: controller.signal,
      })
      .then((res) => {
        const { rows, pagination } = readList(res.data)
        if (pagination) {
          setResult({
            key: filterKey,
            rows,
            total: Number(pagination.total) || rows.length,
            error: null,
          })
        } else {
          const view = applyLocalView(rows, filters)
          setResult({ key: filterKey, rows: view.rows, total: view.total, error: null })
        }
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setResult({
          key: filterKey,
          rows: [],
          total: 0,
          error: getErrorMessage(err, 'Could not load the activity log.'),
        })
      })
    return () => controller.abort()
  }, [buildParams, filters, filterKey])

  // Actor filter options. The log itself only exposes the actors present on the
  // current page, so the workspace roster is fetched separately.
  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/users', { params: { page: 1, limit: 100, sort: 'name' }, signal: controller.signal })
      .then((res) => setActors(readList(res.data).rows))
      .catch((err) => {
        // Non-fatal: the filter falls back to actors seen in the loaded rows.
        if (!isCanceled(err)) setActors([])
      })
    return () => controller.abort()
  }, [])

  const loading = result.key !== filterKey
  const rows = result.rows
  const total = result.total
  const error = result.error

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  const actorOptions = useMemo(() => {
    const map = new Map()
    actors.forEach((u) => u?._id && map.set(u._id, { id: u._id, name: u.name, role: u.role }))
    rows.forEach((log) => {
      const u = log?.userId
      if (u?._id && !map.has(u._id)) map.set(u._id, { id: u._id, name: u.name, role: u.role })
    })
    const list = Array.from(map.values()).sort((a, b) =>
      String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' })
    )
    return [
      { value: '', label: 'All actors' },
      ...list.map((u) => ({
        value: u.id,
        label: u.role ? `${u.name || 'Unnamed'} (${u.role})` : u.name || 'Unnamed',
      })),
    ]
  }, [actors, rows])

  const actionOptions = useMemo(() => {
    const set = new Set(KNOWN_ACTIONS)
    rows.forEach((log) => {
      const a = actionText(log)
      if (a) set.add(a)
    })
    return [
      { value: '', label: 'All actions' },
      ...Array.from(set)
        .sort()
        .map((a) => ({ value: a, label: a })),
    ]
  }, [rows])

  const clearFilters = useCallback(() => {
    setParams({
      q: null,
      actor: null,
      action: null,
      targetType: null,
      targetId: null,
      from: null,
      to: null,
      page: 1,
    })
  }, [setParams])

  /** Drill from a row into every entry touching the same object. */
  const filterByTarget = useCallback(
    (log) => {
      if (!log?.targetType) return
      setParams({
        targetType: log.targetType,
        targetId: OBJECT_ID_RE.test(String(log.targetId || '')) ? String(log.targetId) : null,
        page: 1,
      })
    },
    [setParams]
  )

  /* --- CSV export ------------------------------------------------------ */

  const exportCsv = useCallback(async () => {
    setExporting(true)
    try {
      const collected = []
      let serverPaged = true
      let cursor = 1

      // Bounded: the log is the fastest-growing collection in the system, so an
      // "export everything" that walks unbounded pages is not offered.
      for (;;) {
        const res = await api.get('/users/activity-logs', {
          params: buildParams(filters, { page: cursor, limit: EXPORT_PAGE_SIZE }),
        })
        const { rows: batch, pagination } = readList(res.data)
        collected.push(...batch)
        if (!pagination) {
          serverPaged = false
          break
        }
        if (!pagination.hasMore || batch.length === 0) break
        if (collected.length >= EXPORT_CAP) break
        cursor += 1
      }

      const source = serverPaged
        ? collected
        : collected.filter((log) => matchesFilters(log, filters))
      const exported = source.slice(0, EXPORT_CAP)

      if (exported.length === 0) {
        toast.warning('Nothing to export for these filters.')
        return
      }

      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      downloadCsv(buildCsv(exported), `activity-log-${stamp}.csv`)
      toast.success(
        `Exported ${formatNumber(exported.length)} ${
          exported.length === 1 ? 'entry' : 'entries'
        }.`,
        exported.length >= EXPORT_CAP
          ? { description: `Capped at ${formatNumber(EXPORT_CAP)} rows. Narrow the date range for the rest.` }
          : undefined
      )
    } catch (err) {
      toast.error('Could not export the activity log', { description: getErrorMessage(err) })
    } finally {
      setExporting(false)
    }
  }, [buildParams, filters])

  /* --- Columns --------------------------------------------------------- */

  const columns = useMemo(
    () => [
      {
        accessorKey: 'createdAt',
        header: 'Time',
        meta: { width: '140px' },
        cell: ({ row }) => {
          const value = row.original?.createdAt
          const relative = value ? timeAgo(value) : '—'
          return (
            <Tooltip content={formatAbsolute(value)}>
              <span className="tabular text-fg-2">{relative || '—'}</span>
            </Tooltip>
          )
        },
      },
      {
        id: 'actor',
        header: 'Actor',
        enableSorting: false,
        meta: { primary: true, width: '210px' },
        cell: ({ row }) => {
          const actor = row.original?.userId
          if (!actor || typeof actor !== 'object') {
            return <span className="text-fg-3">Deleted or unknown account</span>
          }
          return (
            <div className="flex items-center gap-2.5">
              <Avatar size="sm" name={actor.name} id={actor._id} />
              <span className="min-w-0 truncate">
                {actor.name || actor.email || 'Unnamed'}
                {actor._id === currentUser?._id ? (
                  <span className="ml-1.5 text-xs text-fg-3">(you)</span>
                ) : null}
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: 'action',
        header: 'Action',
        meta: { width: '170px', truncate: false },
        cell: ({ row }) => {
          const action = actionText(row.original)
          return (
            <Badge size="sm" variant={actionVariant(row.original)}>
              {action || 'Unrecorded'}
            </Badge>
          )
        },
      },
      {
        id: 'target',
        header: 'Target',
        enableSorting: false,
        meta: { width: '190px' },
        cell: ({ row }) => {
          const log = row.original
          const label = targetLabel(log)
          if (!log?.targetType && !label) return <span className="text-fg-3">—</span>
          return (
            <span className="flex min-w-0 items-center gap-1.5">
              {log?.targetType ? (
                <Badge size="sm" variant="outline">
                  {log.targetType}
                </Badge>
              ) : null}
              <span className="min-w-0 truncate text-fg-2">{label || '—'}</span>
            </span>
          )
        },
      },
      {
        id: 'ip',
        header: 'IP',
        enableSorting: false,
        meta: { width: '120px' },
        cell: ({ row }) => {
          const ip = logIp(row.original)
          return ip ? (
            <span className="font-mono text-xs text-fg-2">{ip}</span>
          ) : (
            <span className="text-fg-3">—</span>
          )
        },
      },
      {
        accessorKey: 'details',
        header: 'Details',
        enableSorting: false,
        cell: ({ row }) => (
          <span className="text-fg-2">{row.original?.details || '—'}</span>
        ),
      },
    ],
    [currentUser]
  )

  /* --- Render ---------------------------------------------------------- */

  return (
    <>
      <PageHeader
        title="Activity log"
        description="Append-only record of every security-relevant action in the workspace."
        actions={
          <>
            <Button
              variant="secondary"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={reload}
              disabled={loading}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Download className="h-4 w-4" />}
              loading={exporting}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </>
        }
      />

      <Toolbar
        left={
          <>
            <label htmlFor="filter-actor" className="text-xs text-fg-3">
              Actor
            </label>
            <Select
              id="filter-actor"
              size="sm"
              className="w-[190px]"
              value={actorParam}
              onChange={(e) => setParams({ actor: e.target.value, page: 1 })}
              options={actorOptions}
            />
            <label htmlFor="filter-action" className="text-xs text-fg-3">
              Action
            </label>
            <Select
              id="filter-action"
              size="sm"
              className="w-[190px]"
              value={actionParam}
              onChange={(e) => setParams({ action: e.target.value, page: 1 })}
              options={actionOptions}
            />
            <label htmlFor="filter-target-type" className="text-xs text-fg-3">
              Target
            </label>
            <Select
              id="filter-target-type"
              size="sm"
              className="w-[150px]"
              value={targetTypeParam}
              onChange={(e) =>
                setParams({
                  targetType: e.target.value,
                  // A target id only means something inside its own type.
                  targetId: e.target.value ? targetIdParam : null,
                  page: 1,
                })
              }
              options={[
                { value: '', label: 'Any target' },
                ...TARGET_TYPES.map((t) => ({ value: t, label: t })),
              ]}
            />
            {targetIdParam ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setParams({ targetId: null, page: 1 })}
              >
                <span className="font-mono text-xs">{targetIdParam.slice(-8)}</span>
                <X aria-hidden="true" className="h-3.5 w-3.5" />
                <span className="sr-only">Clear the target ID filter</span>
              </Button>
            ) : null}
            <label htmlFor="filter-from" className="text-xs text-fg-3">
              From
            </label>
            <Input
              id="filter-from"
              size="sm"
              type="date"
              className="w-[150px]"
              max={toParam || undefined}
              value={fromParam}
              onChange={(e) => setParams({ from: e.target.value, page: 1 })}
            />
            <label htmlFor="filter-to" className="text-xs text-fg-3">
              To
            </label>
            <Input
              id="filter-to"
              size="sm"
              type="date"
              className="w-[150px]"
              min={fromParam || undefined}
              value={toParam}
              onChange={(e) => setParams({ to: e.target.value, page: 1 })}
            />
            {hasFilters ? (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null}
          </>
        }
        right={
          <>
            <label htmlFor="log-search" className="sr-only">
              Search the activity log
            </label>
            <Input
              id="log-search"
              size="sm"
              type="search"
              className="w-[240px]"
              placeholder="Search action, details, target or IP…"
              leadingIcon={<Search className="h-4 w-4" />}
              value={qParam}
              onChange={(e) => setParams({ q: e.target.value, page: 1 }, { replace: true })}
            />
          </>
        }
      />

      <PageBody>
        {error ? (
          <Alert
            variant="danger"
            title="Could not load the activity log"
            className="mb-4"
            action={
              <Button size="sm" onClick={reload}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : null}

        <DataTable
          ariaLabel="Activity log"
          data={rows}
          columns={columns}
          loading={loading}
          getRowId={(r) => r._id}
          onRowClick={(row) => setSelected(row)}
          rowActivation="row"
          sorting={sorting}
          onSortingChange={handleSortingChange}
          density="default"
          pagination={{
            page,
            pageSize: limit,
            total,
            onPageChange: (p) => setParams({ page: p }),
            onPageSizeChange: (size) => setParams({ limit: size, page: 1 }),
            itemLabel: 'entries',
          }}
          emptyState={
            hasFilters
              ? {
                  icon: Search,
                  title: 'No entries match these filters',
                  description: 'Try a wider date range, a different actor, or another action type.',
                  secondaryAction: { label: 'Clear filters', onClick: clearFilters },
                }
              : {
                  icon: ScrollText,
                  title: 'No activity recorded yet',
                  description: 'Sign-ins, task changes and administrative actions appear here.',
                }
          }
        />
      </PageBody>

      <LogDetailDrawer
        log={selected}
        onClose={() => setSelected(null)}
        onFilterByTarget={(log) => {
          setSelected(null)
          filterByTarget(log)
        }}
      />
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Detail drawer
 * ------------------------------------------------------------------------ */

function DetailRow({ label, children }) {
  return (
    <>
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="min-w-0 break-words text-sm text-fg-2">{children}</dd>
    </>
  )
}

function LogDetailDrawer({ log, onClose, onFilterByTarget }) {
  if (!log) return null

  const actor = log.userId && typeof log.userId === 'object' ? log.userId : null
  const action = actionText(log)
  const ip = logIp(log)
  const label = targetLabel(log)
  const change = logChange(log)
  const diff = change ? diffFields(change.before, change.after) : null

  return (
    <Drawer open onOpenChange={(next) => !next && onClose()}>
      <DrawerContent
        size="md"
        title={action || 'Activity entry'}
        description={formatAbsolute(log.createdAt)}
        headerActions={
          log.targetType ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Filter className="h-4 w-4" />}
              onClick={() => onFilterByTarget(log)}
            >
              Show this target
            </Button>
          ) : null
        }
      >
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-3">
            {actor ? (
              <>
                <Avatar size="md" name={actor.name} id={actor._id} />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">
                    {actor.name || 'Unnamed account'}
                  </p>
                  <p className="truncate font-mono text-xs text-fg-3">{actor.email || '—'}</p>
                </div>
                {actor.role ? (
                  <Badge size="sm" variant="neutral">
                    {actor.role}
                  </Badge>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-fg-3">
                The account that performed this action has been deleted.
              </p>
            )}
          </div>

          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 border-t border-line pt-4">
            <DetailRow label="Action">
              <Badge size="sm" variant={actionVariant(log)}>
                {action || 'Unrecorded'}
              </Badge>
            </DetailRow>
            <DetailRow label="When">
              <span className="tabular">{formatAbsolute(log.createdAt)}</span>
              {log.createdAt ? (
                <span className="ml-2 text-xs text-fg-3">{timeAgo(log.createdAt)}</span>
              ) : null}
            </DetailRow>
            <DetailRow label="Details">{log.details || '—'}</DetailRow>
            <DetailRow label="Target type">
              {log.targetType ? (
                <Badge size="sm" variant="outline">
                  {log.targetType}
                </Badge>
              ) : (
                <span className="text-fg-3">Not recorded on this entry</span>
              )}
            </DetailRow>
            <DetailRow label="Target">
              {label || <span className="text-fg-3">Not recorded on this entry</span>}
            </DetailRow>
            <DetailRow label="Target ID">
              {log.targetId ? (
                <span className="font-mono text-xs">{String(log.targetId)}</span>
              ) : (
                <span className="text-fg-3">—</span>
              )}
            </DetailRow>
            <DetailRow label="IP address">
              {ip ? (
                <span className="font-mono text-xs">{ip}</span>
              ) : (
                <span className="text-fg-3">Not recorded on this entry</span>
              )}
            </DetailRow>
            <DetailRow label="User agent">
              {log.userAgent ? (
                <span className="break-all font-mono text-xs">{log.userAgent}</span>
              ) : (
                <span className="text-fg-3">Not recorded on this entry</span>
              )}
            </DetailRow>
            <DetailRow label="Entry ID">
              <span className="font-mono text-xs">{log._id || '—'}</span>
            </DetailRow>
          </dl>

          {change ? (
            <div className="border-t border-line pt-4">
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.04em] text-fg-2">
                Before and after
              </h2>

              {/* S-2 stores before/after as structured objects rather than
                  sentences, so the common case is a real field-by-field diff.
                  A creation (before: null) or deletion (after: null) has no
                  pairs to compare and falls back to the raw snapshots. */}
              {diff ? (
                <>
                  <div className="custom-scrollbar overflow-x-auto rounded-lg border border-line">
                    <table className="w-full border-collapse text-xs">
                      <caption className="sr-only">
                        Field values before and after this action
                      </caption>
                      <thead>
                        <tr className="bg-subtle text-left">
                          <th scope="col" className="px-2.5 py-1.5 font-medium text-fg-3">
                            Field
                          </th>
                          <th scope="col" className="px-2.5 py-1.5 font-medium text-fg-3">
                            Before
                          </th>
                          <th scope="col" className="px-2.5 py-1.5 font-medium text-fg-3">
                            After
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {diff.map((field) => (
                          <tr
                            key={field.key}
                            className={`border-t border-line ${
                              field.changed ? 'bg-warning-subtle' : ''
                            }`}
                          >
                            <th
                              scope="row"
                              className="whitespace-nowrap px-2.5 py-1.5 text-left font-medium text-fg-2"
                            >
                              {field.key}
                              {field.changed ? (
                                <span className="sr-only"> (changed)</span>
                              ) : null}
                            </th>
                            <td className="break-words px-2.5 py-1.5 text-fg-3">
                              {formatChangeValue(field.before)}
                            </td>
                            <td
                              className={`break-words px-2.5 py-1.5 ${
                                field.changed ? 'text-fg' : 'text-fg-3'
                              }`}
                            >
                              {formatChangeValue(field.after)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {diff.every((field) => !field.changed) ? (
                    <p className="mt-2 text-xs text-fg-3">
                      No field changed value — the write was recorded, but it left the record as it
                      was.
                    </p>
                  ) : null}
                </>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="mb-1 text-xs text-fg-3">Before</p>
                    <pre className="custom-scrollbar overflow-x-auto rounded-lg border border-line bg-subtle p-2.5 text-xs text-fg-2">
                      {JSON.stringify(change.before ?? null, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-fg-3">After</p>
                    <pre className="custom-scrollbar overflow-x-auto rounded-lg border border-line bg-subtle p-2.5 text-xs text-fg-2">
                      {JSON.stringify(change.after ?? null, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ) : null}

          <div className="border-t border-line pt-4">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-[0.04em] text-fg-2">
              Raw record
            </h2>
            <pre className="custom-scrollbar max-h-64 overflow-auto rounded-lg border border-line bg-subtle p-2.5 text-xs text-fg-2">
              {JSON.stringify(log, null, 2)}
            </pre>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
