import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  Clock,
  Download,
  Gauge,
  MessageSquare,
  Pencil,
  Printer,
  RefreshCw,
  Users,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from 'recharts'

import api, { getErrorMessage, isCanceled } from '../../api/axios'
import { useAuth } from '../../components/AuthProvider'
import { useRegisterCommands } from '../../components/CommandRegistry'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  Checkbox,
  Dialog,
  DialogClose,
  DialogContent,
  Drawer,
  DrawerContent,
  EmptyState,
  FormField,
  Input,
  Label,
  PageBody,
  PageHeader,
  Select,
  Skeleton,
  SkeletonTable,
  SkeletonTiles,
  StatTile,
  Table,
  TableContainer,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TBody,
  TD,
  TH,
  THead,
  Toolbar,
  TR,
  toast,
} from '../../components/ui'
import { formatDurationMinutes, formatNumber } from '../../lib/utils'

/* ---------------------------------------------------------------------------
 * Chart colours.
 *
 * Recharts wants a colour string, and a hard-coded hex cannot follow the theme.
 * Every series therefore paints with `fill="currentColor"` and carries a
 * Tailwind text-colour class, so the actual value comes from the CSS variable
 * behind that token and flips with `.dark` on <html> with no JS involved.
 * `chart-1 … chart-6` is the colourblind-tested categorical set from
 * tailwind.config.js; task status uses the semantic success/warning/danger
 * tokens because those carry meaning.
 * ------------------------------------------------------------------------- */
const SERIES = {
  emailsConverted: { label: 'Converted to a task', text: 'text-chart-2', swatch: 'bg-chart-2' },
  emailsOpen: { label: 'Not converted', text: 'text-chart-1', swatch: 'bg-chart-1' },
  tasksCreated: { label: 'Tasks created', text: 'text-chart-1', swatch: 'bg-chart-1' },
  clientEmails: { label: 'Emails received', text: 'text-chart-1', swatch: 'bg-chart-1' },
  clientTasks: { label: 'Tasks raised', text: 'text-chart-2', swatch: 'bg-chart-2' },
  completed: { label: 'Completed', text: 'text-success', swatch: 'bg-success' },
  pending: { label: 'Pending', text: 'text-warning', swatch: 'bg-warning' },
  late: { label: 'Late', text: 'text-danger', swatch: 'bg-danger' },
}

/* F-2. Every SLA figure is a median or a p90 — the server computes NO mean and
 * one must never be implied here, because a single week-old outlier makes an
 * average of response times meaningless. */
const SLA_SERIES = {
  frMedian: { label: 'First response (median)', text: 'text-chart-1', swatch: 'bg-chart-1' },
  frP90: { label: 'First response (p90)', text: 'text-chart-3', swatch: 'bg-chart-3' },
  resMedian: { label: 'Resolution (median)', text: 'text-chart-2', swatch: 'bg-chart-2' },
  resP90: { label: 'Resolution (p90)', text: 'text-chart-4', swatch: 'bg-chart-4' },
}

/** ISO weekday numbers, as `SlaPolicy.businessHours.workingDays` stores them. */
const ISO_DAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
]

/** The backlog metric counts exactly this list, so it links there rather than
 *  duplicating it — there is deliberately no breach-list endpoint. */
const BREACH_LINK = '/inbox?group=thread&unanswered=true'

/* The server clamps ?days= to 1–365; every option here sits inside that. */
const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
  { value: '365', label: 'Last 365 days' },
]

const MIN_DAYS = 1
const MAX_DAYS = 365
const DEFAULT_DAYS = 14

/**
 * S-17: `/reports/employee` used to be `authorizeRoles('Admin')` while every
 * sibling route served Head, so the tab was hidden for a Head. It now serves
 * Head as well, scoped to the tasks that Head created — which is why the tab is
 * available to both roles and labelled differently for each.
 */
const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'email', label: 'Email volume' },
  { value: 'sla', label: 'SLA' },
  { value: 'employees', label: 'Employee performance' },
  { value: 'clients', label: 'Clients' },
]

function clampDays(raw) {
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_DAYS
  return Math.min(Math.max(n, MIN_DAYS), MAX_DAYS)
}

function toList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10)
}

/** Excel treats a leading =/+/-/@ as a formula, quoted or not. */
function csvCell(value) {
  const s = String(value ?? '')
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s
  return `"${safe.replace(/"/g, '""')}"`
}

function downloadCsv(filename, headers, rows) {
  const csv = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join(
    '\n'
  )
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // The previous export leaked every object URL it ever created.
  URL.revokeObjectURL(url)
}

function applySort(rows, sort) {
  if (!sort) return rows
  const desc = sort.startsWith('-')
  const key = desc ? sort.slice(1) : sort
  return [...rows].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    const cmp =
      typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''))
    return desc ? -cmp : cmp
  })
}

function sortState(sort, key) {
  if (sort === key) return 'asc'
  if (sort === `-${key}`) return 'desc'
  return false
}

/**
 * Minutes -> "2h 15m".
 *
 * The SLA endpoints answer in minutes (`unit: "minutes"`) as a number with one
 * decimal, or `null` when there is nothing to measure. `null` must never be
 * rendered as `0`, so this returns `null` and every caller decides what "not
 * measured" looks like on screen.
 */
/** `0.333` -> `33.3%`. `count === 0` makes the server report `0`, not a rate. */
function formatRate(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${formatNumber(n * 100, { maximumFractionDigits: 1 })}%`
}

/**
 * A metric cell that refuses to invent a zero.
 *
 * The empty state is an em-dash with the full wording in a `title`, matching
 * the tiles above. Spelling out "Not measured" here read as "Not measur…" at
 * every viewport — the numeric columns are sized for durations, and `TD`
 * truncates by default — so the ellipsis was the only thing that ever changed
 * between "no data" and a real value. The footnote under the table carries the
 * explanation in full.
 */
function MetricValue({ minutes }) {
  const text = formatDurationMinutes(minutes)
  return text ? (
    <span className="tabular">{text}</span>
  ) : (
    <span className="text-fg-3" title="Not measured — no conversations in this range">
      —<span className="sr-only">Not measured</span>
    </span>
  )
}

/* --- chart chrome --------------------------------------------------------- */

/**
 * A surface card, not a dark blurred pill.
 *
 * `format` defaults to `formatNumber` so every existing caller is unchanged;
 * the SLA charts pass a minutes formatter because "310" is not a readable
 * response time.
 */
function ChartTooltip({ active, payload, label, format = formatNumber }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 shadow-md">
      <p className="text-xs font-semibold text-fg">{label}</p>
      <ul className="mt-1 space-y-0.5">
        {payload.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-xs text-fg-2">
            <span
              aria-hidden="true"
              className={`h-2 w-2 shrink-0 rounded-sm ${
                entry.payload?.__swatch?.[entry.name] || entry.payload?.swatch || 'bg-fg-3'
              }`}
            />
            <span className="flex-1">{entry.name}</span>
            <span className="font-medium tabular text-fg">{format(entry.value) ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ChartLegend({ items }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-fg-2">
          <span aria-hidden="true" className={`h-2 w-2 rounded-sm ${item.swatch}`} />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/**
 * Chart shell: title, legend, loading, empty and error states in one place so
 * every panel on the page behaves identically.
 */
function ChartPanel({
  title,
  description,
  legend,
  loading,
  error,
  isEmpty,
  emptyTitle,
  emptyDescription,
  ariaLabel,
  actions,
  children,
}) {
  return (
    <Card className="print:break-inside-avoid">
      <CardHeader
        title={title}
        description={description}
        actions={
          <div className="flex items-center gap-3">
            {legend ? <ChartLegend items={legend} /> : null}
            {actions}
          </div>
        }
      />
      <CardBody className={loading || isEmpty || error ? 'p-0' : undefined}>
        {error ? (
          <Alert variant="danger" title="Could not load this chart" className="m-4">
            {error}
          </Alert>
        ) : loading ? (
          <div className="space-y-3 p-4" role="status" aria-label={`Loading ${title}`}>
            <Skeleton className="h-[264px] w-full rounded-md" />
          </div>
        ) : isEmpty ? (
          <EmptyState
            icon={BarChart3}
            title={emptyTitle || 'No data in this range'}
            description={emptyDescription || 'Widen the date range or pick another scope.'}
          />
        ) : (
          <div role="img" aria-label={ariaLabel} className="h-[300px] w-full">
            {children}
          </div>
        )}
      </CardBody>
    </Card>
  )
}

const AXIS_CLASS = 'text-fg-3'
const GRID_CLASS = 'text-line'

/* -------------------------------------------------------------------------- */
/* F-2 — SLA pieces                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The edit form for `PUT /api/reports/sla/policy` — Admin only.
 *
 * Server validation (`slaPolicySchema`): each target is a whole number of
 * minutes between 1 and one year, and business hours must end after they
 * start. The same bounds are enforced here so the common mistake is caught
 * before the round trip, never instead of it.
 */
function SlaPolicyDialog({ open, onOpenChange, policy, onSaved }) {
  const blank = {
    firstResponseMinutes: 240,
    resolutionMinutes: 1440,
    enabled: false,
    startHour: 9,
    endHour: 18,
    workingDays: [1, 2, 3, 4, 5],
  }
  const [form, setForm] = useState(blank)
  const [saving, setSaving] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)

  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      const hours = policy?.businessHours || {}
      setForm({
        firstResponseMinutes: policy?.firstResponseMinutes ?? blank.firstResponseMinutes,
        resolutionMinutes: policy?.resolutionMinutes ?? blank.resolutionMinutes,
        enabled: Boolean(hours.enabled),
        startHour: hours.startHour ?? blank.startHour,
        endHour: hours.endHour ?? blank.endHour,
        workingDays: hours.workingDays?.length ? [...hours.workingDays] : [...blank.workingDays],
      })
    }
  }

  const set = (patch) => setForm((prev) => ({ ...prev, ...patch }))

  const first = Number(form.firstResponseMinutes)
  const resolution = Number(form.resolutionMinutes)
  const inRange = (n) => Number.isInteger(n) && n >= 1 && n <= 60 * 24 * 365
  const errors = {
    firstResponseMinutes: inRange(first)
      ? ''
      : 'A whole number of minutes between 1 and 525,600.',
    resolutionMinutes: inRange(resolution) ? '' : 'A whole number of minutes between 1 and 525,600.',
    endHour:
      form.enabled && Number(form.endHour) <= Number(form.startHour)
        ? 'Business hours must end after they start.'
        : '',
    workingDays: form.enabled && form.workingDays.length === 0 ? 'Pick at least one day.' : '',
  }
  const valid = Object.values(errors).every((e) => !e)

  const submit = async () => {
    if (!valid) return
    setSaving(true)
    try {
      const res = await api.put('/reports/sla/policy', {
        firstResponseMinutes: first,
        resolutionMinutes: resolution,
        businessHours: {
          enabled: form.enabled,
          startHour: Number(form.startHour),
          endHour: Number(form.endHour),
          workingDays: [...form.workingDays].sort((a, b) => a - b),
          // `null` means "inherit APP_TIMEZONE" — the zone is a server concern.
          timezone: null,
        },
      })
      toast.success(res.data?.message || 'SLA policy updated')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error('Could not update the SLA policy', { description: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        title="Workspace SLA targets"
        description="These targets decide what counts as a breach. Changing them re-scores every conversation on the next request."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={saving} disabled={!valid} onClick={submit}>
              Save targets
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="First response"
              required
              hint={
                formatDurationMinutes(first)
                  ? `Minutes — currently ${formatDurationMinutes(first)}`
                  : 'Minutes'
              }
              error={errors.firstResponseMinutes}
            >
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min={1}
                  max={525600}
                  value={form.firstResponseMinutes}
                  onChange={(e) => set({ firstResponseMinutes: e.target.value })}
                />
              )}
            </FormField>
            <FormField
              label="Resolution"
              required
              hint={
                formatDurationMinutes(resolution)
                  ? `Minutes — currently ${formatDurationMinutes(resolution)}`
                  : 'Minutes'
              }
              error={errors.resolutionMinutes}
            >
              {(field) => (
                <Input
                  {...field}
                  type="number"
                  min={1}
                  max={525600}
                  value={form.resolutionMinutes}
                  onChange={(e) => set({ resolutionMinutes: e.target.value })}
                />
              )}
            </FormField>
          </div>

          <Checkbox
            id="sla-business-hours"
            label="Count working hours only"
            description="Off by default. When on, elapsed time skips evenings and non-working days."
            checked={form.enabled}
            onCheckedChange={(checked) => set({ enabled: checked === true })}
          />

          {form.enabled ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Day starts at" hint="Hour of the day, 0–23">
                  {(field) => (
                    <Input
                      {...field}
                      type="number"
                      min={0}
                      max={23}
                      value={form.startHour}
                      onChange={(e) => set({ startHour: e.target.value })}
                    />
                  )}
                </FormField>
                <FormField
                  label="Day ends at"
                  hint="Hour of the day, 1–24, exclusive"
                  error={errors.endHour}
                >
                  {(field) => (
                    <Input
                      {...field}
                      type="number"
                      min={1}
                      max={24}
                      value={form.endHour}
                      onChange={(e) => set({ endHour: e.target.value })}
                    />
                  )}
                </FormField>
              </div>

              <fieldset>
                <legend className="text-xs font-medium text-fg-2">Working days</legend>
                {errors.workingDays ? (
                  <p className="mt-1 text-xs text-danger-text">{errors.workingDays}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {ISO_DAYS.map((day) => (
                    <Checkbox
                      key={day.value}
                      id={`sla-day-${day.value}`}
                      label={day.label}
                      checked={form.workingDays.includes(day.value)}
                      onCheckedChange={(checked) =>
                        set({
                          workingDays:
                            checked === true
                              ? [...form.workingDays, day.value]
                              : form.workingDays.filter((d) => d !== day.value),
                        })
                      }
                    />
                  ))}
                </div>
              </fieldset>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The active targets, shown beside the numbers.
 *
 * A percentile without its target is not actionable: "p90 is 5h" only means
 * something next to "the target is 4h".
 */
function SlaPolicyCard({ policy, overrides, canEdit, onEdit }) {
  const hours = policy?.businessHours || {}
  const workingDays = hours.workingDays || []

  return (
    <Card className="print:break-inside-avoid">
      <CardHeader
        title="Active targets"
        description={
          policy?.source === 'global'
            ? 'Saved for this workspace'
            : 'Server defaults — no workspace policy has been saved yet'
        }
        actions={
          canEdit ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<Pencil className="h-4 w-4" />}
              onClick={onEdit}
              className="print:hidden"
            >
              Edit targets
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className="text-fg-3">First response</dt>
          <dd className="text-fg-2">
            <MetricValue minutes={policy?.firstResponseMinutes} />
          </dd>
          <dt className="text-fg-3">Resolution</dt>
          <dd className="text-fg-2">
            <MetricValue minutes={policy?.resolutionMinutes} />
          </dd>
          <dt className="text-fg-3">Working hours</dt>
          <dd className="text-fg-2">
            {hours.enabled
              ? `${String(hours.startHour).padStart(2, '0')}:00–${String(hours.endHour).padStart(2, '0')}:00 · ${
                  ISO_DAYS.filter((d) => workingDays.includes(d.value))
                    .map((d) => d.label)
                    .join(', ') || 'no days selected'
                }`
              : 'Off — elapsed time is counted around the clock'}
          </dd>
          <dt className="text-fg-3">Timezone</dt>
          <dd className="font-mono text-xs text-fg-2">{hours.timezone || 'Server default'}</dd>
        </dl>

        {overrides?.length ? (
          <div>
            <p className="text-xs font-medium text-fg-2">
              Per-client overrides ({formatNumber(overrides.length)})
            </p>
            <ul className="mt-1.5 divide-y divide-line rounded-md border border-line">
              {overrides.map((row) => (
                <li key={row.clientId} className="flex items-center justify-between gap-3 px-3 py-2">
                  <span className="min-w-0 truncate text-sm text-fg-2">
                    {row.clientName || 'Unnamed client'}
                  </span>
                  <span className="shrink-0 text-xs text-fg-3 tabular">
                    {formatDurationMinutes(row.firstResponseMinutes) || 'inherits'} ·{' '}
                    {formatDurationMinutes(row.resolutionMinutes) || 'inherits'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!canEdit ? (
          <p className="text-xs text-fg-3">
            Targets are set by an administrator. You can read them here but not change them.
          </p>
        ) : null}
      </CardBody>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

export default function Reports() {
  const { isAdmin, isHead } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const canView = isAdmin || isHead

  /* --- URL state --------------------------------------------------------- */
  const tabParam = searchParams.get('tab')
  const tab = TABS.some((t) => t.value === tabParam) ? tabParam : 'overview'
  const days = clampDays(searchParams.get('days'))
  const userId = searchParams.get('user') || ''
  const employeeSort = searchParams.get('esort') || '-totalAssigned'
  const clientSort = searchParams.get('csort') || '-emailCount'

  /* The employee endpoint only understands a 7-day or a 30-day window. */
  const employeeFilter = days <= 7 ? 'weekly' : 'monthly'

  const setParam = useCallback(
    (patch) => {
      const params = new URLSearchParams(searchParams)
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined || value === '') params.delete(key)
        else params.set(key, String(value))
      }
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  /* The range only drives the two windowed reports, so the palette offers it
   * exactly where the visible control appears — a command that changed nothing
   * on screen would be worse than no command. */
  const rangeApplies = tab === 'email' || tab === 'employees' || tab === 'sla'

  useRegisterCommands(
    [
      {
        id: 'reports-open-sla',
        label: 'Open the SLA report',
        group: 'Reports',
        icon: <Gauge className="h-4 w-4" />,
        keywords: ['response time', 'breach', 'median', 'p90', 'backlog'],
        onSelect: () => setParam({ tab: 'sla' }),
      },
      ...(rangeApplies
        ? RANGE_OPTIONS.map((option) => ({
            id: `reports-range-${option.value}`,
            label: `Report range: ${option.label}`,
            group: 'Reports',
            icon: <CalendarDays className="h-4 w-4" />,
            keywords: ['date', 'window', 'period', 'days'],
            onSelect: () => setParam({ days: clampDays(option.value) }),
          }))
        : []),
    ],
    [rangeApplies, setParam]
  )

  /* --- data -------------------------------------------------------------- */
  const [stats, setStats] = useState(null)
  const [taskTimeline, setTaskTimeline] = useState([])
  const [clientStats, setClientStats] = useState([])
  const [employees, setEmployees] = useState([])
  const [coreLoading, setCoreLoading] = useState(true)
  const [coreError, setCoreError] = useState(null)

  const [emailTimeline, setEmailTimeline] = useState([])
  const [emailLoading, setEmailLoading] = useState(true)
  const [emailError, setEmailError] = useState(null)

  const [employeeRows, setEmployeeRows] = useState([])
  const [employeeLoading, setEmployeeLoading] = useState(canView)
  const [employeeError, setEmployeeError] = useState(null)

  /* F-2. Fetched only while the SLA tab is on screen — three requests behind a
   * tab nobody opened is exactly the kind of cost this page does not need. */
  const [slaSummary, setSlaSummary] = useState(null)
  const [slaBuckets, setSlaBuckets] = useState([])
  const [slaPolicy, setSlaPolicy] = useState(null)
  const [slaLoading, setSlaLoading] = useState(true)
  const [slaError, setSlaError] = useState(null)
  const [policyOpen, setPolicyOpen] = useState(false)

  const [drawerRow, setDrawerRow] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  /* Overall stats, task timeline, client stats and the employee picker are
   * independent — they go out together instead of in a four-deep waterfall. */
  useEffect(() => {
    if (!canView) return undefined
    const ctrl = new AbortController()
    const { signal } = ctrl

    const requests = [
      api.get('/reports/overall', { signal }),
      api.get('/reports/timeline', { signal }),
      api.get('/reports/client-stats', { signal }),
    ]
    // /users is Admin+Head, but the employee scope picker only drives the
    // Admin-only performance report.
    if (isAdmin) requests.push(api.get('/users', { signal }))

    Promise.allSettled(requests).then((results) => {
      if (signal.aborted || results.some((r) => r.status === 'rejected' && isCanceled(r.reason))) {
        return
      }
      const [overallRes, timelineRes, clientRes, usersRes] = results

      const failure = [overallRes, timelineRes, clientRes].find((r) => r.status === 'rejected')
      setCoreError(failure ? getErrorMessage(failure.reason, 'Could not load report data.') : null)

      if (overallRes.status === 'fulfilled') setStats(overallRes.value.data)
      if (timelineRes.status === 'fulfilled') setTaskTimeline(toList(timelineRes.value.data))
      if (clientRes.status === 'fulfilled') setClientStats(toList(clientRes.value.data))
      if (usersRes?.status === 'fulfilled') {
        setEmployees(toList(usersRes.value.data).filter((u) => u.role !== 'Admin'))
      }
      setCoreLoading(false)
    })

    return () => ctrl.abort()
  }, [canView, isAdmin, reloadKey])

  useEffect(() => {
    if (!canView) return undefined
    const ctrl = new AbortController()
    api
      .get('/reports/email-timeline', { params: { days }, signal: ctrl.signal })
      .then((res) => {
        setEmailTimeline(toList(res.data))
        setEmailError(null)
        setEmailLoading(false)
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setEmailError(getErrorMessage(err, 'Could not load the email timeline.'))
        setEmailLoading(false)
      })
    return () => ctrl.abort()
  }, [canView, days, reloadKey])

  // S-17: served to Head as well. The server narrows a Head's report to the
  // tasks they created, so a Head sees their own delegations, not the office.
  useEffect(() => {
    if (!canView) return undefined
    const ctrl = new AbortController()
    api
      .get('/reports/employee', {
        params: { filter: employeeFilter, userId: userId || undefined },
        signal: ctrl.signal,
      })
      .then((res) => {
        setEmployeeRows(toList(res.data))
        setEmployeeError(null)
        setEmployeeLoading(false)
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setEmployeeError(getErrorMessage(err, 'Could not generate the performance report.'))
        setEmployeeLoading(false)
      })
    return () => ctrl.abort()
  }, [canView, employeeFilter, userId, reloadKey])

  /* The SLA endpoints take an explicit ISO range rather than `?days=`, so the
   * one visible range control is translated instead of a second one appearing.
   * Recomputed only when `days` changes — a per-render `new Date()` would make
   * the effect below fire forever. */
  const slaRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - days * 86400000)
    return { dateFrom: from.toISOString(), dateTo: to.toISOString() }
  }, [days])

  useEffect(() => {
    if (!canView || tab !== 'sla') return undefined
    const ctrl = new AbortController()
    const { signal } = ctrl

    Promise.allSettled([
      api.get('/reports/sla', { params: slaRange, signal }),
      api.get('/reports/sla/timeseries', { params: slaRange, signal }),
      api.get('/reports/sla/policy', { signal }),
    ]).then((results) => {
      if (signal.aborted || results.some((r) => r.status === 'rejected' && isCanceled(r.reason))) {
        return
      }
      const [summaryRes, seriesRes, policyRes] = results

      const failure = [summaryRes, seriesRes, policyRes].find((r) => r.status === 'rejected')
      setSlaError(failure ? getErrorMessage(failure.reason, 'Could not load SLA statistics.') : null)

      if (summaryRes.status === 'fulfilled') setSlaSummary(summaryRes.value.data ?? null)
      if (seriesRes.status === 'fulfilled') setSlaBuckets(seriesRes.value.data?.buckets ?? [])
      if (policyRes.status === 'fulfilled') setSlaPolicy(policyRes.value.data ?? null)
      setSlaLoading(false)
    })

    return () => ctrl.abort()
  }, [canView, tab, slaRange, reloadKey])

  const refresh = useCallback(() => {
    setCoreLoading(true)
    setEmailLoading(true)
    setEmployeeLoading(true)
    setSlaLoading(true)
    setReloadKey((n) => n + 1)
  }, [])

  /* --- chart data -------------------------------------------------------- */
  const emailChartData = useMemo(
    () =>
      emailTimeline.map((d) => ({
        label: d.label || d.date,
        [SERIES.emailsConverted.label]: d.assignedCount || 0,
        [SERIES.emailsOpen.label]: Math.max(0, (d.count || 0) - (d.assignedCount || 0)),
        __swatch: {
          [SERIES.emailsConverted.label]: SERIES.emailsConverted.swatch,
          [SERIES.emailsOpen.label]: SERIES.emailsOpen.swatch,
        },
      })),
    [emailTimeline]
  )

  const emailTotals = useMemo(() => {
    const received = emailTimeline.reduce((sum, d) => sum + (d.count || 0), 0)
    const converted = emailTimeline.reduce((sum, d) => sum + (d.assignedCount || 0), 0)
    const peak = emailTimeline.reduce((max, d) => Math.max(max, d.count || 0), 0)
    const perDay = emailTimeline.length > 0 ? received / emailTimeline.length : 0
    return { received, converted, peak, perDay }
  }, [emailTimeline])

  const taskChartData = useMemo(
    () =>
      taskTimeline.map((d) => ({
        label: d.date ? d.date.slice(5) : '',
        [SERIES.tasksCreated.label]: d.count || 0,
        __swatch: { [SERIES.tasksCreated.label]: SERIES.tasksCreated.swatch },
      })),
    [taskTimeline]
  )

  const statusData = useMemo(() => {
    if (!stats) return []
    return [
      { ...SERIES.completed, name: SERIES.completed.label, value: stats.totalCompleted || 0 },
      { ...SERIES.pending, name: SERIES.pending.label, value: stats.totalPending || 0 },
      { ...SERIES.late, name: SERIES.late.label, value: stats.totalLate || 0 },
    ].filter((d) => d.value > 0)
  }, [stats])

  const workloadData = useMemo(
    () =>
      applySort(employeeRows, '-totalAssigned')
        .slice(0, 12)
        .map((row) => ({
          label: row.employeeName,
          [SERIES.completed.label]: row.totalCompleted || 0,
          [SERIES.pending.label]: row.totalPending || 0,
          [SERIES.late.label]: row.totalLate || 0,
          __swatch: {
            [SERIES.completed.label]: SERIES.completed.swatch,
            [SERIES.pending.label]: SERIES.pending.swatch,
            [SERIES.late.label]: SERIES.late.swatch,
          },
        })),
    [employeeRows]
  )

  const clientChartData = useMemo(
    () =>
      applySort(clientStats, '-emailCount')
        .slice(0, 12)
        .map((c) => ({
          label: c.name,
          [SERIES.clientEmails.label]: c.emailCount || 0,
          [SERIES.clientTasks.label]: c.taskCount || 0,
          __swatch: {
            [SERIES.clientEmails.label]: SERIES.clientEmails.swatch,
            [SERIES.clientTasks.label]: SERIES.clientTasks.swatch,
          },
        })),
    [clientStats]
  )

  /* Zero-filled daily buckets. An empty day reports `null` medians and `0`
   * counts, and the chart renders the GAP — `connectNulls` is off, because a
   * line drawn straight through a day with no data invents a measurement. */
  const slaChartData = useMemo(
    () =>
      slaBuckets.map((bucket) => ({
        label: bucket.label || bucket.date,
        [SLA_SERIES.frMedian.label]: bucket.firstResponseMedian,
        [SLA_SERIES.frP90.label]: bucket.firstResponseP90,
        [SLA_SERIES.resMedian.label]: bucket.resolutionMedian,
        [SLA_SERIES.resP90.label]: bucket.resolutionP90,
        __swatch: {
          [SLA_SERIES.frMedian.label]: SLA_SERIES.frMedian.swatch,
          [SLA_SERIES.frP90.label]: SLA_SERIES.frP90.swatch,
          [SLA_SERIES.resMedian.label]: SLA_SERIES.resMedian.swatch,
          [SLA_SERIES.resP90.label]: SLA_SERIES.resP90.swatch,
        },
      })),
    [slaBuckets]
  )

  const slaHasFirstResponse = useMemo(
    () => slaBuckets.some((b) => (b.firstResponseCount || 0) > 0),
    [slaBuckets]
  )
  const slaHasResolution = useMemo(
    () => slaBuckets.some((b) => (b.resolutionCount || 0) > 0),
    [slaBuckets]
  )

  /* The three metric blocks, in the order the server documents them. */
  const slaRows = useMemo(
    () => [
      {
        key: 'firstResponse',
        label: 'First response',
        description: 'Earliest reply we sent, minus the first inbound message',
        metric: slaSummary?.firstResponse,
        target: slaSummary?.policy?.firstResponseMinutes,
      },
      {
        key: 'resolution',
        label: 'Resolution',
        description: "Linked task's completion, minus the conversation's first inbound",
        metric: slaSummary?.resolution,
        target: slaSummary?.policy?.resolutionMinutes,
      },
      {
        key: 'backlog',
        label: 'Backlog age',
        description: 'Now, minus the first inbound of a conversation still awaiting a reply',
        metric: slaSummary?.backlog,
        target: slaSummary?.policy?.firstResponseMinutes,
      },
    ],
    [slaSummary]
  )

  const sortedEmployees = useMemo(
    () => applySort(employeeRows, employeeSort),
    [employeeRows, employeeSort]
  )
  const sortedClients = useMemo(() => applySort(clientStats, clientSort), [clientStats, clientSort])

  /* --- exports ----------------------------------------------------------- */
  const exportEmployeesCsv = useCallback(() => {
    if (sortedEmployees.length === 0) {
      toast.warning('Nothing to export in this range')
      return
    }
    downloadCsv(
      `performance-report_${employeeFilter}_${todayStamp()}.csv`,
      [
        'Employee',
        'Email',
        'Role',
        'Assigned',
        'Completed',
        'Pending',
        'Late',
        'Completion rate (%)',
      ],
      sortedEmployees.map((r) => [
        r.employeeName,
        r.employeeEmail,
        r.employeeRole,
        r.totalAssigned,
        r.totalCompleted,
        r.totalPending,
        r.totalLate,
        r.completionRate,
      ])
    )
    toast.success('Performance report exported')
  }, [sortedEmployees, employeeFilter])

  const exportClientsCsv = useCallback(() => {
    if (sortedClients.length === 0) {
      toast.warning('Nothing to export')
      return
    }
    downloadCsv(
      `client-report_${todayStamp()}.csv`,
      ['Client', 'Emails received', 'Tasks raised', 'Tasks completed'],
      sortedClients.map((c) => [c.name, c.emailCount, c.taskCount, c.completedTaskCount])
    )
    toast.success('Client report exported')
  }, [sortedClients])

  if (!canView) {
    return (
      <>
        <PageHeader title="Reports" />
        <PageBody>
          <Alert variant="warning" title="Reports are not available for your role">
            Ask an administrator if you need access to office-wide analytics.
          </Alert>
        </PageBody>
      </>
    )
  }

  const rangeLabel = RANGE_OPTIONS.find((o) => o.value === String(days))?.label || `Last ${days} days`

  return (
    <>
      <PageHeader
        title="Reports"
        description={
          isHead && !isAdmin
            ? 'Scoped to the mailboxes and tasks you own'
            : 'Office-wide task, mail and client analytics'
        }
        actions={
          <div className="flex items-center gap-2 print:hidden">
            <Button
              variant="secondary"
              leftIcon={<RefreshCw className="h-4 w-4" />}
              onClick={refresh}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              leftIcon={<Printer className="h-4 w-4" />}
              onClick={() => window.print()}
            >
              Print
            </Button>
          </div>
        }
      />

      <Tabs value={tab} onValueChange={(value) => setParam({ tab: value })}>
        <Toolbar
          className="print:hidden"
          left={
            <TabsList className="border-b-0">
              {TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          }
          right={
            <>
              {/* The range only drives the two windowed reports — showing it on a
                  tab it cannot affect would be a lie about what the page is doing. */}
              {rangeApplies ? (
                <>
                  <Label htmlFor="report-range" className="sr-only">
                    Date range
                  </Label>
                  <Select
                    id="report-range"
                    size="sm"
                    className="w-[150px]"
                    value={String(days)}
                    onChange={(e) => setParam({ days: clampDays(e.target.value) })}
                    options={RANGE_OPTIONS}
                  />
                </>
              ) : null}
              {isAdmin && tab === 'employees' ? (
                <>
                  <Label htmlFor="report-scope" className="sr-only">
                    Employee scope
                  </Label>
                  <Select
                    id="report-scope"
                    size="sm"
                    className="w-[190px]"
                    value={userId}
                    onChange={(e) => setParam({ user: e.target.value })}
                    options={[
                      { value: '', label: 'All employees and heads' },
                      ...employees.map((u) => ({ value: u._id, label: `${u.name} (${u.role})` })),
                    ]}
                  />
                </>
              ) : null}
            </>
          }
        />

        <PageBody className="space-y-5">
          {coreError ? (
            <Alert
              variant="danger"
              title="Could not load report data"
              action={
                <Button size="sm" onClick={refresh}>
                  Retry
                </Button>
              }
            >
              {coreError}
            </Alert>
          ) : null}

          {/* KPI strip — identical treatment on every tile, no accent borders. */}
          {coreLoading ? (
            <SkeletonTiles count={6} className="grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" />
          ) : (
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6 print:grid-cols-6">
              <StatTile label="People" value={formatNumber(stats?.totalUsers ?? 0)} />
              <StatTile label="Clients" value={formatNumber(stats?.totalClients ?? 0)} />
              <StatTile
                label="Emails"
                value={formatNumber(stats?.totalEmails ?? 0)}
                hint={`${formatNumber(stats?.totalUnassignedEmails ?? 0)} unassigned`}
              />
              <StatTile label="Tasks" value={formatNumber(stats?.totalTasks ?? 0)} />
              <StatTile
                label="Completed"
                value={formatNumber(stats?.totalCompleted ?? 0)}
                hint={
                  stats?.totalTasks
                    ? `${Math.round(((stats.totalCompleted || 0) / stats.totalTasks) * 100)}% of all tasks`
                    : undefined
                }
              />
              <StatTile
                label="Overdue"
                value={formatNumber(stats?.totalLate ?? 0)}
                tone={(stats?.totalLate ?? 0) > 0 ? 'danger' : 'default'}
              />
            </div>
          )}

          {/* ---------------- Overview ---------------- */}
          <TabsContent value="overview" className="space-y-5">
            <div className="grid gap-5 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <ChartPanel
                  title="Task throughput"
                  description="Tasks created per day, last 30 days"
                  legend={[SERIES.tasksCreated]}
                  loading={coreLoading}
                  isEmpty={taskChartData.every((d) => d[SERIES.tasksCreated.label] === 0)}
                  emptyTitle="No tasks created in the last 30 days"
                  emptyDescription="Tasks raised from the inbox or by hand will chart here."
                  ariaLabel={`Bar chart of tasks created per day over the last 30 days. Total ${formatNumber(
                    taskTimeline.reduce((s, d) => s + (d.count || 0), 0)
                  )} tasks.`}
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={taskChartData} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                      <CartesianGrid
                        className={GRID_CLASS}
                        stroke="currentColor"
                        strokeDasharray="3 3"
                        vertical={false}
                      />
                      <XAxis
                        dataKey="label"
                        className={AXIS_CLASS}
                        stroke="currentColor"
                        tick={{ fill: 'currentColor', fontSize: 11 }}
                        tickLine={false}
                        interval="preserveStartEnd"
                        minTickGap={16}
                      />
                      <YAxis
                        className={AXIS_CLASS}
                        stroke="currentColor"
                        tick={{ fill: 'currentColor', fontSize: 11 }}
                        tickLine={false}
                        allowDecimals={false}
                        width={44}
                      />
                      <RechartsTooltip
                        content={<ChartTooltip />}
                        cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                      />
                      <Bar
                        dataKey={SERIES.tasksCreated.label}
                        className={SERIES.tasksCreated.text}
                        fill="currentColor"
                        radius={[2, 2, 0, 0]}
                        maxBarSize={22}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartPanel>
              </div>

              <ChartPanel
                title="Task status"
                description="Share of all tasks by status"
                legend={[SERIES.completed, SERIES.pending, SERIES.late]}
                loading={coreLoading}
                isEmpty={statusData.length === 0}
                emptyTitle="No tasks yet"
                emptyDescription="Status distribution appears once tasks exist."
                ariaLabel={`Donut chart of task status. ${statusData
                  .map((d) => `${d.name}: ${d.value}`)
                  .join(', ')}.`}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={statusData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="55%"
                      outerRadius="80%"
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {statusData.map((entry) => (
                        <Cell key={entry.name} className={entry.text} fill="currentColor" />
                      ))}
                    </Pie>
                    <RechartsTooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
              </ChartPanel>
            </div>

            <ChartPanel
              title="Client volume"
              description="Top 12 clients by mail received"
              legend={[SERIES.clientEmails, SERIES.clientTasks]}
              loading={coreLoading}
              isEmpty={clientChartData.length === 0}
              emptyTitle="No client activity"
              emptyDescription="Link email addresses to a client to see volume here."
              ariaLabel={`Horizontal bar chart comparing emails received and tasks raised for the top ${clientChartData.length} clients.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={clientChartData}
                  layout="vertical"
                  margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    className={GRID_CLASS}
                    stroke="currentColor"
                    strokeDasharray="3 3"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    width={140}
                  />
                  <RechartsTooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                  />
                  <Bar
                    dataKey={SERIES.clientEmails.label}
                    className={SERIES.clientEmails.text}
                    fill="currentColor"
                    radius={[0, 2, 2, 0]}
                    maxBarSize={12}
                  />
                  <Bar
                    dataKey={SERIES.clientTasks.label}
                    className={SERIES.clientTasks.text}
                    fill="currentColor"
                    radius={[0, 2, 2, 0]}
                    maxBarSize={12}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </TabsContent>

          {/* ---------------- Email volume ---------------- */}
          <TabsContent value="email" className="space-y-5">
            {emailLoading ? (
              <SkeletonTiles count={4} className="grid-cols-2 xl:grid-cols-4" />
            ) : (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                <StatTile
                  label="Received"
                  value={formatNumber(emailTotals.received)}
                  hint={rangeLabel.toLowerCase()}
                />
                <StatTile
                  label="Converted to tasks"
                  value={formatNumber(emailTotals.converted)}
                  hint={
                    emailTotals.received > 0
                      ? `${Math.round((emailTotals.converted / emailTotals.received) * 100)}% conversion`
                      : undefined
                  }
                />
                <StatTile
                  label="Daily average"
                  value={formatNumber(emailTotals.perDay, { maximumFractionDigits: 1 })}
                  hint="emails per day"
                />
                <StatTile
                  label="Peak day"
                  value={formatNumber(emailTotals.peak)}
                  hint="highest single-day volume"
                />
              </div>
            )}

            <ChartPanel
              title="Email volume"
              description={`Received per day, split by conversion — ${rangeLabel.toLowerCase()}`}
              legend={[SERIES.emailsOpen, SERIES.emailsConverted]}
              loading={emailLoading}
              error={emailError}
              isEmpty={emailTotals.received === 0}
              emptyTitle="No mail in this range"
              emptyDescription="Pick a wider date range, or sync the mailbox from the inbox."
              ariaLabel={`Stacked bar chart of emails received per day for the ${rangeLabel.toLowerCase()}. ${formatNumber(
                emailTotals.received
              )} received, ${formatNumber(emailTotals.converted)} converted to tasks.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={emailChartData} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
                  <CartesianGrid
                    className={GRID_CLASS}
                    stroke="currentColor"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    allowDecimals={false}
                    width={44}
                  />
                  <RechartsTooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                  />
                  <Bar
                    dataKey={SERIES.emailsOpen.label}
                    stackId="mail"
                    className={SERIES.emailsOpen.text}
                    fill="currentColor"
                    maxBarSize={22}
                  />
                  <Bar
                    dataKey={SERIES.emailsConverted.label}
                    stackId="mail"
                    className={SERIES.emailsConverted.text}
                    fill="currentColor"
                    radius={[2, 2, 0, 0]}
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>
          </TabsContent>

          {/* ---------------- SLA (F-2) ---------------- */}
          <TabsContent value="sla" className="space-y-5">
            {/* Same honesty as the employee tab: a Head's numbers are their
                own mailbox and their own tasks, never the office. */}
            {slaSummary?.scope === 'mine' ? (
              <Alert variant="info" title="Your mailbox only">
                These figures cover the conversations in the mailboxes you own and the tasks you
                created — not the whole office.
              </Alert>
            ) : null}

            {slaError ? (
              <Alert
                variant="danger"
                title="Could not load SLA statistics"
                action={
                  <Button size="sm" onClick={refresh}>
                    Retry
                  </Button>
                }
              >
                {slaError}
              </Alert>
            ) : null}

            {slaLoading ? (
              <SkeletonTiles count={6} className="grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" />
            ) : (
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6 print:grid-cols-6">
                <StatTile
                  icon={<Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="First response · median"
                  value={formatDurationMinutes(slaSummary?.firstResponse?.median) ?? '—'}
                  hint={
                    formatDurationMinutes(slaSummary?.policy?.firstResponseMinutes)
                      ? `Target ${formatDurationMinutes(slaSummary.policy.firstResponseMinutes)}`
                      : 'No target set'
                  }
                />
                <StatTile
                  icon={<Gauge aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="First response · p90"
                  value={formatDurationMinutes(slaSummary?.firstResponse?.p90) ?? '—'}
                  hint={`${formatNumber(slaSummary?.firstResponse?.count ?? 0)} measured`}
                />
                <StatTile
                  icon={<Clock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="Resolution · median"
                  value={formatDurationMinutes(slaSummary?.resolution?.median) ?? '—'}
                  hint={
                    formatDurationMinutes(slaSummary?.policy?.resolutionMinutes)
                      ? `Target ${formatDurationMinutes(slaSummary.policy.resolutionMinutes)}`
                      : 'No target set'
                  }
                />
                <StatTile
                  icon={<Gauge aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="Resolution · p90"
                  value={formatDurationMinutes(slaSummary?.resolution?.p90) ?? '—'}
                  hint={`${formatNumber(slaSummary?.resolution?.count ?? 0)} measured`}
                />
                {/* Breaches link through to the conversation list that defines
                    them, rather than a second copy of the same query. */}
                <StatTile
                  as={Link}
                  to={BREACH_LINK}
                  icon={<AlertTriangle aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="First-response breaches"
                  value={formatNumber(slaSummary?.firstResponse?.breachCount ?? 0)}
                  tone={(slaSummary?.firstResponse?.breachCount ?? 0) > 0 ? 'danger' : 'default'}
                  hint={`${formatRate(slaSummary?.firstResponse?.breachRate)} of measured replies`}
                  className="h-full print:hidden"
                />
                <StatTile
                  as={Link}
                  to={BREACH_LINK}
                  icon={<MessageSquare aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                  label="Awaiting reply"
                  value={formatNumber(slaSummary?.backlog?.count ?? 0)}
                  tone={(slaSummary?.backlog?.breachCount ?? 0) > 0 ? 'danger' : 'default'}
                  hint={`${formatNumber(slaSummary?.backlog?.breachCount ?? 0)} past target · ${formatNumber(
                    slaSummary?.firstResponse?.pendingCount ?? 0
                  )} opened in range`}
                  className="h-full print:hidden"
                />
              </div>
            )}

            <div className="grid gap-5 xl:grid-cols-3">
              <div className="xl:col-span-2">
                <Card className="print:break-inside-avoid">
                  <CardHeader
                    title="Median, p90 and breaches"
                    description={`Every figure is a median or a 90th percentile — there is no mean here on purpose. ${rangeLabel}`}
                    actions={
                      <Button
                        as={Link}
                        to={BREACH_LINK}
                        size="sm"
                        variant="secondary"
                        leftIcon={<MessageSquare className="h-4 w-4" />}
                        className="print:hidden"
                      >
                        Open the backlog
                      </Button>
                    }
                  />
                  {slaLoading ? (
                    <SkeletonTable rows={3} columns={7} />
                  ) : !slaSummary ? (
                    <EmptyState
                      icon={Gauge}
                      title="No SLA figures for this range"
                      description="Sync some mail, or widen the date range, and response times appear here."
                    />
                  ) : (
                    <TableContainer className="rounded-none border-0">
                      <Table>
                        <THead>
                          <TR>
                            <TH>Metric</TH>
                            <TH numeric width="110px">
                              Median
                            </TH>
                            <TH numeric width="110px">
                              p90
                            </TH>
                            <TH numeric width="110px">
                              Slowest
                            </TH>
                            <TH numeric width="90px">
                              Count
                            </TH>
                            <TH numeric width="100px">
                              Breaches
                            </TH>
                            <TH numeric width="110px">
                              Breach rate
                            </TH>
                          </TR>
                        </THead>
                        <TBody>
                          {slaRows.map((row) => (
                            <TR key={row.key}>
                              <TD primary>
                                {row.label}
                                <span className="block truncate text-xs font-normal text-fg-3">
                                  {row.description}
                                  {formatDurationMinutes(row.target)
                                    ? ` · target ${formatDurationMinutes(row.target)}`
                                    : ''}
                                </span>
                              </TD>
                              <TD numeric>
                                <MetricValue minutes={row.metric?.median} />
                              </TD>
                              <TD numeric>
                                <MetricValue minutes={row.metric?.p90} />
                              </TD>
                              <TD numeric>
                                <MetricValue minutes={row.metric?.max} />
                              </TD>
                              <TD numeric>{formatNumber(row.metric?.count ?? 0)}</TD>
                              <TD
                                numeric
                                className={
                                  (row.metric?.breachCount ?? 0) > 0 ? 'text-danger-text' : undefined
                                }
                              >
                                {formatNumber(row.metric?.breachCount ?? 0)}
                              </TD>
                              <TD numeric>{formatRate(row.metric?.breachRate)}</TD>
                            </TR>
                          ))}
                        </TBody>
                      </Table>
                    </TableContainer>
                  )}
                  <CardBody className="border-t border-line">
                    <p className="text-xs text-fg-3">
                      A conversation with no reply yet is not a zero-minute response: it is left out
                      of the percentiles and counted as pending —{' '}
                      <span className="tabular">
                        {formatNumber(slaSummary?.firstResponse?.pendingCount ?? 0)}
                      </span>{' '}
                      in this range.
                    </p>
                  </CardBody>
                </Card>
              </div>

              <SlaPolicyCard
                policy={slaSummary?.policy || slaPolicy?.default}
                overrides={slaPolicy?.clientOverrides}
                canEdit={isAdmin}
                onEdit={() => setPolicyOpen(true)}
              />
            </div>

            <ChartPanel
              title="First response over time"
              description={`Median and p90, by the day the conversation started — ${rangeLabel.toLowerCase()}`}
              legend={[SLA_SERIES.frMedian, SLA_SERIES.frP90]}
              loading={slaLoading}
              isEmpty={!slaHasFirstResponse}
              emptyTitle="No answered conversations in this range"
              emptyDescription="A day with no measured reply is drawn as a gap, never as a zero."
              ariaLabel={`Line chart of first-response time per day for the ${rangeLabel.toLowerCase()}. Median ${
                formatDurationMinutes(slaSummary?.firstResponse?.median) ?? 'not measured'
              }, p90 ${formatDurationMinutes(slaSummary?.firstResponse?.p90) ?? 'not measured'}.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={slaChartData} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid
                    className={GRID_CLASS}
                    stroke="currentColor"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    width={64}
                    tickFormatter={(value) => formatDurationMinutes(value) ?? ''}
                  />
                  <RechartsTooltip content={<ChartTooltip format={formatDurationMinutes} />} />
                  <Line
                    type="monotone"
                    dataKey={SLA_SERIES.frMedian.label}
                    className={SLA_SERIES.frMedian.text}
                    stroke="currentColor"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey={SLA_SERIES.frP90.label}
                    className={SLA_SERIES.frP90.text}
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>

            <ChartPanel
              title="Resolution over time"
              description={`Median and p90, by the day the linked task was completed — ${rangeLabel.toLowerCase()}`}
              legend={[SLA_SERIES.resMedian, SLA_SERIES.resP90]}
              loading={slaLoading}
              isEmpty={!slaHasResolution}
              emptyTitle="No tasks completed in this range"
              emptyDescription="Resolution is measured from a completed task linked to a conversation."
              ariaLabel={`Line chart of resolution time per day for the ${rangeLabel.toLowerCase()}. Median ${
                formatDurationMinutes(slaSummary?.resolution?.median) ?? 'not measured'
              }, p90 ${formatDurationMinutes(slaSummary?.resolution?.p90) ?? 'not measured'}.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={slaChartData} margin={{ top: 8, right: 8, bottom: 4, left: -8 }}>
                  <CartesianGrid
                    className={GRID_CLASS}
                    stroke="currentColor"
                    strokeDasharray="3 3"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    interval="preserveStartEnd"
                    minTickGap={16}
                  />
                  <YAxis
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    width={64}
                    tickFormatter={(value) => formatDurationMinutes(value) ?? ''}
                  />
                  <RechartsTooltip content={<ChartTooltip format={formatDurationMinutes} />} />
                  <Line
                    type="monotone"
                    dataKey={SLA_SERIES.resMedian.label}
                    className={SLA_SERIES.resMedian.text}
                    stroke="currentColor"
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey={SLA_SERIES.resP90.label}
                    className={SLA_SERIES.resP90.text}
                    stroke="currentColor"
                    strokeWidth={2}
                    strokeDasharray="4 3"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </ChartPanel>
          </TabsContent>

          {/* ------------- Employee performance (Admin and Head) ------------- */}
          <TabsContent value="employees" className="space-y-5">
            {isHead && !isAdmin ? (
              <Alert variant="info" title="Your delegations only">
                This report covers the people you assigned work to in this window — not the whole
                office. Someone you have never delegated to is left out rather than shown as a row
                of zeros.
              </Alert>
            ) : null}

            <ChartPanel
              title="Workload by person"
              description={`${
                isHead && !isAdmin ? 'Tasks you assigned' : 'Tasks assigned'
              } in the ${employeeFilter === 'weekly' ? 'last 7 days' : 'last 30 days'}`}
              legend={[SERIES.completed, SERIES.pending, SERIES.late]}
              loading={employeeLoading}
              error={employeeError}
              isEmpty={workloadData.length === 0}
              emptyTitle="No tasks assigned in this window"
              emptyDescription={
                isHead && !isAdmin
                  ? 'Nothing you delegated falls inside this date range.'
                  : 'Change the date range or clear the employee filter.'
              }
              ariaLabel={`Stacked horizontal bar chart of completed, pending and late tasks for ${workloadData.length} people.`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={workloadData}
                  layout="vertical"
                  margin={{ top: 8, right: 16, bottom: 4, left: 8 }}
                >
                  <CartesianGrid
                    className={GRID_CLASS}
                    stroke="currentColor"
                    strokeDasharray="3 3"
                    horizontal={false}
                  />
                  <XAxis
                    type="number"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="label"
                    className={AXIS_CLASS}
                    stroke="currentColor"
                    tick={{ fill: 'currentColor', fontSize: 11 }}
                    tickLine={false}
                    width={140}
                  />
                  <RechartsTooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: 'currentColor', fillOpacity: 0.06 }}
                  />
                  <Bar
                    dataKey={SERIES.completed.label}
                    stackId="work"
                    className={SERIES.completed.text}
                    fill="currentColor"
                    maxBarSize={16}
                  />
                  <Bar
                    dataKey={SERIES.pending.label}
                    stackId="work"
                    className={SERIES.pending.text}
                    fill="currentColor"
                    maxBarSize={16}
                  />
                  <Bar
                    dataKey={SERIES.late.label}
                    stackId="work"
                    className={SERIES.late.text}
                    fill="currentColor"
                    radius={[0, 2, 2, 0]}
                    maxBarSize={16}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartPanel>

            <Card className="print:break-inside-avoid">
              <CardHeader
                title="Performance log"
                description={
                  isHead && !isAdmin
                    ? 'People you delegated to. Click a row for their breakdown'
                    : "Click a row for that person's task breakdown"
                }
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Download className="h-4 w-4" />}
                    onClick={exportEmployeesCsv}
                    className="print:hidden"
                  >
                    Export CSV
                  </Button>
                }
              />
              {employeeLoading ? (
                <SkeletonTable rows={6} columns={6} />
              ) : sortedEmployees.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="No performance data in this range"
                  description={
                    isHead && !isAdmin
                      ? 'You did not assign anyone a task in the selected window.'
                      : 'Nobody was assigned a task in the selected window.'
                  }
                  secondaryAction={
                    isAdmin && userId
                      ? { label: 'Clear employee filter', onClick: () => setParam({ user: '' }) }
                      : undefined
                  }
                />
              ) : (
                <TableContainer className="rounded-none border-0">
                  <Table>
                    <THead>
                      <TR>
                        <TH
                          sorted={sortState(employeeSort, 'employeeName')}
                          onSort={() =>
                            setParam({
                              esort:
                                employeeSort === 'employeeName' ? '-employeeName' : 'employeeName',
                            })
                          }
                        >
                          Employee
                        </TH>
                        {[
                          ['totalAssigned', 'Assigned'],
                          ['totalCompleted', 'Completed'],
                          ['totalPending', 'Pending'],
                          ['totalLate', 'Late'],
                        ].map(([key, label]) => (
                          <TH
                            key={key}
                            numeric
                            width="96px"
                            sorted={sortState(employeeSort, key)}
                            onSort={() =>
                              setParam({ esort: employeeSort === `-${key}` ? key : `-${key}` })
                            }
                          >
                            {label}
                          </TH>
                        ))}
                        <TH
                          numeric
                          width="170px"
                          sorted={sortState(employeeSort, 'completionRate')}
                          onSort={() =>
                            setParam({
                              esort:
                                employeeSort === '-completionRate'
                                  ? 'completionRate'
                                  : '-completionRate',
                            })
                          }
                        >
                          Completion rate
                        </TH>
                      </TR>
                    </THead>
                    <TBody>
                      {sortedEmployees.map((row) => (
                        <TR
                          key={row.employeeId}
                          interactive
                          onClick={() => setDrawerRow(row)}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              setDrawerRow(row)
                            }
                          }}
                        >
                          <TD primary>
                            {row.employeeName}
                            <span className="block truncate text-xs font-normal text-fg-3">
                              {row.employeeEmail} · {row.employeeRole}
                            </span>
                          </TD>
                          <TD numeric>{formatNumber(row.totalAssigned)}</TD>
                          <TD numeric>{formatNumber(row.totalCompleted)}</TD>
                          <TD numeric>{formatNumber(row.totalPending)}</TD>
                          <TD numeric className={row.totalLate > 0 ? 'text-danger-text' : undefined}>
                            {formatNumber(row.totalLate)}
                          </TD>
                          <TD numeric>
                            <span className="inline-flex items-center justify-end gap-2">
                              <span className="h-1.5 w-16 overflow-hidden rounded-sm bg-subtle">
                                <span
                                  className="block h-full bg-success"
                                  style={{ width: `${Math.min(100, row.completionRate || 0)}%` }}
                                />
                              </span>
                              <span className="w-10 text-right tabular">
                                {formatNumber(row.completionRate)}%
                              </span>
                            </span>
                          </TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableContainer>
              )}
            </Card>
          </TabsContent>

          {/* ---------------- Clients ---------------- */}
          <TabsContent value="clients" className="space-y-5">
            <Card className="print:break-inside-avoid">
              <CardHeader
                title="Client analytics"
                description="Mail received against tasks raised and completed"
                actions={
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<Download className="h-4 w-4" />}
                    onClick={exportClientsCsv}
                    className="print:hidden"
                  >
                    Export CSV
                  </Button>
                }
              />
              {coreLoading ? (
                <SkeletonTable rows={6} columns={4} />
              ) : sortedClients.length === 0 ? (
                <EmptyState
                  icon={Building2}
                  title="No clients yet"
                  description="Add a client and link its email addresses to start tracking volume."
                />
              ) : (
                <TableContainer className="rounded-none border-0">
                  <Table>
                    <THead>
                      <TR>
                        <TH
                          sorted={sortState(clientSort, 'name')}
                          onSort={() => setParam({ csort: clientSort === 'name' ? '-name' : 'name' })}
                        >
                          Client
                        </TH>
                        {[
                          ['emailCount', 'Emails'],
                          ['taskCount', 'Tasks'],
                          ['completedTaskCount', 'Completed'],
                        ].map(([key, label]) => (
                          <TH
                            key={key}
                            numeric
                            width="120px"
                            sorted={sortState(clientSort, key)}
                            onSort={() =>
                              setParam({ csort: clientSort === `-${key}` ? key : `-${key}` })
                            }
                          >
                            {label}
                          </TH>
                        ))}
                      </TR>
                    </THead>
                    <TBody>
                      {sortedClients.map((client) => (
                        <TR key={client._id}>
                          <TD primary>
                            {client.name}
                            <span className="block truncate text-xs font-normal text-fg-3">
                              {(client.associatedEmails || []).join(', ') || 'No linked addresses'}
                            </span>
                          </TD>
                          <TD numeric>{formatNumber(client.emailCount)}</TD>
                          <TD numeric>{formatNumber(client.taskCount)}</TD>
                          <TD numeric>{formatNumber(client.completedTaskCount)}</TD>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                </TableContainer>
              )}
            </Card>
          </TabsContent>
        </PageBody>
      </Tabs>

      <SlaPolicyDialog
        open={policyOpen}
        onOpenChange={setPolicyOpen}
        policy={slaSummary?.policy || slaPolicy?.default}
        onSaved={refresh}
      />

      <Drawer open={Boolean(drawerRow)} onOpenChange={(open) => !open && setDrawerRow(null)}>
        <DrawerContent
          size="md"
          title={drawerRow?.employeeName || 'Employee'}
          description={
            drawerRow
              ? `${drawerRow.employeeRole} · ${formatNumber(drawerRow.totalAssigned)} tasks assigned in this window`
              : undefined
          }
        >
          {drawerRow && drawerRow.tasks?.length > 0 ? (
            <TableContainer>
              <Table>
                <THead>
                  <TR>
                    <TH>Task</TH>
                    <TH width="150px">Client</TH>
                    <TH width="110px">Status</TH>
                  </TR>
                </THead>
                <TBody>
                  {drawerRow.tasks.map((task) => (
                    <TR key={task._id}>
                      <TD primary>{task.title}</TD>
                      <TD>{task.clientName || '—'}</TD>
                      <TD>
                        <Badge
                          size="sm"
                          variant={
                            task.status === 'Completed'
                              ? 'success'
                              : task.status === 'Late'
                                ? 'danger'
                                : 'neutral'
                          }
                        >
                          {task.status}
                        </Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </TableContainer>
          ) : (
            <EmptyState
              icon={AlertTriangle}
              title="No tasks in this window"
              description="Nothing was assigned to this person in the selected date range."
            />
          )}
        </DrawerContent>
      </Drawer>
    </>
  )
}
