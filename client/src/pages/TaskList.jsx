/**
 * Tasks — List / Board / Calendar.
 *
 * Everything that changes what is on screen (view, filters, sort, page, the
 * open task, the create dialog) lives in the URL query string, so any view is
 * bookmarkable and shareable.
 *
 * Data comes from `GET /api/tasks` under the list contract
 * (docs/audits/API-LIST-CONTRACT.md): `{ data, pagination }` when `page` is
 * sent. While the server migration is in flight the endpoint still answers with
 * a bare array; `applyLegacyQuery` below reproduces the same filter/sort/page
 * semantics on the client so the screen is correct either way. Delete it once
 * `/api/tasks` returns `pagination`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Columns3,
  Download,
  LayoutList,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Repeat,
  Search,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import api, { getErrorMessage, isCanceled } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import { useRegisterCommands } from '../components/CommandRegistry'
import EmailBody from '../components/EmailBody'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  Drawer,
  DrawerContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  FormField,
  Input,
  PageBody,
  PageHeader,
  SegmentedControl,
  Select,
  SelectMenu,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  Toolbar,
  Tooltip,
  toast,
  useConfirm,
} from '../components/ui'
import { cn, formatNumber, timeAgo } from '../lib/utils'
import { ExtractActionsPanel } from '../components/ActionExtraction'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const STATUSES = ['Pending', 'Completed', 'Late']
const PRIORITIES = ['Low', 'Medium', 'High', 'Urgent']
const RECURRENCES = ['Daily', 'Weekly', 'Monthly']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Mirrors the server Zod bounds in middleware/schemas.js. */
const LIMITS = { title: 300, clientName: 200, description: 20000, notes: 20000 }

/** Radix Select forbids an empty item value; this stands in for "no filter". */
const ANY = '__any'

const VIEW_OPTIONS = [
  { value: 'list', label: 'List', icon: <LayoutList /> },
  { value: 'board', label: 'Board', icon: <Columns3 /> },
  { value: 'calendar', label: 'Calendar', icon: <CalendarDays /> },
]

/** Board/calendar load one page of this size — the contract caps `limit` at 100. */
const WIDE_VIEW_LIMIT = 100

const QUERY_DEFAULTS = {
  view: 'list',
  status: '',
  priority: '',
  assignee: '',
  creator: '',
  client: '',
  q: '',
  sort: '-createdAt',
  page: '1',
  limit: '25',
  month: '',
  task: '',
  compose: '',
}

const FILTER_KEYS = ['status', 'priority', 'assignee', 'creator', 'client', 'q']

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

const idOf = (ref) => (ref && typeof ref === 'object' ? ref._id : ref) || ''

const priorityVariant = (p) =>
  ({ Low: 'neutral', Medium: 'info', High: 'warning', Urgent: 'danger' })[p] || 'info'

const statusVariant = (s) =>
  ({ Pending: 'warning', Completed: 'success', Late: 'danger' })[s] || 'neutral'

const dayKey = (date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

function toDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Absolute, unambiguous — used in tooltips and the drawer. */
function formatAbsolute(value) {
  const d = toDate(value)
  if (!d) return 'No deadline'
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Short relative deadline: "Overdue 2d", "in 5h", "3d ago".
 *
 * `overdue` is passed in rather than derived from the date, because a past
 * deadline is not the same thing as an overdue task: a Completed task whose
 * deadline has passed was delivered, not missed. Labelling it "Overdue" read as
 * a live problem on a row the colour logic had already (correctly) treated as
 * fine. Past deadlines on finished work render as plain elapsed time.
 *
 * @param {String|Date} value
 * @param {Number} now
 * @param {Boolean} overdue Whether this task actually counts as overdue
 */
function relativeDue(value, now, overdue = true) {
  const d = toDate(value)
  if (!d) return '—'
  const diff = d.getTime() - now
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  const hours = Math.round(abs / 3600000)
  const days = Math.round(abs / 86400000)
  const span = mins < 60 ? `${mins}m` : hours < 48 ? `${hours}h` : `${days}d`
  if (diff >= 0) return `in ${span}`
  return overdue ? `Overdue ${span}` : `${span} ago`
}

/** `<input type="datetime-local">` needs a local, offset-free value. */
function toLocalInput(value) {
  const d = toDate(value)
  if (!d) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Accepts both contract shapes plus the pre-migration bare array. */
function unwrapList(payload) {
  if (Array.isArray(payload)) return { data: payload, pagination: null }
  if (payload && Array.isArray(payload.data)) {
    return { data: payload.data, pagination: payload.pagination || null }
  }
  return { data: [], pagination: null }
}

const SORT_ACCESSORS = {
  title: (t) => (t.title || '').toLowerCase(),
  clientName: (t) => (t.clientName || '').toLowerCase(),
  status: (t) => STATUSES.indexOf(t.status),
  priority: (t) => PRIORITIES.indexOf(t.priority || 'Medium'),
  deadline: (t) => toDate(t.deadline)?.getTime() ?? Number.POSITIVE_INFINITY,
  createdAt: (t) => toDate(t.createdAt)?.getTime() ?? 0,
  assignedTo: (t) => (t.assignedTo?.name || '').toLowerCase(),
}

/**
 * Client-side stand-in for the not-yet-migrated `/api/tasks`. Applies exactly
 * the filters, sort and paging the request asked the server for.
 */
function applyLegacyQuery(list, params) {
  const needle = (params.q || '').trim().toLowerCase()
  const filtered = list.filter((t) => {
    if (params.status && t.status !== params.status) return false
    if (params.priority && (t.priority || 'Medium') !== params.priority) return false
    if (params.assignedTo && idOf(t.assignedTo) !== params.assignedTo) return false
    if (params.createdBy && idOf(t.createdBy) !== params.createdBy) return false
    if (params.clientName && t.clientName !== params.clientName) return false
    if (needle) {
      const hay = `${t.title || ''} ${t.clientName || ''} ${t.assignedTo?.name || ''}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    return true
  })

  const desc = String(params.sort || '').startsWith('-')
  const field = desc ? params.sort.slice(1) : params.sort
  const accessor = SORT_ACCESSORS[field] || SORT_ACCESSORS.createdAt
  const sorted = filtered.slice().sort((a, b) => {
    const av = accessor(a)
    const bv = accessor(b)
    if (av === bv) return 0
    return (av > bv ? 1 : -1) * (desc ? -1 : 1)
  })

  const page = Math.max(1, Number(params.page) || 1)
  const limit = Math.max(1, Number(params.limit) || 25)
  return { rows: sorted.slice((page - 1) * limit, page * limit), total: sorted.length }
}

/**
 * 42 cells (6 weeks) covering the month `anchor` falls in.
 * Computed once per month, never inside a cell.
 */
function buildMonthGrid(anchor) {
  const year = anchor.getFullYear()
  const month = anchor.getMonth()
  const lead = new Date(year, month, 1).getDay()
  const cells = []
  for (let i = 0; i < 42; i += 1) {
    const d = new Date(year, month, i - lead + 1)
    cells.push({ date: d, key: dayKey(d), inMonth: d.getMonth() === month })
  }
  return cells
}

/** 401/403/429 are already surfaced by the axios interceptor. */
function reportError(err, fallback) {
  if (isCanceled(err)) return
  const status = err?.response?.status
  if (status === 401 || status === 403 || status === 429) return
  toast.error(fallback, { description: getErrorMessage(err) })
}

/* -------------------------------------------------------------------------- */
/* URL state                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A clock the render can depend on. Reading `Date.now()` during render is
 * impure — relative deadlines would only refresh when something else happened
 * to re-render the row.
 */
function useNow(intervalMs = 60000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function useQueryState() {
  const [searchParams, setSearchParams] = useSearchParams()

  const state = useMemo(() => {
    const read = (key) => searchParams.get(key) ?? QUERY_DEFAULTS[key]
    return {
      view: ['list', 'board', 'calendar'].includes(read('view')) ? read('view') : 'list',
      status: STATUSES.includes(read('status')) ? read('status') : '',
      priority: PRIORITIES.includes(read('priority')) ? read('priority') : '',
      assignee: read('assignee'),
      creator: read('creator'),
      client: read('client'),
      q: read('q'),
      sort: read('sort'),
      page: Math.max(1, Number(read('page')) || 1),
      limit: Math.min(100, Math.max(1, Number(read('limit')) || 25)),
      month: read('month'),
      // `expandTaskId` is the notification deep link (NotificationBell.jsx).
      task: searchParams.get('task') || searchParams.get('expandTaskId') || '',
      // `linkEmail` is the "create task from email" deep link (EmailInbox.jsx).
      composing: searchParams.get('compose') === '1' || Boolean(searchParams.get('linkEmail')),
      linkEmail: searchParams.get('linkEmail') || '',
      linkTitle: searchParams.get('title') || '',
      linkClient: searchParams.get('clientName') || '',
    }
  }, [searchParams])

  const update = useCallback(
    (patch) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          Object.entries(patch).forEach(([key, value]) => {
            const str = value === null || value === undefined ? '' : String(value)
            if (!str || str === QUERY_DEFAULTS[key]) next.delete(key)
            else next.set(key, str)
          })
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  return [state, update]
}

/* -------------------------------------------------------------------------- */
/* Data hooks                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * @param {object} params memoised request params — every fetch is aborted on
 *   change, so the five refetch paths can never race each other.
 */
function useTaskQuery(params) {
  const [result, setResult] = useState({ rows: [], total: 0, loading: true, error: null })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    ;(async () => {
      setResult((prev) => ({ ...prev, loading: true, error: null }))
      try {
        const res = await api.get('/tasks', { params, signal: ctrl.signal })
        if (!alive) return
        const { data, pagination } = unwrapList(res.data)
        if (pagination) {
          setResult({ rows: data, total: pagination.total ?? data.length, loading: false, error: null })
        } else {
          const { rows, total } = applyLegacyQuery(data, params)
          setResult({ rows, total, loading: false, error: null })
        }
      } catch (err) {
        if (!alive || isCanceled(err)) return
        setResult({ rows: [], total: 0, loading: false, error: getErrorMessage(err) })
      }
    })()
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [params, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  /** Merge a partial into exactly one row — never restores a whole snapshot. */
  const patchRow = useCallback((taskId, partial) => {
    setResult((prev) => ({
      ...prev,
      rows: prev.rows.map((t) => (t._id === taskId ? { ...t, ...partial } : t)),
    }))
  }, [])

  return { ...result, reload, patchRow }
}

/** Clients / assignable users / linkable emails, fetched once and in parallel. */
function useTaskOptions(canAssign) {
  const [options, setOptions] = useState({ clients: [], users: [], emails: [] })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    ;(async () => {
      const get = (url, params) =>
        api
          .get(url, { params, signal: ctrl.signal })
          .then((r) => unwrapList(r.data).data)
          .catch(() => [])

      const [clients, users, emails] = await Promise.all([
        get('/tasks/clients'),
        canAssign ? get('/users', { page: 1, limit: 100, sort: 'name' }) : Promise.resolve([]),
        // Only the linkable slice, and never with bodies — the list contract
        // returns a snippet. This used to download every email in the account.
        canAssign
          ? get('/gmail/emails', { page: 1, limit: WIDE_VIEW_LIMIT, status: 'unassigned' })
          : Promise.resolve([]),
      ])
      if (!alive) return
      setOptions({
        clients,
        users: users.filter((u) => !u.status || u.status === 'Approved'),
        emails: emails.filter((e) => e.status === 'unassigned' && !e.labelIds?.includes('SPAM')),
      })
    })()
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [canAssign, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return useMemo(() => ({ ...options, reload }), [options, reload])
}

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                 */
/* -------------------------------------------------------------------------- */

/* Three at-a-glance states, never by hue alone — the text itself differs too
 * ("Overdue 3h" / "in 2h" / "in 4d"): overdue → danger, due today → warning,
 * future → neutral. Completed tasks stay neutral regardless of date. */
function DueCell({ task, now }) {
  const d = toDate(task.deadline)
  if (!d) return <span className="text-fg-off">—</span>
  const completed = task.status === 'Completed'
  const overdue = d.getTime() < now && !completed
  const dueToday = !overdue && !completed && d.toDateString() === new Date(now).toDateString()
  return (
    <Tooltip content={formatAbsolute(task.deadline)}>
      <span
        className={cn(
          'tabular text-sm',
          overdue
            ? 'font-medium text-danger-text'
            : dueToday
              ? 'font-medium text-warning-text'
              : 'text-fg-2'
        )}
      >
        {relativeDue(task.deadline, now, overdue)}
      </span>
    </Tooltip>
  )
}

function AssigneeCell({ user }) {
  /* Real information, not a disabled state — `fg-off` (2.56:1) was illegible. */
  if (!user) return <span className="text-fg-3">Unassigned</span>
  return (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar size="xs" name={user.name} id={user._id} />
      <span className="truncate">{user.name}</span>
    </span>
  )
}

function TaskFlags({ task }) {
  return (
    <span className="flex items-center gap-1.5 text-fg-3">
      {task.linkedEmail ? (
        <Tooltip content="Has a linked email">
          <Link2 role="img" aria-label="Has a linked email" className="h-3.5 w-3.5" />
        </Tooltip>
      ) : null}
      {task.isRecurring ? (
        <Tooltip content={`Repeats ${(task.recurrence || 'weekly').toLowerCase()}`}>
          <Repeat
            role="img"
            aria-label={`Repeats ${(task.recurrence || 'Weekly').toLowerCase()}`}
            className="h-3.5 w-3.5"
          />
        </Tooltip>
      ) : null}
    </span>
  )
}

/* `DataTable` ignores row clicks originating on an interactive descendant, so
 * the manual stopPropagation this menu used to carry is redundant. */
function RowMenu({ task, perms, onOpen, onEdit, onComplete, onDelete }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" iconOnly aria-label={`Actions for ${task.title}`}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onOpen(task)}>
          <ClipboardList className="h-4 w-4" />
          Open details
        </DropdownMenuItem>
        {perms.canComplete(task) ? (
          <DropdownMenuItem onSelect={() => onComplete(task)}>
            <CheckCircle2 className="h-4 w-4" />
            Mark complete
          </DropdownMenuItem>
        ) : null}
        {perms.canEdit(task) ? (
          <DropdownMenuItem onSelect={() => onEdit(task)}>
            <Pencil className="h-4 w-4" />
            Edit task
          </DropdownMenuItem>
        ) : null}
        {perms.canDelete(task) ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={() => onDelete(task)}>
              <Trash2 className="h-4 w-4" />
              Delete task
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* -------------------------------------------------------------------------- */
/* Toolbar                                                                     */
/* -------------------------------------------------------------------------- */

/** Every control here writes straight to the query string. */
function TaskFilters({ query, setQuery, options, canAssign, hasFilters, onClear }) {
  const peopleOptions = (label) => [
    { value: ANY, label },
    ...options.users.map((u) => ({ value: u._id, label: u.name })),
  ]

  return (
    <Toolbar
      left={
        <>
          <SegmentedControl
            ariaLabel="Task view"
            value={query.view}
            onValueChange={(view) => setQuery({ view, page: 1 })}
            options={VIEW_OPTIONS}
          />
          <Select
            size="sm"
            aria-label="Filter by status"
            value={query.status}
            placeholder="All statuses"
            className="w-[140px]"
            options={STATUSES.map((s) => ({ value: s, label: s }))}
            onChange={(e) => setQuery({ status: e.target.value, page: 1 })}
          />
          <Select
            size="sm"
            aria-label="Filter by priority"
            value={query.priority}
            placeholder="All priorities"
            className="w-[145px]"
            options={PRIORITIES.map((p) => ({ value: p, label: p }))}
            onChange={(e) => setQuery({ priority: e.target.value, page: 1 })}
          />
          {canAssign ? (
            <>
              <SelectMenu
                size="sm"
                ariaLabel="Filter by assignee"
                value={query.assignee || ANY}
                className="w-[165px]"
                options={peopleOptions('All assignees')}
                onValueChange={(v) => setQuery({ assignee: v === ANY ? null : v, page: 1 })}
              />
              <SelectMenu
                size="sm"
                ariaLabel="Filter by creator"
                value={query.creator || ANY}
                className="w-[165px]"
                options={peopleOptions('All creators')}
                onValueChange={(v) => setQuery({ creator: v === ANY ? null : v, page: 1 })}
              />
              <SelectMenu
                size="sm"
                ariaLabel="Filter by client"
                value={query.client || ANY}
                className="w-[165px]"
                options={[
                  { value: ANY, label: 'All clients' },
                  ...options.clients.map((c) => ({ value: c.name, label: c.name })),
                ]}
                onValueChange={(v) => setQuery({ client: v === ANY ? null : v, page: 1 })}
              />
            </>
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" leftIcon={<X className="h-3.5 w-3.5" />} onClick={onClear}>
              Clear filters
            </Button>
          ) : null}
        </>
      }
      right={
        <Input
          key={query.q}
          size="sm"
          type="search"
          aria-label="Search tasks"
          placeholder="Search title, client or assignee"
          defaultValue={query.q}
          leadingIcon={<Search />}
          className="w-[260px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') setQuery({ q: e.currentTarget.value, page: 1 })
          }}
          onBlur={(e) => {
            if (e.target.value !== query.q) setQuery({ q: e.target.value, page: 1 })
          }}
        />
      }
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Bulk action bar                                                             */
/* -------------------------------------------------------------------------- */

function BulkBar({ selected, users, onClear, onAction, busy, blocked }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
      <span className="text-sm font-medium text-fg">
        {formatNumber(selected.length)} selected
      </span>
      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear selection
      </Button>
      <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />

      {blocked ? (
        <span className="text-xs text-fg-3">
          Bulk actions are limited to tasks you created.
        </span>
      ) : (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={busy} rightIcon={<ChevronDown className="h-3.5 w-3.5" />}>
                Set status
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {STATUSES.map((s) => (
                <DropdownMenuItem key={s} onSelect={() => onAction('status', s)}>
                  {s}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" disabled={busy || users.length === 0} rightIcon={<ChevronDown className="h-3.5 w-3.5" />}>
                Reassign
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>Assign to</DropdownMenuLabel>
              {users.map((u) => (
                <DropdownMenuItem key={u._id} onSelect={() => onAction('reassign', u._id)}>
                  <Avatar size="xs" name={u.name} id={u._id} />
                  {u.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="danger-ghost"
            size="sm"
            disabled={busy}
            leftIcon={<Trash2 className="h-3.5 w-3.5" />}
            onClick={() => onAction('delete')}
          >
            Delete
          </Button>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Board view                                                                  */
/* -------------------------------------------------------------------------- */

function BoardCard({ task, dragging, draggable, onOpen, onDragStart, onDragEnd }) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => onDragStart(e, task)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
      className={cn(
        'w-full rounded border border-line bg-surface p-2.5 text-left transition-colors duration-100',
        'hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600',
        draggable && 'cursor-grab active:cursor-grabbing',
        dragging && 'opacity-50'
      )}
    >
      <span className="line-clamp-2 block text-sm font-medium text-fg">{task.title}</span>
      <span className="mt-0.5 block truncate text-xs text-fg-3">{task.clientName || 'No client'}</span>
      <span className="mt-2 flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Avatar size="xs" name={task.assignedTo?.name} id={task.assignedTo?._id} />
          <span className="truncate text-xs text-fg-3">{task.assignedTo?.name || 'Unassigned'}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          <TaskFlags task={task} />
          <Badge size="sm" variant={priorityVariant(task.priority)}>
            {task.priority || 'Medium'}
          </Badge>
        </span>
      </span>
    </button>
  )
}

function TaskBoard({ tasks, onOpen, onMove, canMoveTo }) {
  const [dragId, setDragId] = useState(null)
  const [overColumn, setOverColumn] = useState(null)

  const grouped = useMemo(() => {
    const map = { Pending: [], Completed: [], Late: [] }
    tasks.forEach((t) => (map[t.status] || map.Pending).push(t))
    return map
  }, [tasks])

  const dragged = dragId ? tasks.find((t) => t._id === dragId) : null

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {STATUSES.map((status) => {
        const allowed = !dragged || canMoveTo(dragged, status)
        const isOver = overColumn === status && allowed
        return (
          <section
            key={status}
            aria-label={`${status} tasks`}
            onDragOver={(e) => {
              if (!allowed) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              if (overColumn !== status) setOverColumn(status)
            }}
            onDragLeave={() => setOverColumn((c) => (c === status ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              setOverColumn(null)
              const id = dragId || e.dataTransfer.getData('text/plain')
              setDragId(null)
              if (id) onMove(id, status)
            }}
            className={cn(
              'flex min-h-[420px] flex-col rounded-lg border border-line bg-canvas',
              isOver && 'outline outline-2 -outline-offset-2 outline-primary-600'
            )}
          >
            <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="text-sm font-medium text-fg">{status}</span>
              <Badge size="sm" variant="neutral">
                {formatNumber(grouped[status].length)}
              </Badge>
            </header>
            <div className="custom-scrollbar flex max-h-[64vh] flex-col gap-2 overflow-y-auto p-2">
              {grouped[status].length === 0 ? (
                <p className="px-2 py-8 text-center text-xs text-fg-3">No tasks</p>
              ) : (
                grouped[status].map((task) => (
                  <BoardCard
                    key={task._id}
                    task={task}
                    dragging={dragId === task._id}
                    draggable={canMoveTo(task, 'Completed') || canMoveTo(task, 'Pending')}
                    onOpen={onOpen}
                    onDragStart={(e, t) => {
                      setDragId(t._id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', t._id)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverColumn(null)
                    }}
                  />
                ))
              )}
            </div>
          </section>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Calendar view                                                               */
/* -------------------------------------------------------------------------- */

const CALENDAR_KEYS = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
}

function TaskCalendar({ anchor, tasks, now, onOpen, onMonthChange, onPickDay }) {
  const gridRef = useRef(null)
  const [expanded, setExpanded] = useState(null)
  /* Roving tabindex: the grid is a single tab stop, arrows move within it. */
  const [activeCell, setActiveCell] = useState(0)

  const cells = useMemo(() => buildMonthGrid(anchor), [anchor])

  /* One pass over the tasks — not one filter per cell. */
  const byDay = useMemo(() => {
    const map = new Map()
    tasks.forEach((task) => {
      const d = toDate(task.deadline)
      if (!d) return
      const key = dayKey(d)
      const bucket = map.get(key)
      if (bucket) bucket.push(task)
      else map.set(key, [task])
    })
    return map
  }, [tasks])

  const todayKey = dayKey(new Date(now))

  const focusCell = (index) => {
    const el = gridRef.current?.querySelector(`[data-day-index="${index}"]`)
    if (el) el.focus()
  }

  const onKeyDown = (event, index) => {
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault()
      onMonthChange(event.key === 'PageUp' ? -1 : 1)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const rowStart = Math.floor(index / 7) * 7
      focusCell(event.key === 'Home' ? rowStart : rowStart + 6)
      return
    }
    const delta = CALENDAR_KEYS[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const next = index + delta
    if (next < 0 || next > 41) {
      onMonthChange(delta < 0 ? -1 : 1)
      return
    }
    focusCell(next)
  }

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="text-sm font-medium text-fg">
          {anchor.toLocaleString(undefined, { month: 'long', year: 'numeric' })}
        </h2>
        <div className="flex items-center gap-1">
          <Button size="sm" iconOnly aria-label="Previous month" onClick={() => onMonthChange(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={() => onMonthChange(0)}>
            Today
          </Button>
          <Button size="sm" iconOnly aria-label="Next month" onClick={() => onMonthChange(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 border-b border-line bg-canvas">
        {WEEKDAYS.map((d) => (
          <div key={d} className="px-2 py-1.5 text-2xs font-semibold uppercase tracking-[0.04em] text-fg-3">
            {d}
          </div>
        ))}
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label="Task deadlines by day"
        className="grid grid-cols-7 border-l border-line"
      >
        {cells.map((cell, index) => {
          const dayTasks = byDay.get(cell.key) || []
          const isToday = cell.key === todayKey
          const showAll = expanded === cell.key
          const visible = showAll ? dayTasks : dayTasks.slice(0, 2)
          return (
            <div
              key={cell.key}
              role="gridcell"
              className={cn(
                'flex min-h-[104px] flex-col gap-1 border-b border-r border-line p-1.5',
                !cell.inMonth && 'bg-canvas',
                isToday && 'border-t-2 border-t-primary-600 bg-primary-subtle'
              )}
            >
              <button
                type="button"
                data-day-index={index}
                tabIndex={index === activeCell ? 0 : -1}
                onFocus={() => setActiveCell(index)}
                onKeyDown={(e) => onKeyDown(e, index)}
                onClick={() => onPickDay(cell.date)}
                aria-label={`${cell.date.toLocaleDateString(undefined, { dateStyle: 'full' })}, ${dayTasks.length} task${dayTasks.length === 1 ? '' : 's'}`}
                className={cn(
                  'self-start rounded-sm px-1 text-xs tabular focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600',
                  isToday ? 'font-semibold text-primary-text' : cell.inMonth ? 'text-fg-2' : 'text-fg-off'
                )}
              >
                {cell.date.getDate()}
              </button>

              {visible.map((task) => (
                <button
                  key={task._id}
                  type="button"
                  onClick={() => onOpen(task)}
                  title={`${task.title} · ${task.clientName || 'No client'}`}
                  className={cn(
                    'flex h-5 w-full items-center gap-1 overflow-hidden rounded-sm border-l-[3px] bg-subtle px-1 text-left text-2xs text-fg-2',
                    'hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600',
                    task.priority === 'Urgent'
                      ? 'border-l-danger'
                      : task.priority === 'High'
                        ? 'border-l-warning'
                        : task.priority === 'Low'
                          ? 'border-l-neutral'
                          : 'border-l-info',
                    task.status === 'Completed' && 'line-through'
                  )}
                >
                  <span className="truncate">{task.title}</span>
                </button>
              ))}

              {dayTasks.length > 2 ? (
                <button
                  type="button"
                  onClick={() => setExpanded(showAll ? null : cell.key)}
                  className="self-start rounded-sm px-1 text-2xs text-primary-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600"
                >
                  {showAll ? 'Show less' : `+${dayTasks.length - 2} more`}
                </button>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Comment thread                                                              */
/* -------------------------------------------------------------------------- */

function CommentThread({ taskId, task, user, isAdmin, isHead, onCountChange }) {
  const confirm = useConfirm()
  const [comments, setComments] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [posting, setPosting] = useState(false)
  const postingRef = useRef(false)

  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    ;(async () => {
      try {
        const res = await api.get(`/tasks/${taskId}/comments`, {
          params: { page: 1, limit: 100 },
          signal: ctrl.signal,
        })
        if (!alive) return
        const list = unwrapList(res.data).data
        setComments(list)
        setLoading(false)
        onCountChange?.(list.length)
      } catch (err) {
        if (!alive || isCanceled(err)) return
        setError(getErrorMessage(err))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [taskId, onCountChange])

  /* Mirrors commentController.deleteComment exactly, so no button 403s. */
  const canDelete = (comment) => {
    const me = user?._id
    if (!me) return false
    const isOwner = idOf(comment.author) === me
    const isCreator = idOf(task?.createdBy) === me
    const isAssignee = idOf(task?.assignedTo) === me
    if (isAdmin) return true
    if (isHead) return isCreator || (isOwner && isAssignee)
    return isOwner && isAssignee
  }

  const submit = async () => {
    const message = draft.trim()
    if (!message || postingRef.current) return
    postingRef.current = true
    setPosting(true)

    const tempId = `pending-${Date.now()}`
    const optimistic = {
      _id: tempId,
      message,
      pending: true,
      createdAt: new Date().toISOString(),
      author: { _id: user?._id, name: user?.name, role: user?.role },
    }
    const pendingList = [...comments, optimistic]
    setComments(pendingList)
    setDraft('')
    onCountChange?.(pendingList.length)

    try {
      const res = await api.post(`/tasks/${taskId}/comments`, { message })
      setComments((prev) => prev.map((c) => (c._id === tempId ? res.data : c)))
    } catch (err) {
      setComments((prev) => prev.filter((c) => c._id !== tempId))
      setDraft(message)
      onCountChange?.(pendingList.length - 1)
      reportError(err, 'Could not post the comment')
    } finally {
      postingRef.current = false
      setPosting(false)
    }
  }

  const remove = async (comment) => {
    const ok = await confirm({
      title: 'Delete this comment?',
      description: 'The comment is removed permanently for everyone on this task.',
      confirmLabel: 'Delete comment',
      cancelLabel: 'Keep comment',
      tone: 'danger',
    })
    if (!ok) return
    const snapshot = comments
    const next = snapshot.filter((c) => c._id !== comment._id)
    setComments(next)
    onCountChange?.(next.length)
    try {
      await api.delete(`/tasks/${taskId}/comments/${comment._id}`)
    } catch (err) {
      setComments(snapshot)
      onCountChange?.(snapshot.length)
      reportError(err, 'Could not delete the comment')
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <Alert variant="danger" title="Could not load comments">{error}</Alert> : null}

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : comments.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No comments yet"
          description="Use comments to record what changed and who was told."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.map((comment) => (
            <li key={comment._id} className={cn('flex gap-2.5', comment.pending && 'opacity-60')}>
              <Avatar size="sm" name={comment.author?.name} id={idOf(comment.author)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{comment.author?.name || 'Unknown'}</span>
                  <span className="text-xs text-fg-3">
                    {comment.pending ? 'Sending…' : timeAgo(comment.createdAt)}
                  </span>
                  {!comment.pending && canDelete(comment) ? (
                    <Button
                      variant="danger-ghost"
                      size="sm"
                      iconOnly
                      aria-label={`Delete comment by ${comment.author?.name || 'unknown author'}`}
                      className="ml-auto"
                      onClick={() => remove(comment)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap text-sm text-fg-2">{comment.message}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-end gap-2 border-t border-line pt-3">
        <Textarea
          rows={2}
          value={draft}
          aria-label="Add a comment"
          placeholder="Add a comment. Enter to send, Shift+Enter for a new line."
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <Button
          variant="primary"
          loading={posting}
          disabled={!draft.trim()}
          leftIcon={<Send className="h-4 w-4" />}
          onClick={submit}
        >
          Post
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Task drawer                                                                 */
/* -------------------------------------------------------------------------- */

function DetailRow({ label, children }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 border-b border-line py-2 last:border-b-0">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="min-w-0 text-sm text-fg-2">{children}</dd>
    </div>
  )
}

function TaskDrawerBody({
  taskId,
  perms,
  user,
  users,
  now,
  onEdit,
  onComplete,
  onDelete,
  onClose,
  onTasksCreated,
}) {
  const [task, setTask] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [commentCount, setCommentCount] = useState(null)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    let alive = true
    ;(async () => {
      try {
        const res = await api.get(`/tasks/${taskId}`, { signal: ctrl.signal })
        if (!alive) return
        setTask(res.data)
        setLoading(false)
      } catch (err) {
        if (!alive || isCanceled(err)) return
        setError(getErrorMessage(err))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [taskId, nonce])

  const download = async (emailId, attachmentId, filename) => {
    let url
    try {
      const res = await api.get(`/gmail/emails/${emailId}/attachments/${attachmentId}`, {
        responseType: 'blob',
      })
      url = window.URL.createObjectURL(new Blob([res.data]))
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      link.remove()
    } catch (err) {
      reportError(err, 'Could not download the attachment')
    } finally {
      if (url) window.URL.revokeObjectURL(url)
    }
  }

  if (loading) {
    return (
      <DrawerContent size="lg" title="Loading task…">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-32 w-full" />
        </div>
      </DrawerContent>
    )
  }

  if (error || !task) {
    return (
      <DrawerContent size="lg" title="Task unavailable">
        <Alert
          variant="danger"
          title="Could not load this task"
          action={
            <Button size="sm" onClick={() => setNonce((n) => n + 1)}>
              Retry
            </Button>
          }
        >
          {error || 'The task no longer exists.'}
        </Alert>
      </DrawerContent>
    )
  }

  const email = task.linkedEmail
  const attachments = email?.attachments || []

  return (
    <DrawerContent
      size="lg"
      title={task.title}
      description={`${task.clientName || 'No client'} · ${formatAbsolute(task.deadline)}`}
      headerActions={
        <>
          {perms.canComplete(task) ? (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<CheckCircle2 className="h-4 w-4" />}
              onClick={async () => {
                setTask((prev) => ({ ...prev, status: 'Completed' }))
                const ok = await onComplete(task)
                if (!ok) setTask((prev) => ({ ...prev, status: task.status }))
              }}
            >
              Mark complete
            </Button>
          ) : null}
          {perms.canEdit(task) || perms.canDelete(task) ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm" iconOnly aria-label="More task actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {perms.canEdit(task) ? (
                  <DropdownMenuItem onSelect={() => onEdit(task)}>
                    <Pencil className="h-4 w-4" />
                    Edit task
                  </DropdownMenuItem>
                ) : null}
                {perms.canDelete(task) ? (
                  <DropdownMenuItem destructive onSelect={() => onDelete(task)}>
                    <Trash2 className="h-4 w-4" />
                    Delete task
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </>
      }
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
      bodyClassName="p-0"
    >
      <div className="flex items-center gap-2 border-b border-line px-5 py-3">
        <Badge variant={statusVariant(task.status)}>{task.status}</Badge>
        <Badge variant={priorityVariant(task.priority)}>{task.priority || 'Medium'} priority</Badge>
        <TaskFlags task={task} />
      </div>

      <Tabs defaultValue="details" className="px-5">
        <TabsList>
          <TabsTrigger value="details">Details</TabsTrigger>
          {email ? <TabsTrigger value="email">Linked email</TabsTrigger> : null}
          <TabsTrigger value="comments" count={commentCount ?? undefined}>
            Comments
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="py-4">
          <dl>
            <DetailRow label="Client">{task.clientName || '—'}</DetailRow>
            <DetailRow label="Assignee">
              <AssigneeCell user={task.assignedTo} />
            </DetailRow>
            <DetailRow label="Deadline">
              <span className="tabular">{formatAbsolute(task.deadline)}</span>{' '}
              <span className="text-fg-3">({relativeDue(task.deadline, now)})</span>
            </DetailRow>
            <DetailRow label="Recurrence">
              {task.isRecurring ? `Repeats ${(task.recurrence || 'Weekly').toLowerCase()}` : 'Does not repeat'}
            </DetailRow>
            <DetailRow label="Description">
              <p className="whitespace-pre-wrap">{task.description || '—'}</p>
            </DetailRow>
            <DetailRow label="Internal notes">
              <p className="whitespace-pre-wrap">{task.notes || '—'}</p>
            </DetailRow>
          </dl>
        </TabsContent>

        {email ? (
          <TabsContent value="email" className="py-4">
            <div className="mb-3">
              <p className="text-sm font-medium text-fg">{email.subject || '(No subject)'}</p>
              <p className="text-xs text-fg-3">From {email.from}</p>
            </div>
            {/* `imageGate` gives the reader the same "Show remote images"
                control the inbox has; without it remote images are blocked
                with no way to reveal them. */}
            <EmailBody html={email.body} minHeight={220} maxHeight={640} imageGate />
            {attachments.length > 0 ? (
              <div className="mt-4">
                <p className="mb-2 text-xs font-medium text-fg-2">
                  Attachments ({attachments.length})
                </p>
                <div className="flex flex-wrap gap-2">
                  {attachments.map((att) => (
                    <Button
                      key={att.attachmentId}
                      size="sm"
                      leftIcon={<Download className="h-3.5 w-3.5" />}
                      onClick={() => download(email._id, att.attachmentId, att.filename)}
                    >
                      {att.filename}
                      <span className="ml-1 tabular text-xs text-fg-3">
                        {Math.max(1, Math.round((att.size || 0) / 1024))} KB
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* F-3: pull follow-up work out of the message this task came
                from. Suggestions only — a new task is created solely by an
                explicit "Create selected", and is linked back to this email. */}
            {perms.canCreate ? (
              <div className="mt-4">
                <ExtractActionsPanel
                  emailId={email._id}
                  users={users}
                  linkedEmail={email._id}
                  onCreated={onTasksCreated}
                />
              </div>
            ) : null}
          </TabsContent>
        ) : null}

        <TabsContent value="comments" className="py-4">
          <CommentThread
            taskId={task._id}
            task={task}
            user={user}
            isAdmin={perms.isAdmin}
            isHead={perms.isHead}
            onCountChange={setCommentCount}
          />
        </TabsContent>

        <TabsContent value="activity" className="py-4">
          <dl>
            <DetailRow label="Created by">{task.createdBy?.name || 'System'}</DetailRow>
            <DetailRow label="Created">
              <span className="tabular">{formatAbsolute(task.createdAt)}</span>{' '}
              <span className="text-fg-3">({timeAgo(task.createdAt)})</span>
            </DetailRow>
            <DetailRow label="Current status">{task.status}</DetailRow>
            <DetailRow label="Recurring from">
              {task.parentTaskId ? 'A previous occurrence of this task' : '—'}
            </DetailRow>
          </dl>
          <p className="mt-3 text-xs text-fg-3">
            Full edit history is recorded in the Activity Log.
          </p>
        </TabsContent>
      </Tabs>
    </DrawerContent>
  )
}

/* -------------------------------------------------------------------------- */
/* Create / edit dialog                                                        */
/* -------------------------------------------------------------------------- */

const EMPTY_FORM = {
  title: '',
  description: '',
  clientName: '',
  assignedTo: '',
  linkedEmail: '',
  deadline: '',
  notes: '',
  status: 'Pending',
  priority: 'Medium',
  isRecurring: false,
  recurrence: 'Weekly',
}

function validateForm(form, mode) {
  const errors = {}
  const title = form.title.trim()
  if (!title) errors.title = 'A title is required.'
  else if (title.length > LIMITS.title) errors.title = `Keep the title under ${LIMITS.title} characters.`

  const client = form.clientName.trim()
  if (!client) errors.clientName = 'A client name is required.'
  else if (client.length > LIMITS.clientName)
    errors.clientName = `Keep the client name under ${LIMITS.clientName} characters.`

  if (!form.assignedTo) errors.assignedTo = 'Choose who this task is for.'

  if (!form.deadline) errors.deadline = 'A deadline is required.'
  else {
    const d = new Date(form.deadline)
    if (Number.isNaN(d.getTime())) errors.deadline = 'Enter a valid date and time.'
    else if (mode === 'create' && d.getTime() <= Date.now())
      errors.deadline = 'The deadline must be in the future.'
  }

  if (form.description.length > LIMITS.description) errors.description = 'This description is too long.'
  if (form.notes.length > LIMITS.notes) errors.notes = 'These notes are too long.'
  return errors
}

/**
 * Remounted by the page (`key`) whenever it opens, so the form always starts
 * from `initial` without a state-syncing effect.
 */
function TaskFormDialog({ open, mode, initial, options, saving, onSubmit, onOpenChange }) {
  const [form, setForm] = useState(() => ({ ...EMPTY_FORM, ...initial }))
  const [errors, setErrors] = useState({})
  const formId = `task-form-${mode}`

  const set = (key) => (value) => setForm((prev) => ({ ...prev, [key]: value }))

  const handleSubmit = (event) => {
    event.preventDefault()
    const found = validateForm(form, mode)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    onSubmit(form)
  }

  const clientOptions = useMemo(
    () => options.clients.map((c) => ({ value: c.name, label: c.name })),
    [options.clients]
  )

  /* A deep link from the inbox may reference an email that is not in the
     first page of unassigned mail — keep it selectable rather than silently
     dropping the link. */
  const emailOptions = useMemo(() => {
    const list = options.emails.map((e) => ({
      value: e._id,
      label: `${e.subject || '(No subject)'} — ${e.from}`,
    }))
    if (initial?.linkedEmail && !list.some((o) => o.value === initial.linkedEmail)) {
      list.unshift({ value: initial.linkedEmail, label: 'Email selected from the inbox' })
    }
    return list
  }, [options.emails, initial])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          size="lg"
          dismissable={false}
          title={mode === 'create' ? 'New task' : 'Edit task'}
          description={
            mode === 'create'
              ? 'Assign work and, optionally, link the email it came from.'
              : 'Update the assignment, schedule or status.'
          }
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary">Cancel</Button>
              </DialogClose>
              <Button variant="primary" type="submit" form={formId} loading={saving}>
                {mode === 'create' ? 'Create task' : 'Save changes'}
              </Button>
            </>
          }
        >
          <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <FormField label="Title" required error={errors.title}>
              {(field) => (
                <Input
                  {...field}
                  value={form.title}
                  maxLength={LIMITS.title}
                  placeholder="e.g. File Q3 GST return"
                  onChange={(e) => set('title')(e.target.value)}
                />
              )}
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Client" required error={errors.clientName} hint="Type a new name or pick an existing client.">
                {(field) => (
                  <Input
                    {...field}
                    list={`${formId}-clients`}
                    value={form.clientName}
                    maxLength={LIMITS.clientName}
                    placeholder="Search clients…"
                    onChange={(e) => set('clientName')(e.target.value)}
                  />
                )}
              </FormField>
              <datalist id={`${formId}-clients`}>
                {clientOptions.map((c) => (
                  <option key={c.value} value={c.value} />
                ))}
              </datalist>

              <FormField label="Assignee" required error={errors.assignedTo}>
                {(field) => (
                  <Select
                    {...field}
                    value={form.assignedTo}
                    placeholder="Choose a team member"
                    options={options.users.map((u) => ({ value: u._id, label: `${u.name} (${u.role})` }))}
                    onChange={(e) => set('assignedTo')(e.target.value)}
                  />
                )}
              </FormField>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <FormField label="Deadline" required error={errors.deadline}>
                {(field) => (
                  <Input
                    {...field}
                    type="datetime-local"
                    value={form.deadline}
                    onChange={(e) => set('deadline')(e.target.value)}
                  />
                )}
              </FormField>
              <FormField label="Priority">
                {(field) => (
                  <Select
                    {...field}
                    value={form.priority}
                    options={PRIORITIES.map((p) => ({ value: p, label: p }))}
                    onChange={(e) => set('priority')(e.target.value)}
                  />
                )}
              </FormField>
              {mode === 'edit' ? (
                <FormField label="Status">
                  {(field) => (
                    <Select
                      {...field}
                      value={form.status}
                      options={STATUSES.map((s) => ({ value: s, label: s }))}
                      onChange={(e) => set('status')(e.target.value)}
                    />
                  )}
                </FormField>
              ) : (
                <FormField label="Link an email" optionalText="Optional">
                  {(field) => (
                    <Select
                      {...field}
                      value={form.linkedEmail}
                      placeholder="No linked email"
                      options={emailOptions}
                      onChange={(e) => set('linkedEmail')(e.target.value)}
                    />
                  )}
                </FormField>
              )}
            </div>

            <FormField label="Description" optionalText="Optional" error={errors.description}>
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  value={form.description}
                  maxLength={LIMITS.description}
                  onChange={(e) => set('description')(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Internal notes" optionalText="Optional" error={errors.notes}>
              {(field) => (
                <Textarea
                  {...field}
                  rows={2}
                  value={form.notes}
                  maxLength={LIMITS.notes}
                  onChange={(e) => set('notes')(e.target.value)}
                />
              )}
            </FormField>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Repeats">
                {(field) => (
                  <Select
                    {...field}
                    value={form.isRecurring ? 'yes' : 'no'}
                    options={[
                      { value: 'no', label: 'Does not repeat' },
                      { value: 'yes', label: 'Repeats on a schedule' },
                    ]}
                    onChange={(e) => set('isRecurring')(e.target.value === 'yes')}
                  />
                )}
              </FormField>
              {form.isRecurring ? (
                <FormField label="Frequency">
                  {(field) => (
                    <Select
                      {...field}
                      value={form.recurrence}
                      options={RECURRENCES.map((r) => ({ value: r, label: r }))}
                      onChange={(e) => set('recurrence')(e.target.value)}
                    />
                  )}
                </FormField>
              ) : null}
            </div>
          </form>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function TaskList() {
  const { user, isAdmin, isHead } = useAuth()
  const confirm = useConfirm()
  const [query, setQuery] = useQueryState()
  const now = useNow()

  const canAssign = isAdmin || isHead
  const [selection, setSelection] = useState({})
  const [saving, setSaving] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  /* Deadline pre-filled by clicking a calendar day. */
  const [dayPrefill, setDayPrefill] = useState('')

  const options = useTaskOptions(canAssign)

  const wideView = query.view !== 'list'
  const requestParams = useMemo(
    () => ({
      page: wideView ? 1 : query.page,
      limit: wideView ? WIDE_VIEW_LIMIT : query.limit,
      sort: query.sort,
      ...(query.status ? { status: query.status } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.assignee ? { assignedTo: query.assignee } : {}),
      ...(query.creator ? { createdBy: query.creator } : {}),
      ...(query.client ? { clientName: query.client } : {}),
      ...(query.q ? { q: query.q } : {}),
    }),
    [wideView, query.page, query.limit, query.sort, query.status, query.priority, query.assignee, query.creator, query.client, query.q]
  )

  const { rows, total, loading, error, reload, patchRow } = useTaskQuery(requestParams)

  /* ---- permissions, mirrored from taskController.js ---- */
  const perms = useMemo(() => {
    const me = user?._id
    const owns = (t) => idOf(t.createdBy) === me
    const assigned = (t) => idOf(t.assignedTo) === me
    return {
      isAdmin,
      isHead,
      canCreate: isAdmin || isHead,
      canEdit: (t) => isAdmin || (isHead && (owns(t) || assigned(t))),
      canDelete: (t) => isAdmin || (isHead && owns(t)),
      canComplete: (t) =>
        t.status !== 'Completed' &&
        (isAdmin || (isHead && (owns(t) || assigned(t))) || (!isAdmin && !isHead && assigned(t))),
      canBulk: (t) => isAdmin || (isHead && owns(t)),
    }
  }, [user, isAdmin, isHead])

  /* Scoped to the rows actually on screen, so a selection made on page 1 can
     never be acted on invisibly from page 2. */
  const selectedTasks = useMemo(() => rows.filter((t) => selection[t._id]), [rows, selection])
  const selectedIds = useMemo(() => selectedTasks.map((t) => t._id), [selectedTasks])
  const bulkBlocked = selectedTasks.some((t) => !perms.canBulk(t))

  /* ---- mutations ---- */
  const openTask = useCallback((task) => setQuery({ task: task._id, expandTaskId: null }), [setQuery])
  const closeTask = useCallback(() => setQuery({ task: null, expandTaskId: null }), [setQuery])

  /* Editing replaces the drawer rather than stacking two focus traps. */
  const startEdit = useCallback(
    (task) => {
      setDayPrefill('')
      setEditing(task)
      setQuery({ task: null, expandTaskId: null })
    },
    [setQuery]
  )

  /** @returns {Promise<boolean>} so the drawer can undo its own optimistic edit. */
  const completeTask = useCallback(
    async (task) => {
      patchRow(task._id, { status: 'Completed' })
      try {
        const res = await api.put(`/tasks/${task._id}`, { status: 'Completed' })
        patchRow(task._id, res.data)
        toast.success('Task marked complete')
        return true
      } catch (err) {
        patchRow(task._id, { status: task.status })
        reportError(err, 'Could not update the task')
        return false
      }
    },
    [patchRow]
  )

  const moveTask = useCallback(
    async (taskId, status) => {
      const task = rows.find((t) => t._id === taskId)
      if (!task || task.status === status) return
      patchRow(taskId, { status })
      try {
        const res = await api.put(`/tasks/${taskId}`, { status })
        patchRow(taskId, res.data)
      } catch (err) {
        /* Roll back only this task — concurrent updates to others survive. */
        patchRow(taskId, { status: task.status })
        reportError(err, `Could not move “${task.title}” to ${status}`)
      }
    },
    [rows, patchRow]
  )

  const deleteTask = useCallback(
    async (task) => {
      const ok = await confirm({
        title: `Delete “${task.title}”?`,
        description: 'The task, its comments and its link to any email are removed permanently.',
        confirmLabel: 'Delete task',
        cancelLabel: 'Keep task',
        tone: 'danger',
      })
      if (!ok) return
      try {
        await api.delete(`/tasks/${task._id}`)
        toast.success('Task deleted')
        closeTask()
        reload()
        options.reload()
      } catch (err) {
        reportError(err, 'Could not delete the task')
      }
    },
    [confirm, closeTask, reload, options]
  )

  const runBulk = useCallback(
    async (action, value) => {
      if (selectedIds.length === 0) return
      if (action === 'delete') {
        const ok = await confirm({
          title: `Delete ${selectedIds.length} task${selectedIds.length === 1 ? '' : 's'}?`,
          description: 'The tasks, their comments and their email links are removed permanently.',
          confirmLabel: 'Delete tasks',
          cancelLabel: 'Keep tasks',
          tone: 'danger',
        })
        if (!ok) return
      }
      setBulkBusy(true)
      try {
        await api.post('/tasks/bulk', { taskIds: selectedIds, action, ...(value ? { value } : {}) })
        toast.success(
          action === 'delete'
            ? `${selectedIds.length} tasks deleted`
            : action === 'status'
              ? `${selectedIds.length} tasks set to ${value}`
              : `${selectedIds.length} tasks reassigned`
        )
        setSelection({})
        reload()
        options.reload()
      } catch (err) {
        reportError(err, 'The bulk action did not complete')
      } finally {
        setBulkBusy(false)
      }
    },
    [selectedIds, confirm, reload, options]
  )

  const saveTask = useCallback(
    async (form) => {
      setSaving(true)
      const payload = {
        title: form.title.trim(),
        description: form.description,
        clientName: form.clientName.trim(),
        assignedTo: form.assignedTo,
        deadline: form.deadline,
        notes: form.notes,
        priority: form.priority,
        isRecurring: form.isRecurring,
        recurrence: form.isRecurring ? form.recurrence : null,
      }
      try {
        if (editing) {
          await api.put(`/tasks/${editing._id}`, { ...payload, status: form.status })
          toast.success('Task updated')
        } else {
          await api.post('/tasks', {
            ...payload,
            ...(form.linkedEmail ? { linkedEmail: form.linkedEmail } : {}),
          })
          toast.success('Task created')
        }
        setEditing(null)
        setQuery({ compose: null, linkEmail: null, title: null, clientName: null })
        reload()
        options.reload()
      } catch (err) {
        reportError(err, editing ? 'Could not save the task' : 'Could not create the task')
      } finally {
        setSaving(false)
      }
    },
    [editing, setQuery, reload, options]
  )

  /* ---- dialog wiring ---- */
  const composing = query.composing || Boolean(editing)
  const dialogInitial = useMemo(() => {
    if (editing) {
      return {
        title: editing.title || '',
        description: editing.description || '',
        clientName: editing.clientName || '',
        assignedTo: idOf(editing.assignedTo),
        deadline: toLocalInput(editing.deadline),
        notes: editing.notes || '',
        status: editing.status || 'Pending',
        priority: editing.priority || 'Medium',
        isRecurring: Boolean(editing.isRecurring),
        recurrence: editing.recurrence || 'Weekly',
      }
    }
    return {
      title: query.linkTitle,
      clientName: query.linkClient,
      linkedEmail: query.linkEmail,
      deadline: dayPrefill,
    }
  }, [editing, query.linkTitle, query.linkClient, query.linkEmail, dayPrefill])

  const closeDialog = useCallback(() => {
    setEditing(null)
    setDayPrefill('')
    setQuery({ compose: null, linkEmail: null, title: null, clientName: null })
  }, [setQuery])

  /* ---- table ----
   * Sorting is server-side and lives in `?sort=`; `DataTable` gets the same
   * state through `sorting`/`onSortingChange`, so headers are real and the
   * visible page is never re-ordered locally. Only the columns in
   * `TASK_SORT_FIELDS` (taskController.js) get a sortable header — "Assignee"
   * deliberately does not, because the server cannot sort on it. */
  const sorting = useMemo(
    () => [
      {
        id: query.sort.startsWith('-') ? query.sort.slice(1) : query.sort,
        desc: query.sort.startsWith('-'),
      },
    ],
    [query.sort]
  )

  const handleSortingChange = useCallback(
    (next) => {
      const [s] = next
      setQuery({ sort: s ? `${s.desc ? '-' : ''}${s.id}` : QUERY_DEFAULTS.sort, page: 1 })
    },
    [setQuery]
  )

  const columns = useMemo(
    () => [
      {
        accessorKey: 'title',
        header: 'Task',
        /* The row opener — DataTable wraps this cell in a real
         * <button data-row-open>, so the list is keyboard-operable. */
        meta: { primary: true, rowOpener: true },
        cell: ({ row }) => (
          <span className="block min-w-0">
            <span className="block truncate text-sm font-medium leading-4 text-fg">
              {row.original.title}
            </span>
            <span className="block truncate text-2xs leading-4 text-fg-3">
              {row.original.clientName || 'No client'}
            </span>
          </span>
        ),
      },
      {
        id: 'assignedTo',
        /* Not in TASK_SORT_FIELDS — a header here would silently do nothing. */
        enableSorting: false,
        header: 'Assignee',
        meta: { width: '180px' },
        cell: ({ row }) => <AssigneeCell user={row.original.assignedTo} />,
      },
      {
        accessorKey: 'priority',
        header: 'Priority',
        meta: { width: '110px', truncate: false },
        cell: ({ row }) => (
          <Badge size="sm" variant={priorityVariant(row.original.priority)}>
            {row.original.priority || 'Medium'}
          </Badge>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        meta: { width: '110px', truncate: false },
        cell: ({ row }) => (
          <Badge size="sm" variant={statusVariant(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        accessorKey: 'deadline',
        header: 'Due',
        meta: { width: '130px', truncate: false },
        cell: ({ row }) => <DueCell task={row.original} now={now} />,
      },
      {
        id: 'flags',
        header: () => <span className="sr-only">Attributes</span>,
        enableSorting: false,
        meta: { width: '64px', truncate: false },
        cell: ({ row }) => <TaskFlags task={row.original} />,
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        meta: { width: '56px', truncate: false },
        cell: ({ row }) => (
          <RowMenu
            task={row.original}
            perms={perms}
            onOpen={openTask}
            onEdit={startEdit}
            onComplete={completeTask}
            onDelete={deleteTask}
          />
        ),
      },
    ],
    [perms, now, openTask, startEdit, completeTask, deleteTask]
  )

  /* ---- filters ---- */
  const hasFilters = FILTER_KEYS.some((key) => query[key])
  const clearFilters = useCallback(
    () =>
      setQuery({
        status: null,
        priority: null,
        assignee: null,
        creator: null,
        client: null,
        q: null,
        page: 1,
      }),
    [setQuery]
  )

  /* ---- command palette ---- */
  const startCompose = useCallback(() => {
    setEditing(null)
    setDayPrefill('')
    setQuery({ compose: '1' })
  }, [setQuery])

  const showMyOverdue = useCallback(
    () => setQuery({ assignee: user?._id || null, status: 'Late', page: 1 }),
    [setQuery, user]
  )

  useRegisterCommands(
    [
      ...(perms.canCreate
        ? [
            {
              id: 'tasks-new',
              label: 'New task',
              group: 'Tasks',
              icon: <Plus className="h-4 w-4" />,
              keywords: ['create', 'add', 'assign'],
              onSelect: startCompose,
            },
          ]
        : []),
      ...VIEW_OPTIONS.map((option) => ({
        id: `tasks-view-${option.value}`,
        label: `Switch to ${option.label} view`,
        group: 'Tasks',
        icon: <LayoutList className="h-4 w-4" />,
        keywords: ['view', 'layout'],
        onSelect: () => setQuery({ view: option.value, page: 1 }),
      })),
      {
        id: 'tasks-my-overdue',
        label: 'Show my overdue tasks',
        group: 'Tasks',
        icon: <ClipboardList className="h-4 w-4" />,
        keywords: ['late', 'mine', 'due'],
        onSelect: showMyOverdue,
      },
      {
        id: 'tasks-clear-filters',
        label: 'Clear task filters',
        group: 'Tasks',
        icon: <X className="h-4 w-4" />,
        keywords: ['reset', 'all tasks'],
        onSelect: clearFilters,
      },
    ],
    [perms.canCreate, startCompose, setQuery, showMyOverdue, clearFilters]
  )

  const monthAnchor = useMemo(() => {
    const parsed = /^(\d{4})-(\d{2})$/.exec(query.month || '')
    if (!parsed) return new Date(new Date().getFullYear(), new Date().getMonth(), 1)
    return new Date(Number(parsed[1]), Number(parsed[2]) - 1, 1)
  }, [query.month])

  const shiftMonth = (delta) => {
    const base = delta === 0 ? new Date() : new Date(monthAnchor.getFullYear(), monthAnchor.getMonth() + delta, 1)
    setQuery({ month: `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}` })
  }

  const emptyState = hasFilters
    ? {
        icon: Search,
        title: 'No tasks match these filters',
        description: 'Try a wider status or priority, or clear the filters to see everything.',
        secondaryAction: { label: 'Clear filters', onClick: clearFilters },
      }
    : {
        icon: ClipboardList,
        title: 'No tasks yet',
        description: perms.canCreate
          ? 'Create the first task, or turn an email in the inbox into one.'
          : 'Work assigned to you will appear here.',
      }

  const truncatedWideView = wideView && total > rows.length

  return (
    <>
      <PageHeader
        title="Tasks"
        description={
          perms.canCreate ? 'Assign, track and close office work.' : 'Work assigned to you.'
        }
        actions={
          perms.canCreate ? (
            <Button
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={startCompose}
            >
              New task
            </Button>
          ) : null
        }
      />

      <TaskFilters
        query={query}
        setQuery={setQuery}
        options={options}
        canAssign={canAssign}
        hasFilters={hasFilters}
        onClear={clearFilters}
      />

      {/* Containment applies to the list view only: Board columns and the
        * Calendar grid keep <main> as their scroller. */}
      <PageBody fill={query.view === 'list'}>
        {error ? (
          <Alert
            variant="danger"
            title="Could not load tasks"
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

        {truncatedWideView ? (
          <Alert variant="info" title="Showing the first 100 tasks" className="mb-4">
            {formatNumber(total)} tasks match these filters. Narrow the filters, or switch to the
            list view to page through all of them.
          </Alert>
        ) : null}

        {query.view === 'list' ? (
          <>
            {selectedIds.length > 0 && canAssign ? (
              <BulkBar
                selected={selectedIds}
                users={options.users}
                busy={bulkBusy}
                blocked={bulkBlocked}
                onClear={() => setSelection({})}
                onAction={runBulk}
              />
            ) : null}
            <DataTable
              fill
              ariaLabel="Tasks"
              data={rows}
              columns={columns}
              loading={loading}
              enableSelection={canAssign}
              rowSelection={selection}
              onRowSelectionChange={setSelection}
              getRowId={(row) => row._id}
              onRowClick={openTask}
              rowActivation="cell"
              sorting={sorting}
              onSortingChange={handleSortingChange}
              emptyState={emptyState}
              pagination={{
                page: query.page,
                pageSize: query.limit,
                total,
                itemLabel: 'tasks',
                onPageChange: (page) => setQuery({ page }),
                onPageSizeChange: (limit) => setQuery({ limit, page: 1 }),
              }}
            />
          </>
        ) : loading ? (
          <div
            className={cn(
              'grid gap-3',
              query.view === 'board' ? 'grid-cols-1 md:grid-cols-3' : 'grid-cols-1'
            )}
            aria-busy="true"
          >
            {Array.from({ length: query.view === 'board' ? 3 : 1 }, (_, i) => (
              <Skeleton key={i} className={query.view === 'board' ? 'h-[420px]' : 'h-[640px]'} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-line bg-surface">
            <EmptyState {...emptyState} />
          </div>
        ) : query.view === 'board' ? (
          <TaskBoard
            tasks={rows}
            onOpen={openTask}
            onMove={moveTask}
            canMoveTo={(task, status) =>
              perms.canEdit(task) || (status === 'Completed' && perms.canComplete(task))
            }
          />
        ) : (
          <TaskCalendar
            anchor={monthAnchor}
            tasks={rows}
            now={now}
            onOpen={openTask}
            onMonthChange={shiftMonth}
            onPickDay={(date) => {
              if (!perms.canCreate) return
              const at = new Date(date)
              at.setHours(12, 0, 0, 0)
              setEditing(null)
              setDayPrefill(toLocalInput(at))
              setQuery({ compose: '1' })
            }}
          />
        )}
      </PageBody>

      <Drawer open={Boolean(query.task)} onOpenChange={(next) => !next && closeTask()}>
        {query.task ? (
          <TaskDrawerBody
            key={query.task}
            taskId={query.task}
            perms={perms}
            user={user}
            users={options.users}
            now={now}
            onEdit={startEdit}
            onComplete={completeTask}
            onDelete={deleteTask}
            onClose={closeTask}
            onTasksCreated={reload}
          />
        ) : null}
      </Drawer>

      <TaskFormDialog
        key={`${editing?._id || 'new'}-${composing ? 'open' : 'closed'}`}
        open={composing}
        mode={editing ? 'edit' : 'create'}
        initial={dialogInitial}
        options={options}
        saving={saving}
        onSubmit={saveTask}
        onOpenChange={(next) => !next && closeDialog()}
      />
    </>
  )
}
