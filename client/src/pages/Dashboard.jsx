import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Inbox,
  Mail,
  MailCheck,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Unlink,
  UserRound,
  Users,
} from 'lucide-react'

import api, { getErrorMessage, isCanceled } from '../api/axios'
import { fetchTaskOverview } from '../lib/taskOverview'
import { useAuth } from '../components/AuthProvider'
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  PageBody,
  PageHeader,
  SegmentedControl,
  SkeletonTable,
  SkeletonTiles,
  StatTile,
  Table,
  TableContainer,
  TBody,
  TD,
  TH,
  THead,
  TR,
  toast,
  useConfirm,
} from '../components/ui'
import { formatDurationMinutes, formatNumber, timeAgo } from '../lib/utils'

/* ---------------------------------------------------------------------------
 * Deep links.
 *
 * Every number and every row on this screen resolves to the filtered list view
 * that produced it. The query-string keys below are the ones the TaskList and
 * EmailInbox rebuilds put their filter state into — keep the two in step.
 *
 *   /tasks    ?status=Pending|Completed|Late  ?assignee=me|<userId>  ?due=today
 *             ?task=<id>  (opens the task drawer)
 *   /inbox    ?status=unassigned  ?approval=pending
 *             ?group=thread&unanswered=true  (F-1 conversations, backlog only)
 * ------------------------------------------------------------------------- */
const LINK = {
  tasks: '/tasks',
  myOpen: '/tasks?status=Pending&assignee=me',
  myOverdue: '/tasks?status=Late&assignee=me',
  myDueToday: '/tasks?due=today&assignee=me',
  myCompleted: '/tasks?status=Completed&assignee=me',
  openTasks: '/tasks?status=Pending',
  overdueTasks: '/tasks?status=Late',
  newTask: '/tasks?new=1',
  inbox: '/inbox',
  unassignedMail: '/inbox?status=unassigned',
  pendingApprovals: '/inbox?approval=pending',
  /* F-2 has no dedicated breach-list endpoint on purpose: the backlog metric
   * counts exactly the conversations this filter returns. */
  awaitingReply: '/inbox?group=thread&unanswered=true',
  accounts: '/inbox?tab=accounts',
  reports: '/reports',
  clients: '/clients',
  users: '/admin/users',
  profile: '/profile',
}

const STATUS_VARIANT = { Completed: 'success', Late: 'danger', Pending: 'neutral' }
const PRIORITY_VARIANT = { Low: 'neutral', Medium: 'info', High: 'warning', Urgent: 'danger' }

/** Neither loaded nor failed yet — tiles render zeros only from real data. */
const EMPTY_OVERVIEW = {
  counts: { open: 0, overdue: 0, dueToday: 0, completed: null },
  attention: { rows: [], total: 0 },
}

function formatDue(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' })
}

/** The list endpoints return a bare array today and `{ data, pagination }` after
 *  the list-contract migration. Read both so this screen never breaks in between. */
function toList(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function QuickAction({ to, icon: Icon, children }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-sm text-fg-2 transition-colors hover:bg-subtle hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
    >
      <Icon aria-hidden="true" className="h-4 w-4 text-fg-3" />
      <span className="truncate">{children}</span>
      <ArrowRight aria-hidden="true" className="ml-auto h-3.5 w-3.5 text-fg-off" />
    </Link>
  )
}

export default function Dashboard() {
  const { user, role, isAdmin, isHead, displayName } = useAuth()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()

  const canManageMail = isAdmin || isHead
  const myId = user?._id

  /* `mine` drives the tiles and the "Mine" attention list; `everyone` is the
   * office-wide attention list Admin/Head can switch to. Both come from
   * fetchTaskOverview, whose counts are server-side totals — never the length
   * of a capped array (the 200-row legacy cap silently under-reported every
   * tile for users with more tasks than the cap). */
  const [mine, setMine] = useState(null)
  /* { key: reloadKey it was fetched under, data: overview }. The "is it still
   * loading" question is answered by comparing keys, so no loading flag needs
   * to be raised synchronously inside the fetch effect. */
  const [everyone, setEveryone] = useState(null)
  const [recent, setRecent] = useState([])
  const [stats, setStats] = useState(null)
  const [gmail, setGmail] = useState({ connected: false, gmailEmail: '', linkedAccounts: [] })
  const [approvals, setApprovals] = useState([])
  const [sla, setSla] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  const scope = searchParams.get('scope') === 'all' ? 'all' : 'mine'

  const setScope = useCallback(
    (next) => {
      const params = new URLSearchParams(searchParams)
      if (next === 'all') params.set('scope', 'all')
      else params.delete('scope')
      setSearchParams(params, { replace: true })
    },
    [searchParams, setSearchParams]
  )

  /* --- data ---------------------------------------------------------------
   * One round trip, not four sequential ones. Each request is settled
   * independently so a failing side panel never blanks the whole screen.
   * ---------------------------------------------------------------------- */
  useEffect(() => {
    const ctrl = new AbortController()
    const { signal } = ctrl

    const requests = [
      // Tile counts + "Mine" attention. Admin/Head must ask for their own
      // assignments explicitly; an Employee's list is already scoped by the
      // server (and the assignedTo parameter is ignored for that role).
      fetchTaskOverview({ assignedTo: canManageMail && myId ? myId : undefined, signal }),
      // Newest five in role scope, straight from the server's -createdAt sort.
      api.get('/tasks', { params: { page: 1, limit: 5, sort: '-createdAt' }, signal }),
    ]
    if (canManageMail) {
      requests.push(
        api.get('/reports/overall', { signal }),
        api.get('/gmail/status', { signal }),
        api.get('/keyword-rules/pending-approvals', { signal }),
        // F-2. Admin and Head only; a Head is always scoped to their own
        // mailbox and tasks by the server.
        api.get('/reports/sla', { signal })
      )
    }

    Promise.allSettled(requests).then((results) => {
      if (signal.aborted || results.some((r) => r.status === 'rejected' && isCanceled(r.reason))) {
        return
      }

      const [mineRes, recentRes, statsRes, gmailRes, approvalRes, slaRes] = results

      if (mineRes.status === 'fulfilled') {
        setMine(mineRes.value)
        setError(null)
      } else {
        setError(getErrorMessage(mineRes.reason, 'Could not load your tasks.'))
      }

      if (recentRes.status === 'fulfilled') {
        setRecent(toList(recentRes.value.data))
      } else if (mineRes.status === 'fulfilled') {
        setError(getErrorMessage(recentRes.reason, 'Could not load your tasks.'))
      }

      if (statsRes?.status === 'fulfilled') setStats(statsRes.value.data)
      if (gmailRes?.status === 'fulfilled') {
        setGmail({
          connected: Boolean(gmailRes.value.data?.connected),
          gmailEmail: gmailRes.value.data?.gmailEmail || '',
          linkedAccounts: gmailRes.value.data?.linkedAccounts || [],
        })
      }
      if (approvalRes?.status === 'fulfilled') setApprovals(toList(approvalRes.value.data))
      if (slaRes?.status === 'fulfilled') setSla(slaRes.value.data ?? null)

      setLoading(false)
    })

    return () => ctrl.abort()
  }, [canManageMail, myId, reloadKey])

  /* The office-wide ("Everyone") attention list is a second, wider scope that
   * only Admin/Head can select. Fetched on demand so the common path pays for
   * one scope, and keyed by reloadKey so Retry refreshes it too. */
  useEffect(() => {
    if (!canManageMail || scope !== 'all') return undefined
    if (everyone?.key === reloadKey) return undefined // fresh enough
    const ctrl = new AbortController()
    fetchTaskOverview({ signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return
        setEveryone({ key: reloadKey, data })
      })
      .catch((err) => {
        if (ctrl.signal.aborted || isCanceled(err)) return
        setError(getErrorMessage(err, 'Could not load office-wide tasks.'))
      })
    return () => ctrl.abort()
  }, [canManageMail, scope, reloadKey, everyone])

  /* The OAuth callback lands on /dashboard?gmail=connected. Acknowledge it once
   * and drop the parameter so a refresh does not re-announce it. */
  useEffect(() => {
    if (searchParams.get('gmail') !== 'connected') return
    toast.success('Gmail connected')
    const params = new URLSearchParams(searchParams)
    params.delete('gmail')
    setSearchParams(params, { replace: true })
  }, [searchParams, setSearchParams])

  /* Loading is only ever raised from an event handler — never synchronously
   * inside the fetch effect, which would cascade an extra render pass. */
  const refresh = useCallback(() => {
    setError(null)
    setLoading(true)
    setReloadKey((n) => n + 1)
  }, [])

  /* --- derived ----------------------------------------------------------- */
  const { counts } = mine ?? EMPTY_OVERVIEW
  const wantEveryone = canManageMail && scope === 'all'
  const attention = (wantEveryone ? everyone?.data : mine)?.attention
    ?? EMPTY_OVERVIEW.attention
  const attentionBusy = loading || (wantEveryone && everyone?.key !== reloadKey)

  const accountCount = 1 + (gmail.linkedAccounts?.length || 0)

  /* F-2. `backlog` is "now minus the first inbound, for conversations with an
   * unanswered inbound", and its breach count is measured against the
   * FIRST-RESPONSE target — the same definition the SLA tab reports and the
   * same set the `?unanswered=true` conversation list returns. */
  const backlog = useMemo(() => {
    const block = sla?.backlog
    if (!block) return null
    const target = formatDurationMinutes(sla?.policy?.firstResponseMinutes)
    const breaching = block.breachCount || 0
    return {
      count: block.count || 0,
      breachCount: breaching,
      hint: breaching > 0
        ? `${formatNumber(breaching)} past the ${target || 'first-response'} target`
        : target
          ? `All inside the ${target} target`
          : 'Conversations with no reply yet',
    }
  }, [sla])

  /* --- actions ----------------------------------------------------------- */
  const handleSync = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await api.post('/gmail/fetch')
      toast.success(`Sync complete — ${formatNumber(res.data?.count ?? 0)} new emails`)
      refresh()
    } catch (err) {
      if (!isCanceled(err)) {
        toast.error('Could not sync mail', { description: getErrorMessage(err) })
      }
    } finally {
      setSyncing(false)
    }
  }, [refresh])

  const handleConnect = useCallback(async () => {
    try {
      const res = await api.get('/gmail/auth-url')
      if (res.data?.authUrl) window.location.assign(res.data.authUrl)
      else toast.error('Google did not return a sign-in URL')
    } catch (err) {
      toast.error('Could not start the Google connection', { description: getErrorMessage(err) })
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    const ok = await confirm({
      title: `Disconnect ${gmail.gmailEmail || 'the primary Gmail account'}?`,
      description:
        'Synced mail from this account is removed from the inbox. Tasks already created from those emails are kept.',
      confirmLabel: 'Disconnect account',
      cancelLabel: 'Keep connected',
      tone: 'danger',
    })
    if (!ok) return
    try {
      await api.delete('/gmail/disconnect')
      toast.success('Gmail disconnected')
      refresh()
    } catch (err) {
      toast.error('Could not disconnect', { description: getErrorMessage(err) })
    }
  }, [confirm, gmail.gmailEmail, refresh])

  /* --- tiles ------------------------------------------------------------- */
  const tiles = canManageMail
    ? [
        {
          to: LINK.myOverdue,
          icon: AlertTriangle,
          label: 'My overdue',
          value: formatNumber(counts.overdue),
          tone: counts.overdue > 0 ? 'danger' : 'default',
          hint: 'Assigned to you, past deadline',
        },
        {
          to: LINK.myDueToday,
          icon: CalendarClock,
          label: 'Due today',
          value: formatNumber(counts.dueToday),
          tone: counts.dueToday > 0 ? 'warning' : 'default',
          hint: 'Assigned to you',
        },
        {
          to: LINK.openTasks,
          icon: ClipboardList,
          label: 'Open tasks',
          value: formatNumber(stats?.totalPending ?? 0),
          hint: 'Across the office',
        },
        {
          to: LINK.overdueTasks,
          icon: AlertTriangle,
          label: 'Overdue',
          value: formatNumber(stats?.totalLate ?? 0),
          tone: (stats?.totalLate ?? 0) > 0 ? 'danger' : 'default',
          hint: 'Across the office',
        },
        {
          to: LINK.unassignedMail,
          icon: Inbox,
          label: 'Unassigned mail',
          value: formatNumber(stats?.totalUnassignedEmails ?? 0),
          tone: (stats?.totalUnassignedEmails ?? 0) > 0 ? 'primary' : 'default',
          hint: 'Waiting to be turned into tasks',
        },
        {
          to: LINK.pendingApprovals,
          icon: MailCheck,
          label: 'Awaiting approval',
          value: formatNumber(approvals.length),
          tone: approvals.length > 0 ? 'primary' : 'default',
          hint: 'Keyword-matched suggestions',
        },
        {
          to: LINK.awaitingReply,
          icon: Clock,
          label: 'Awaiting reply',
          /* `null` is "not measured", never zero — but a missing SLA payload is
           * a failed request, so it renders as an em dash rather than a 0. */
          value: backlog ? formatNumber(backlog.count) : '—',
          tone: (backlog?.breachCount ?? 0) > 0 ? 'danger' : 'default',
          hint: backlog ? backlog.hint : 'SLA figures unavailable',
        },
      ]
    : [
        {
          to: LINK.myOpen,
          icon: ClipboardList,
          label: 'Open tasks',
          value: formatNumber(counts.open),
          hint: 'Assigned to you',
        },
        {
          to: LINK.myDueToday,
          icon: CalendarClock,
          label: 'Due today',
          value: formatNumber(counts.dueToday),
          tone: counts.dueToday > 0 ? 'warning' : 'default',
        },
        {
          to: LINK.myOverdue,
          icon: AlertTriangle,
          label: 'Overdue',
          value: formatNumber(counts.overdue),
          tone: counts.overdue > 0 ? 'danger' : 'default',
        },
        {
          to: LINK.myCompleted,
          icon: CheckCircle2,
          label: 'Completed',
          /* Counted by `completedAt` — when it was finished — not `createdAt`,
           * which answered "created recently and happens to be complete". A
           * null count means the rows carried no completion dates at all: that
           * renders as an em dash, never as a plausible wrong number. */
          value: counts.completed == null ? '—' : formatNumber(counts.completed),
          tone: (counts.completed ?? 0) > 0 ? 'success' : 'default',
          hint: counts.completed == null ? 'Completion dates unavailable' : 'Last 30 days',
        },
      ]

  const headerActions = canManageMail ? (
    <>
      {gmail.connected ? (
        <Button
          variant="secondary"
          leftIcon={<RefreshCw className="h-4 w-4" />}
          loading={syncing}
          onClick={handleSync}
        >
          Sync mail
        </Button>
      ) : (
        <Button variant="primary" leftIcon={<Mail className="h-4 w-4" />} onClick={handleConnect}>
          Connect Gmail
        </Button>
      )}
      <Button as={Link} to={LINK.newTask} variant="primary" leftIcon={<Plus className="h-4 w-4" />}>
        New task
      </Button>
    </>
  ) : (
    <Button as={Link} to={LINK.tasks} variant="secondary" leftIcon={<ClipboardList className="h-4 w-4" />}>
      My tasks
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`${displayName} · ${role || 'Employee'}`}
        actions={headerActions}
      />

      <PageBody className="space-y-5">
        {error ? (
          <Alert
            variant="danger"
            title="Could not load your dashboard"
            action={
              <Button size="sm" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : null}

        {/* KPI strip */}
        {loading ? (
          <SkeletonTiles
            count={canManageMail ? 7 : 4}
            className={
              canManageMail
                ? 'grid-cols-2 lg:grid-cols-4 xl:grid-cols-7'
                : 'grid-cols-2 lg:grid-cols-4'
            }
          />
        ) : (
          <div
            className={
              canManageMail
                ? 'grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-7'
                : 'grid grid-cols-2 gap-4 lg:grid-cols-4'
            }
          >
            {/* One focusable control per tile — `as`/`to` come from StatTile
                itself, so there is no <Link> wrapper and no second tab stop.
                `icon` may be passed as either a component (`icon={Inbox}`) or an
                element — StatTile accepts both. The element form is used here
                only to set the sizing classes. */}
            {tiles.map(({ icon: Icon, ...tile }) => (
              <StatTile
                key={tile.to + String(tile.value)}
                as={Link}
                to={tile.to}
                icon={<Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />}
                label={tile.label}
                value={tile.value}
                tone={tile.tone}
                hint={tile.hint}
                className="h-full"
              />
            ))}
          </div>
        )}

        <div className="grid gap-5 xl:grid-cols-3">
          {/* --- main column --- */}
          <div className="space-y-5 xl:col-span-2">
            <Card>
              <CardHeader
                title="Needs attention"
                description="Overdue and due today, soonest first"
                actions={
                  canManageMail ? (
                    <SegmentedControl
                      ariaLabel="Task scope"
                      value={scope}
                      onValueChange={setScope}
                      options={[
                        { value: 'mine', label: 'Mine' },
                        { value: 'all', label: 'Everyone' },
                      ]}
                    />
                  ) : null
                }
              />
              {attentionBusy ? (
                <CardBody className="p-0">
                  <SkeletonTable rows={5} columns={4} />
                </CardBody>
              ) : attention.rows.length === 0 ? (
                <CardBody className="p-0">
                  <EmptyState
                    icon={CheckCircle2}
                    title="Nothing is overdue or due today"
                    description={
                      canManageMail && scope === 'all'
                        ? 'No task in the office is past its deadline.'
                        : 'Everything assigned to you has room to run.'
                    }
                  />
                </CardBody>
              ) : (
                <>
                  <TableContainer className="rounded-none border-0">
                    <Table>
                      <THead>
                        <TR>
                          <TH>Task</TH>
                          {canManageMail && scope === 'all' ? <TH width="160px">Assignee</TH> : null}
                          <TH width="110px">Priority</TH>
                          <TH width="100px">Due</TH>
                          <TH width="110px">Status</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {attention.rows.slice(0, 8).map(({ task, bucket }) => (
                          <TR key={task._id}>
                            <TD primary>
                              <Link
                                to={`${LINK.tasks}?task=${task._id}`}
                                className="block truncate rounded-sm hover:text-primary-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
                              >
                                {task.title}
                              </Link>
                              {task.clientName ? (
                                <span className="block truncate text-xs text-fg-3">
                                  {task.clientName}
                                </span>
                              ) : null}
                            </TD>
                            {canManageMail && scope === 'all' ? (
                              <TD>{task.assignedTo?.name || 'Unassigned'}</TD>
                            ) : null}
                            <TD>
                              <Badge variant={PRIORITY_VARIANT[task.priority] || 'neutral'} size="sm">
                                {task.priority || 'Medium'}
                              </Badge>
                            </TD>
                            <TD
                              numeric
                              className={bucket === 'overdue' ? 'text-danger-text' : 'text-warning-text'}
                            >
                              {formatDue(task.deadline)}
                            </TD>
                            <TD>
                              <Badge variant={STATUS_VARIANT[task.status] || 'neutral'} size="sm">
                                {bucket === 'overdue' ? 'Overdue' : task.status}
                              </Badge>
                            </TD>
                          </TR>
                        ))}
                      </TBody>
                    </Table>
                  </TableContainer>
                  <CardFooter className="justify-between">
                    <span className="text-xs text-fg-3 tabular">
                      {/* The total is count-derived (server-side totals), not
                          the length of the fetched rows, so it stays right
                          even when the row set is page-bounded. */}
                      Showing {formatNumber(Math.min(8, attention.rows.length))} of{' '}
                      {formatNumber(attention.total)}
                    </span>
                    <Button
                      as={Link}
                      to={canManageMail && scope === 'all' ? LINK.overdueTasks : LINK.myOverdue}
                      variant="link"
                      rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
                    >
                      View all in Tasks
                    </Button>
                  </CardFooter>
                </>
              )}
            </Card>

            <Card>
              <CardHeader title="Recent activity" description="Latest tasks created in your scope" />
              {loading ? (
                <CardBody className="p-0">
                  <SkeletonTable rows={4} columns={3} />
                </CardBody>
              ) : recent.length === 0 ? (
                <CardBody className="p-0">
                  <EmptyState
                    icon={ClipboardList}
                    title="No tasks yet"
                    description="Tasks created from the inbox or by hand appear here."
                  />
                </CardBody>
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((task) => (
                    <li key={task._id} className="flex items-center gap-3 px-4 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link
                          to={`${LINK.tasks}?task=${task._id}`}
                          className="block truncate text-sm font-medium text-fg hover:text-primary-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
                        >
                          {task.title}
                        </Link>
                        <span className="block truncate text-xs text-fg-3">
                          {task.createdBy?.name ? `${task.createdBy.name} · ` : ''}
                          {task.assignedTo?.name || 'Unassigned'}
                        </span>
                      </div>
                      <Badge variant={STATUS_VARIANT[task.status] || 'neutral'} size="sm">
                        {task.status}
                      </Badge>
                      <span className="w-16 shrink-0 text-right text-xs text-fg-3 tabular">
                        {timeAgo(task.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          {/* --- side column --- */}
          <div className="space-y-5">
            {canManageMail ? (
              <Card>
                <CardHeader
                  title="Mail queue"
                  description={`${formatNumber(stats?.totalUnassignedEmails ?? 0)} unassigned · ${formatNumber(approvals.length)} awaiting approval`}
                />
                {loading ? (
                  <CardBody className="p-0">
                    <SkeletonTable rows={3} columns={2} />
                  </CardBody>
                ) : approvals.length === 0 ? (
                  <CardBody className="p-0">
                    <EmptyState
                      icon={Inbox}
                      title="Nothing waiting on you"
                      description="Keyword-matched emails needing a decision show up here."
                    />
                  </CardBody>
                ) : (
                  <ul className="divide-y divide-line">
                    {approvals.slice(0, 5).map((email) => (
                      <li key={email._id} className="px-4 py-2.5">
                        <p className="truncate text-sm font-medium text-fg">
                          {email.subject || '(no subject)'}
                        </p>
                        <p className="truncate text-xs text-fg-3">
                          {email.from || 'Unknown sender'}
                          {email.suggestedAssignedTo?.name
                            ? ` → ${email.suggestedAssignedTo.name}`
                            : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
                <CardFooter>
                  <Button
                    as={Link}
                    to={approvals.length > 0 ? LINK.pendingApprovals : LINK.unassignedMail}
                    variant="link"
                    rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
                  >
                    Open the inbox
                  </Button>
                </CardFooter>
              </Card>
            ) : null}

            {canManageMail ? (
              <Card>
                <CardHeader
                  title="Connections"
                  actions={
                    gmail.connected ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" iconOnly aria-label="Gmail account actions">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={handleSync}>
                            <RefreshCw className="h-4 w-4" />
                            Sync now
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={handleConnect}>
                            <Plus className="h-4 w-4" />
                            Add another account
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem destructive onSelect={handleDisconnect}>
                            <Unlink className="h-4 w-4" />
                            Disconnect primary
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null
                  }
                />
                {gmail.connected ? (
                  <>
                    <ul className="divide-y divide-line">
                      <li className="flex items-center gap-2 px-4 py-2.5">
                        <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">
                          {gmail.gmailEmail || 'Primary account'}
                        </span>
                        <Badge variant="success" size="sm">
                          Primary
                        </Badge>
                      </li>
                      {(gmail.linkedAccounts || []).map((account) => (
                        <li key={account.gmailEmail} className="flex items-center gap-2 px-4 py-2.5">
                          <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-2">
                            {account.gmailEmail}
                          </span>
                          <Badge variant="neutral" size="sm">
                            {account.ownerName && account.ownerName !== 'Me'
                              ? account.ownerName
                              : 'Linked'}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                    <CardFooter className="justify-between">
                      <span className="text-xs text-fg-3 tabular">
                        {formatNumber(accountCount)} connected
                      </span>
                      <Button
                        as={Link}
                        to={LINK.accounts}
                        variant="link"
                        rightIcon={<ArrowRight className="h-3.5 w-3.5" />}
                      >
                        Manage accounts
                      </Button>
                    </CardFooter>
                  </>
                ) : (
                  <CardBody className="p-0">
                    <EmptyState
                      icon={Mail}
                      title="No mailbox connected"
                      description="Connect a Google account to pull mail into the inbox and turn it into tasks."
                      action={{ label: 'Connect Gmail', onClick: handleConnect }}
                    />
                  </CardBody>
                )}
              </Card>
            ) : null}

            <Card>
              <CardHeader title="Quick actions" />
              <CardBody className="space-y-2">
                {canManageMail ? (
                  <>
                    <QuickAction to={LINK.newTask} icon={Plus}>
                      Create a task
                    </QuickAction>
                    <QuickAction to={LINK.unassignedMail} icon={Inbox}>
                      Assign unassigned mail
                    </QuickAction>
                    <QuickAction to={LINK.reports} icon={BarChart3}>
                      Open reports
                    </QuickAction>
                    <QuickAction to={LINK.clients} icon={Building2}>
                      Clients
                    </QuickAction>
                    {isAdmin ? (
                      <QuickAction to={LINK.users} icon={Users}>
                        Manage users
                      </QuickAction>
                    ) : null}
                  </>
                ) : (
                  <>
                    <QuickAction to={LINK.myOpen} icon={ClipboardList}>
                      My open tasks
                    </QuickAction>
                    <QuickAction to={LINK.myOverdue} icon={AlertTriangle}>
                      My overdue tasks
                    </QuickAction>
                    <QuickAction to={LINK.profile} icon={UserRound}>
                      Profile and password
                    </QuickAction>
                  </>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      </PageBody>
    </>
  )
}
