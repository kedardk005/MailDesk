/**
 * EmailInbox — the shared team inbox.
 *
 * Rebuilt as a three-region operations console: PageHeader / filter toolbars,
 * a dense DataTable list, and a Drawer reading pane.
 *
 * What changed and why (the previous file was 1,529 lines with 28 useState):
 *
 *  - Server pagination per `docs/audits/API-LIST-CONTRACT.md`. The page always
 *    sends `page`, reads `{ data, pagination }`, and tolerates the legacy bare
 *    array while the server migration lands. Bodies never travel in a list
 *    response — rows carry `snippet`, the Drawer loads the body from the detail
 *    route.
 *  - Every filter lives in the URL query string, so a view is bookmarkable.
 *  - One AbortController per request; a superseded request is aborted, so a
 *    debounced search resolves last-query-wins rather than last-response-wins.
 *  - Loading is DERIVED (`result.stamp !== stamp`), never assigned from inside
 *    an effect, so there are no cascading renders and no double initial fetch.
 *  - The tab count badge is rendered only on the ACTIVE tab and comes from
 *    `pagination.total` — the exact filter that produced the rows. Badges can no
 *    longer disagree with the list they label. (Counts for inactive tabs would
 *    need a dedicated counts endpoint; six speculative requests per render is
 *    not a trade worth making.)
 *  - `window.confirm` / `alert` / the hand-rolled `triggerAlert` are gone:
 *    `useConfirm()`, a typed confirmation for "clear all", and `toast`.
 *  - `renderEmailContent` is gone. Bodies render through the shared, sanitised,
 *    sandboxed `EmailBody` iframe. No `dangerouslySetInnerHTML`, and never
 *    `allow-scripts` together with `allow-same-origin`.
 *  - Every `URL.createObjectURL` is paired with `revokeObjectURL`.
 *  - AI summarise posts `{ emailId }`; the server owns the body.
 *  - No inline `style={{}}`, no emoji, no gradients, no `animate-pulse`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ArrowDownLeft,
  ArrowUpRight,
  CalendarDays,
  Clock,
  Copy,
  Download,
  Eye,
  Image as ImageIcon,
  Inbox as InboxIcon,
  KeyRound,
  Mail,
  MailOpen,
  MailX,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Unlink,
  UserPlus,
  X,
} from 'lucide-react'
import api, { getErrorMessage, isCanceled } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import { useRegisterCommands } from '../components/CommandRegistry'
import EmailBody from '../components/EmailBody'
import { KeywordApprovalModal } from '../components/KeywordApprovalModal'
import {
  Alert,
  AvatarGroup,
  Badge,
  Button,
  CountBadge,
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
  Label,
  PageBody,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  SegmentedControl,
  Select,
  SelectMenu,
  SkeletonText,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  toast,
  Toolbar,
  Tooltip,
  useConfirm,
} from '../components/ui'
import { getSocket } from '../lib/socket'
import { cn, formatDurationMinutes, formatNumber, timeAgo } from '../lib/utils'
import { ExtractActionsPanel } from '../components/ActionExtraction'

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const TABS = [
  { value: 'inbox', label: 'Inbox' },
  { value: 'sent', label: 'Sent' },
  { value: 'promotions', label: 'Promotions' },
  { value: 'social', label: 'Social' },
  { value: 'updates', label: 'Updates' },
  { value: 'spam', label: 'Spam' },
]
const TAB_VALUES = TABS.map((t) => t.value)

const STATUS_OPTIONS = [
  { value: '', label: 'Any status' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'assigned', label: 'Assigned' },
]

const KEYWORD_OPTIONS = [
  { value: '', label: 'Any rule' },
  { value: 'matched', label: 'Matched a rule' },
  { value: 'unmatched', label: 'No rule match' },
]

/** S-16. `read` is per-user on a shared mailbox, hence the wording. */
const READ_OPTIONS = [
  { value: '', label: 'Read and unread' },
  { value: 'false', label: 'Unread by me' },
  { value: 'true', label: 'Read by me' },
]
const READ_VALUES = READ_OPTIONS.map((o) => o.value)

const PRIORITY_OPTIONS = ['Low', 'Medium', 'High', 'Urgent'].map((v) => ({ value: v, label: v }))
/** `bulkTaskAction` accepts exactly these three. */
const TASK_STATUS_OPTIONS = ['Pending', 'Completed', 'Late'].map((v) => ({ value: v, label: v }))

/**
 * F-1. Conversations vs messages.
 *
 * `message` is the default and must stay byte-identical to the pre-F-1 page:
 * `GET /api/gmail/emails` is unchanged and still excludes outbound replies by
 * default. Conversation mode is a separate endpoint (`GET /api/gmail/threads`)
 * with its own row shape, its own sort whitelist and its own filters.
 */
const GROUP_OPTIONS = [
  { value: 'message', label: 'Messages' },
  { value: 'thread', label: 'Conversations' },
]
const GROUP_VALUES = GROUP_OPTIONS.map((g) => g.value)

const PAGE_SIZES = [25, 50, 100]
const DEFAULT_SORT = '-date'
/** Server whitelist: `THREAD_SORT_FIELDS` in `server/utils/threadHelper.js`. */
const DEFAULT_THREAD_SORT = '-lastMessageAt'
const SEARCH_DEBOUNCE_MS = 350
const AUTO_REFRESH_MS = 5 * 60 * 1000
const EXPORT_PAGE_SIZE = 100
const EXPORT_MAX_PAGES = 50
/* Per-user so the next person on a shared machine does not inherit an
 * unlocked delete. `lib/auth.js` only clears `cached_*` keys on logout. */
const DOWNLOAD_FLAG = 'emailsDownloaded'
const downloadFlagKey = (userId) => `${DOWNLOAD_FLAG}:${userId || 'anon'}`
const CLEAR_ALL_PHRASE = 'DELETE ALL'

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                                */
/* -------------------------------------------------------------------------- */

const accountOf = (email) => email?.toEmail || email?.fetchedBy?.gmailEmail || ''

function formatAbsolute(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Minutes -> "2h 15m".
 *
 * The server sends minutes as a number with one decimal, or `null` when there
 * is nothing to measure (`unit: "minutes"`). `null` must never render as `0`,
 * so this returns `null` and the caller decides what "not measured" looks like.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Object URLs are always revoked — the old page leaked one per export. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** Excel-readable HTML workbook. Bodies are not in list responses; we export
 *  the server-provided snippet instead. */
function buildWorkbook(rows) {
  const assigned = rows.filter((r) => r.status === 'assigned').length
  const head = [
    '#',
    'Received',
    'From',
    'To (inbox)',
    'Subject',
    'Status',
    'Assigned to',
    'Keyword rule',
    'Attachments',
    'Preview',
  ]
  const body = rows
    .map((r, i) => {
      const cells = [
        i + 1,
        formatAbsolute(r.date),
        r.from || 'Unknown sender',
        accountOf(r) || 'Unknown inbox',
        r.subject || '(no subject)',
        r.status === 'assigned' ? 'Assigned' : 'Unassigned',
        r.assignedTo?.name || '-',
        r.matchedKeyword || '-',
        (r.attachments || []).length,
        r.snippet || '',
      ]
      return `<tr>${cells.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    })
    .join('')

  return `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8">
<style>
 body{font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#0f172a}
 h1{font-size:15pt;font-weight:600;margin:0 0 4px}
 p.meta{font-size:9pt;color:#475569;margin:0 0 14px}
 table{border-collapse:collapse;font-size:10pt}
 th{background:#e2e8f0;color:#0f172a;font-weight:600;text-align:left;padding:6px 10px;border:1px solid #cbd5e1}
 td{padding:5px 10px;border:1px solid #e2e8f0;vertical-align:top}
 tr:nth-child(even) td{background:#f8fafc}
</style></head><body>
<h1>Workspace email backup</h1>
<p class="meta">Exported ${escapeHtml(formatAbsolute(new Date()))} &middot; ${rows.length} emails &middot; ${assigned} assigned &middot; ${rows.length - assigned} unassigned</p>
<table><thead><tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>
</body></html>`
}

function readList(payload) {
  if (Array.isArray(payload)) return { rows: payload, pagination: null }
  return { rows: payload?.data ?? [], pagination: payload?.pagination ?? null }
}

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every filter, the sort, the page and the open email live in the query string.
 * `patch` is the only writer; it resets the page whenever a filter changes.
 */
function useInboxParams() {
  const [searchParams, setSearchParams] = useSearchParams()

  const view = useMemo(() => {
    const tab = searchParams.get('tab')
    const limit = Number(searchParams.get('limit'))
    const read = searchParams.get('read') || ''
    const group = searchParams.get('group') || ''
    return {
      q: searchParams.get('q') || '',
      tab: TAB_VALUES.includes(tab) ? tab : 'inbox',
      account: searchParams.get('account') || '',
      status: searchParams.get('status') || '',
      read: READ_VALUES.includes(read) ? read : '',
      keyword: searchParams.get('keyword') || '',
      from: searchParams.get('from') || '',
      to: searchParams.get('to') || '',
      sort: searchParams.get('sort') || DEFAULT_SORT,
      page: Math.max(1, Number(searchParams.get('page')) || 1),
      limit: PAGE_SIZES.includes(limit) ? limit : PAGE_SIZES[0],
      openId: searchParams.get('id') || '',
      /* F-1 conversation mode. Anything but the literal `thread` is the
       * historical message list, so a stray value cannot silently change the
       * endpoint the page talks to. */
      group: GROUP_VALUES.includes(group) ? group : 'message',
      unanswered: searchParams.get('unanswered') === 'true' ? 'true' : '',
      unread: searchParams.get('unread') === 'true' ? 'true' : '',
      /* A separate key from `sort`: the two endpoints have disjoint sort
       * whitelists, so sharing one parameter would silently fall back to the
       * default every time the toggle is flipped. */
      threadSort: searchParams.get('tsort') || DEFAULT_THREAD_SORT,
      openThreadId: searchParams.get('thread') || '',
    }
  }, [searchParams])

  const patch = useCallback(
    (next, { resetPage = true } = {}) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          Object.entries(next).forEach(([key, value]) => {
            if (value === '' || value === null || value === undefined) params.delete(key)
            else params.set(key, String(value))
          })
          if (resetPage && !('page' in next)) params.delete('page')
          return params
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  return { view, patch }
}

/**
 * List fetch. `paramsJson` is the serialised request — one string means one
 * effect dependency and therefore exactly one request per distinct query.
 * Pass `''` to disable (e.g. a role that may not read the inbox, or the mode
 * that is not currently on screen).
 *
 * Both list endpoints answer the same envelope from
 * `docs/audits/API-LIST-CONTRACT.md`, so one hook serves messages and
 * conversations; only the URL and the failure copy differ.
 */
function useEmailList(url, paramsJson, nonce, failureMessage = 'Could not load the inbox.') {
  const [result, setResult] = useState(null)
  const stamp = paramsJson ? `${url}|${paramsJson}|${nonce}` : ''
  const fresh = result?.stamp === stamp

  useEffect(() => {
    if (!paramsJson) return undefined
    const controller = new AbortController()
    let alive = true

    api
      .get(url, { params: JSON.parse(paramsJson), signal: controller.signal })
      .then((res) => {
        if (!alive) return
        const { rows, pagination } = readList(res.data)
        setResult({
          stamp,
          rows,
          total: pagination?.total ?? rows.length,
          error: null,
        })
      })
      .catch((err) => {
        if (!alive || isCanceled(err)) return
        setResult({
          stamp,
          rows: [],
          total: 0,
          error: getErrorMessage(err, failureMessage),
        })
      })

    // Aborting the superseded request is what makes the debounced search
    // last-QUERY-wins instead of last-RESPONSE-wins.
    return () => {
      alive = false
      controller.abort()
    }
  }, [failureMessage, paramsJson, stamp, url])

  /**
   * Patch loaded rows in place. Marking mail read is a per-user relation on a
   * document the list has already fetched, so re-running the whole query (and
   * scrolling the user back to the top) to reflect one boolean would be worse
   * than the stale row it fixes.
   */
  const patchRows = useCallback((ids, changes) => {
    const wanted = new Set(ids)
    setResult((prev) =>
      prev
        ? {
            ...prev,
            rows: prev.rows.map((row) => (wanted.has(row._id) ? { ...row, ...changes } : row)),
          }
        : prev
    )
  }, [])

  return {
    rows: fresh ? result.rows : (result?.rows ?? []),
    total: fresh ? result.total : (result?.total ?? 0),
    error: fresh ? result.error : null,
    loading: Boolean(paramsJson) && !fresh,
    patchRows,
  }
}

/** Detail fetch — the only place a body is ever loaded. */
function useEmailDetail(id, nonce) {
  const [result, setResult] = useState(null)
  const stamp = id ? `${id}|${nonce}` : ''
  const fresh = result?.stamp === stamp

  useEffect(() => {
    if (!id) return undefined
    const controller = new AbortController()
    let alive = true

    api
      .get(`/gmail/emails/${id}`, { signal: controller.signal })
      .then((res) => {
        if (!alive) return
        setResult({ stamp, email: res.data?.data ?? res.data, error: null })
      })
      .catch((err) => {
        if (!alive || isCanceled(err)) return
        setResult({ stamp, email: null, error: getErrorMessage(err, 'Could not open this email.') })
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [id, stamp])

  return {
    email: fresh ? result.email : null,
    error: fresh ? result.error : null,
    loading: Boolean(id) && !fresh,
  }
}

/**
 * Conversation fetch — the whole thread, bodies included, oldest first.
 *
 * `GET /api/gmail/threads/:threadId` is the only route that returns more than
 * one body at a time; the list rows carry a `snippet` and nothing else.
 */
function useThreadDetail(threadId, nonce) {
  const [result, setResult] = useState(null)
  const stamp = threadId ? `${threadId}|${nonce}` : ''
  const fresh = result?.stamp === stamp

  useEffect(() => {
    if (!threadId) return undefined
    const controller = new AbortController()
    let alive = true

    api
      .get(`/gmail/threads/${encodeURIComponent(threadId)}`, { signal: controller.signal })
      .then((res) => {
        if (!alive) return
        setResult({ stamp, thread: res.data ?? null, error: null })
      })
      .catch((err) => {
        if (!alive || isCanceled(err)) return
        setResult({
          stamp,
          thread: null,
          error: getErrorMessage(err, 'Could not open this conversation.'),
        })
      })

    return () => {
      alive = false
      controller.abort()
    }
  }, [threadId, stamp])

  return {
    thread: fresh ? result.thread : null,
    error: fresh ? result.error : null,
    loading: Boolean(threadId) && !fresh,
  }
}

/** Reference data: assignable users, connected accounts, approval queue size. */
function useInboxAux(enabled, nonce) {
  const [aux, setAux] = useState({ users: [], status: null, pendingApprovals: 0 })

  useEffect(() => {
    const controller = new AbortController()
    let alive = true
    const options = { signal: controller.signal }

    Promise.allSettled([
      enabled ? api.get('/users', options) : Promise.resolve(null),
      api.get('/gmail/status', options),
      enabled ? api.get('/keyword-rules/pending-approvals', options) : Promise.resolve(null),
    ]).then(([users, status, approvals]) => {
      if (!alive) return
      setAux({
        users: users?.value ? readList(users.value.data).rows : [],
        status: status?.value?.data ?? null,
        pendingApprovals: approvals?.value ? readList(approvals.value.data).rows.length : 0,
      })
    })

    return () => {
      alive = false
      controller.abort()
    }
  }, [enabled, nonce])

  return aux
}

/* -------------------------------------------------------------------------- */
/* Presentational pieces                                                       */
/* -------------------------------------------------------------------------- */

function StatusBadge({ status }) {
  return status === 'assigned' ? (
    <Badge variant="success">Assigned</Badge>
  ) : (
    <Badge variant="neutral">Unassigned</Badge>
  )
}

/**
 * S-16: emails carry a derived `isRead` computed for the requesting user.
 * Anything older than the migration has no field at all, and an email nobody
 * has opened is genuinely unread, so `undefined` reads as unread.
 */
const isUnread = (email) => email?.isRead === false || email?.isRead === undefined

function RowMenu({ email, canDelete, onOpen, onAssign, onDelete, onToggleRead }) {
  return (
    /* `DataTable` now ignores row clicks that originate on an interactive
     * descendant (button, link, menu item…), so the hand-rolled
     * stopPropagation wrapper this used to need is gone. */
    <span className="inline-flex">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" iconOnly aria-label={`Actions for “${email.subject || 'this email'}”`}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => onOpen(email)}>
            <Mail className="h-4 w-4" />
            Open email
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onToggleRead([email._id], isUnread(email))}>
            {isUnread(email) ? <MailOpen className="h-4 w-4" /> : <MailX className="h-4 w-4" />}
            {isUnread(email) ? 'Mark as read' : 'Mark as unread'}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onAssign([email._id])}>
            <UserPlus className="h-4 w-4" />
            Assign as task
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              navigator.clipboard
                ?.writeText(email.from || '')
                .then(() => toast.success('Sender copied'))
                .catch(() => toast.error('Could not copy the sender address'))
            }}
          >
            <Copy className="h-4 w-4" />
            Copy sender
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive disabled={!canDelete} onSelect={() => onDelete(email)}>
            <Trash2 className="h-4 w-4" />
            {canDelete ? 'Delete email' : 'Delete locked — export first'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

function BulkBar({ count, onAssign, onDelete, onClear, onMarkRead, marking, canDelete, deleting }) {
  return (
    <div className="flex min-h-[44px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-primary-border bg-primary-subtle px-6 py-2">
      <p className="text-sm font-medium text-primary-text tabular">
        {formatNumber(count)} {count === 1 ? 'email' : 'emails'} selected
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          leftIcon={<UserPlus className="h-4 w-4" />}
          onClick={onAssign}
        >
          Assign as tasks
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<MailOpen className="h-4 w-4" />}
          loading={marking === 'read'}
          disabled={Boolean(marking)}
          onClick={() => onMarkRead(true)}
        >
          Mark read
        </Button>
        <Button
          size="sm"
          variant="secondary"
          leftIcon={<MailX className="h-4 w-4" />}
          loading={marking === 'unread'}
          disabled={Boolean(marking)}
          onClick={() => onMarkRead(false)}
        >
          Mark unread
        </Button>
        <Tooltip content={canDelete ? '' : 'Export a backup first to unlock deletion'}>
          <Button
            size="sm"
            variant="danger-ghost"
            leftIcon={<Trash2 className="h-4 w-4" />}
            disabled={!canDelete}
            loading={deleting}
            onClick={onDelete}
          >
            Delete
          </Button>
        </Tooltip>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear selection
        </Button>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Reading pane                                                                */
/* -------------------------------------------------------------------------- */

function AttachmentList({ emailId, attachments }) {
  const [busy, setBusy] = useState('')

  const download = async (attachment) => {
    setBusy(attachment.attachmentId)
    try {
      const res = await api.get(`/gmail/emails/${emailId}/attachments/${attachment.attachmentId}`, {
        responseType: 'blob',
      })
      downloadBlob(new Blob([res.data]), attachment.filename || 'attachment')
    } catch (err) {
      toast.error('Could not download the attachment', { description: getErrorMessage(err) })
    } finally {
      setBusy('')
    }
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg-2">
        <Paperclip aria-hidden="true" className="h-3.5 w-3.5" />
        Attachments ({attachments.length})
      </h3>
      <ul className="mt-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <li key={attachment.attachmentId}>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === attachment.attachmentId}
              leftIcon={<Download className="h-3.5 w-3.5" />}
              onClick={() => download(attachment)}
            >
              <span className="max-w-[220px] truncate">{attachment.filename}</span>
              <span className="ml-1 text-2xs text-fg-3 tabular">
                {Math.max(1, Math.round((attachment.size || 0) / 1024))} KB
              </span>
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SummaryPanel({ emailId }) {
  const [state, setState] = useState({ loading: false, text: '', error: '' })
  const [prevId, setPrevId] = useState(emailId)
  if (emailId !== prevId) {
    setPrevId(emailId)
    setState({ loading: false, text: '', error: '' })
  }

  const summarise = async () => {
    setState({ loading: true, text: '', error: '' })
    try {
      // Only the id travels. Posting the full HTML body 413'd against the
      // server's 100 kb express.json() limit on most real mail.
      const res = await api.post('/ai/summarize-email', { emailId })
      setState({ loading: false, text: res.data?.summary || '', error: '' })
    } catch (err) {
      setState({ loading: false, text: '', error: getErrorMessage(err, 'Could not summarise this email.') })
    }
  }

  return (
    <section className="rounded-lg border border-line bg-canvas p-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg-2">
          <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
          AI summary
        </h3>
        <Button size="sm" variant="secondary" loading={state.loading} onClick={summarise}>
          {state.text ? 'Re-summarise' : 'Summarise'}
        </Button>
      </div>
      {state.error ? (
        <Alert variant="danger" className="mt-2">
          {state.error}
        </Alert>
      ) : null}
      {state.text ? (
        <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-fg-2">{state.text}</p>
      ) : null}
    </section>
  )
}

/**
 * Reply composer.
 *
 * `POST /api/gmail/emails/:id/reply` now persists what it sends as an
 * `Email` with `direction: 'outbound'` carrying the conversation's `threadId`,
 * so `onSent` is what lets the reading pane show the reply that just left
 * instead of waiting for the next sync.
 */
function ReplyComposer({ emailId, to, onSent, onDraftChange }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [prevId, setPrevId] = useState(emailId)
  if (emailId !== prevId) {
    setPrevId(emailId)
    setOpen(false)
    setText('')
  }

  /* F-4: "the composer has content" is what the collision banner is derived
   * from. Reported as a boolean edge, never as keystrokes, and cleared on
   * unmount so closing the pane cannot leave a stale "still writing" on
   * everyone else's screen. */
  const hasDraft = open && text.trim().length > 0
  useEffect(() => {
    onDraftChange?.(hasDraft)
    // Unmounting the composer (closing the pane, changing message) must clear
    // the flag, or everyone else keeps seeing "still writing".
    return () => onDraftChange?.(false)
  }, [hasDraft, onDraftChange])

  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await api.post(`/gmail/emails/${emailId}/reply`, { replyBody: text })
      toast.success('Reply sent')
      setOpen(false)
      setText('')
      onSent?.()
    } catch (err) {
      toast.error('Could not send the reply', { description: getErrorMessage(err) })
    } finally {
      setSending(false)
    }
  }

  if (!open) {
    return (
      <Button variant="secondary" leftIcon={<Reply className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Reply
      </Button>
    )
  }

  return (
    <section className="rounded-lg border border-line bg-surface p-3">
      <FormField label={`Reply to ${to || 'sender'}`}>
        {(field) => (
          <Textarea
            {...field}
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Write your reply…"
          />
        )}
      </FormField>
      <div className="mt-2 flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          loading={sending}
          disabled={!text.trim()}
          leftIcon={<Send className="h-4 w-4" />}
          onClick={send}
        >
          Send reply
        </Button>
      </div>
    </section>
  )
}

function EmailDrawer({
  open,
  summary,
  email,
  loading,
  error,
  canManage,
  canDelete,
  users,
  onOpenChange,
  onAssign,
  onDelete,
  onToggleRead,
  onTasksCreated,
}) {
  const [showImages, setShowImages] = useState(false)
  const id = summary?._id || ''
  const [prevId, setPrevId] = useState(id)
  if (id !== prevId) {
    setPrevId(id)
    setShowImages(false)
  }

  const record = email || summary
  if (!open || !record) return null

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        size="lg"
        title={record.subject || '(no subject)'}
        description={`From ${record.from || 'Unknown sender'} · to ${accountOf(record) || 'unknown inbox'}`}
        headerActions={
          canManage ? (
            <Button
              size="sm"
              variant="primary"
              leftIcon={<UserPlus className="h-4 w-4" />}
              onClick={() => onAssign([record._id])}
            >
              Assign as task
            </Button>
          ) : null
        }
        footer={
          <>
            {canManage ? (
              <Button
                variant="danger-ghost"
                disabled={!canDelete}
                leftIcon={<Trash2 className="h-4 w-4" />}
                onClick={() => onDelete(record)}
              >
                Delete
              </Button>
            ) : null}
            {/* Opening the pane already marked it read for you; this puts it
                back in the unread queue without touching anyone else's view. */}
            <Button
              variant="secondary"
              leftIcon={<MailX className="h-4 w-4" />}
              onClick={() => {
                onToggleRead([record._id], false)
                onOpenChange(false)
              }}
            >
              Mark unread
            </Button>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-fg-3">From</dt>
            <dd className="min-w-0 break-words font-mono text-fg-2">{record.from || '—'}</dd>
            <dt className="text-fg-3">To</dt>
            <dd className="min-w-0 break-words font-mono text-fg-2">{accountOf(record) || '—'}</dd>
            <dt className="text-fg-3">Received</dt>
            <dd className="text-fg-2 tabular">{formatAbsolute(record.date)}</dd>
            <dt className="text-fg-3">Assigned to</dt>
            <dd className="text-fg-2">{record.assignedTo?.name || 'Nobody yet'}</dd>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={record.status} />
            {record.matchedKeyword ? (
              <Badge variant="info" icon={<KeyRound aria-hidden="true" />}>
                {record.matchedKeyword}
              </Badge>
            ) : null}
            <div className="ml-auto">
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<ImageIcon className="h-3.5 w-3.5" />}
                onClick={() => setShowImages((v) => !v)}
              >
                {showImages ? 'Hide remote images' : 'Show remote images'}
              </Button>
            </div>
          </div>

          {error ? (
            <Alert variant="danger" title="Could not load this email">
              {error}
            </Alert>
          ) : null}

          {loading ? (
            <div className="rounded-lg border border-line bg-surface p-4">
              <SkeletonText lines={6} />
            </div>
          ) : null}

          {!loading && !error && email ? (
            <div className="overflow-hidden rounded-lg border border-line">
              {/* The ONLY permitted renderer of untrusted email HTML. */}
              <EmailBody
                html={email.body}
                minHeight={240}
                maxHeight={900}
                allowRemoteImages={showImages}
                title={`Email content: ${email.subject || 'no subject'}`}
              />
            </div>
          ) : null}

          {email?.attachments?.length ? (
            <AttachmentList emailId={email._id} attachments={email.attachments} />
          ) : null}

          {canManage && email ? <SummaryPanel emailId={email._id} /> : null}
          {/* F-3 on a single message. Created tasks are linked back to it. */}
          {canManage && email ? (
            <ExtractActionsPanel
              emailId={email._id}
              users={users}
              linkedEmail={email._id}
              onCreated={onTasksCreated}
            />
          ) : null}
          {canManage && email ? <ReplyComposer emailId={email._id} to={email.from} /> : null}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/* -------------------------------------------------------------------------- */
/* Conversation reading pane (F-1)                                             */
/* -------------------------------------------------------------------------- */

/**
 * The single most useful signal on the conversation list.
 *
 * `hasUnansweredInbound` is NOT "the newest message is inbound": the server
 * derives it from `lastOutboundAt < lastInboundAt`, so a thread that received
 * two follow-ups after our reply is still awaiting one.
 */
function AwaitingBadge({ awaiting }) {
  return awaiting ? (
    <Badge variant="warning" icon={<Clock aria-hidden="true" />}>
      Awaiting reply
    </Badge>
  ) : (
    <Badge variant="success">Answered</Badge>
  )
}

/** One message inside a conversation. Inbound and outbound are never the same
 *  shape, the same fill or the same label. */
function ThreadMessage({ message }) {
  const outbound = message.direction === 'outbound'
  const author = outbound
    ? message.sentBy?.name || message.from || 'Sent from this workspace'
    : message.from || 'Unknown sender'

  return (
    <article
      className={cn(
        'overflow-hidden rounded-lg border',
        outbound ? 'border-primary-border bg-primary-subtle' : 'border-line bg-surface'
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex min-w-0 items-start gap-2">
          {outbound ? (
            <ArrowUpRight aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary-text" />
          ) : (
            <ArrowDownLeft aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-fg">{author}</p>
            <p className="truncate font-mono text-xs text-fg-3">
              {outbound ? `to ${message.toEmail || 'the sender'}` : `to ${accountOf(message) || 'this mailbox'}`}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={outbound ? 'primary' : 'neutral'} size="sm">
            {outbound ? 'We replied' : 'Received'}
          </Badge>
          <span className="text-xs text-fg-3 tabular">
            {formatAbsolute(message.sentAt || message.date)}
          </span>
        </div>
      </header>

      {message.body ? (
        /* The shared, sanitised, sandboxed renderer — with the SHARED image
         * gate, so consent is per message and resets when the body changes. */
        <EmailBody
          html={message.body}
          imageGate
          minHeight={120}
          maxHeight={560}
          title={`Message from ${author}`}
        />
      ) : (
        <p className="px-3 py-3 text-sm text-fg-3">{message.snippet || 'This message has no body.'}</p>
      )}

      {message.attachments?.length ? (
        <div className="border-t border-line p-3">
          <AttachmentList emailId={message._id} attachments={message.attachments} />
        </div>
      ) : null}
    </article>
  )
}

/* -------------------------------------------------------------------------- */
/* Collision detection (F-4)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The jsdom suite has no socket server and MSW does not mock WebSockets, so a
 * real handshake there would be a non-deterministic connection attempt plus a
 * heartbeat interval that outlives the test. Presence is advisory, so skipping
 * it under test costs nothing and keeps the suite honest.
 */
const PRESENCE_ENABLED = import.meta.env.MODE !== 'test'

/** Fallback until the server tells us its real `ttlMs` (PRESENCE_TTL_SECONDS). */
const PRESENCE_FALLBACK_TTL_MS = 45000

/**
 * Live presence for one conversation, over the SHARED authenticated socket.
 *
 * `thread:viewing` doubles as the heartbeat, so it is re-emitted every
 * `ttlMs / 2` taken from the server's own `thread:viewers` payload rather than
 * from a constant here that could drift from `PRESENCE_TTL_SECONDS`. A
 * composing entry ages out on the same clock, so the heartbeat refreshes that
 * too while the composer has content.
 *
 * `thread:presence:denied` is silent by design: it is the identical answer for
 * an unknown thread, a mailbox the caller cannot see and an over-budget socket,
 * so it carries no information worth toasting. It simply means no presence.
 *
 * Every listener and the interval are removed on unmount and whenever the
 * thread changes — duplicate listeners accumulating across re-renders was a
 * real defect in the original inbox and must not come back.
 *
 * @param {string} threadId
 * @param {boolean} composing - the reply composer currently has content
 */
function useThreadPresence(threadId, composing) {
  const [viewers, setViewers] = useState([])
  const [composers, setComposers] = useState([])
  const composingRef = useRef(composing)
  const deniedRef = useRef(false)

  /* Read by the heartbeat, which must not be torn down and rebuilt every time
   * the composer gains or loses a character. */
  useEffect(() => {
    composingRef.current = composing
  }, [composing])

  useEffect(() => {
    if (!PRESENCE_ENABLED || !threadId) return undefined
    const socket = getSocket()
    if (!socket) return undefined

    deniedRef.current = false
    let ttlMs = PRESENCE_FALLBACK_TTL_MS
    let heartbeat = 0

    const announce = () => {
      if (deniedRef.current) return
      socket.emit('thread:viewing', { threadId })
      // A composing entry expires on the same TTL, so it needs the same pulse.
      if (composingRef.current) socket.emit('thread:composing', { threadId })
    }

    const schedule = () => {
      window.clearInterval(heartbeat)
      heartbeat = window.setInterval(announce, Math.max(5000, Math.round(ttlMs / 2)))
    }

    const onViewers = (payload) => {
      if (payload?.threadId !== threadId) return
      setViewers(Array.isArray(payload.viewers) ? payload.viewers : [])
      const next = Number(payload.ttlMs)
      if (next > 0 && next !== ttlMs) {
        ttlMs = next
        schedule()
      }
    }

    const onComposers = (payload) => {
      if (payload?.threadId !== threadId) return
      setComposers(Array.isArray(payload.composers) ? payload.composers : [])
    }

    /* Not an error: no presence for this thread, and nothing more. */
    const onDenied = (payload) => {
      if (payload?.threadId && payload.threadId !== threadId) return
      deniedRef.current = true
      window.clearInterval(heartbeat)
      heartbeat = 0
      setViewers([])
      setComposers([])
    }

    /* Reconnects give a fresh socket id, so the roster has to be re-announced. */
    const onConnect = () => {
      deniedRef.current = false
      announce()
    }

    /* A refused or dropped handshake means no presence — never a toast. */
    const onConnectError = () => {
      setViewers([])
      setComposers([])
    }

    socket.on('thread:viewers', onViewers)
    socket.on('thread:composers', onComposers)
    socket.on('thread:presence:denied', onDenied)
    socket.on('connect', onConnect)
    socket.on('connect_error', onConnectError)

    announce()
    schedule()

    return () => {
      window.clearInterval(heartbeat)
      socket.off('thread:viewers', onViewers)
      socket.off('thread:composers', onComposers)
      socket.off('thread:presence:denied', onDenied)
      socket.off('connect', onConnect)
      socket.off('connect_error', onConnectError)
      if (!deniedRef.current) socket.emit('thread:leave', { threadId })
      setViewers([])
      setComposers([])
    }
  }, [threadId])

  /* Composer transitions are edge-triggered; the heartbeat keeps them alive. */
  useEffect(() => {
    if (!PRESENCE_ENABLED || !threadId || deniedRef.current) return undefined
    const socket = getSocket()
    if (!socket) return undefined
    socket.emit('thread:composing', composing ? { threadId } : { threadId, composing: false })
    return undefined
  }, [threadId, composing])

  return { viewers, composers }
}

/** "Priya is viewing" / "Priya and Sam are viewing" / "3 people are viewing". */
function presencePhrase(people, verb) {
  const names = people.map((p) => p.name).filter(Boolean)
  if (names.length === 0) return ''
  if (names.length === 1) return `${names[0]} is ${verb}`
  if (names.length === 2) return `${names[0]} and ${names[1]} are ${verb}`
  return `${formatNumber(names.length)} people are ${verb}`
}

/**
 * F-4 presence, rendered.
 *
 * The composing banner is the point of the feature — it is what stops two
 * people sending the same reply — so it is prominent and announced. It is also
 * strictly advisory: nothing here disables or blocks the composer.
 */
function ThreadPresence({ threadId, composing, selfId }) {
  const { viewers, composers } = useThreadPresence(threadId, composing)

  /* The server includes the emitting socket in its own roster. */
  const others = useMemo(
    () => viewers.filter((v) => String(v.userId) !== String(selfId)),
    [viewers, selfId]
  )
  const otherComposers = useMemo(
    () => composers.filter((c) => String(c.userId) !== String(selfId)),
    [composers, selfId]
  )

  return (
    <div className="space-y-2">
      {others.length > 0 ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-subtle px-3 py-2">
          <Eye aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
          <AvatarGroup
            users={others.map((v) => ({ _id: v.userId, name: v.name }))}
            max={4}
            size="sm"
          />
          <span className="min-w-0 truncate text-xs text-fg-2">
            {presencePhrase(others, 'viewing this conversation')}
          </span>
        </div>
      ) : null}

      {/* The live region is mounted permanently — a region added at the same
          moment as its content is announced unreliably. Polite, not assertive:
          this must be heard, but interrupting a screen-reader user mid-sentence
          for advisory information is worse than telling them at the next pause.
          `Alert`'s own role is dropped so two live regions do not nest. */}
      <div aria-live="polite" aria-atomic="true">
        {otherComposers.length > 0 ? (
          <Alert role="presentation" variant="warning" title="Someone else is replying right now">
            {presencePhrase(otherComposers, 'writing a reply')} in this conversation. Check with
            them before you send, or the client gets two answers.
          </Alert>
        ) : null}
      </div>
    </div>
  )
}

function ThreadDrawer({
  open,
  threadId,
  thread,
  loading,
  error,
  canManage,
  users,
  selfId,
  onOpenChange,
  onRetry,
  onReplied,
}) {
  const messages = useMemo(() => thread?.messages || [], [thread])
  /* Reply into the conversation, not into whichever row happened to be
   * clicked: the newest INBOUND message is the one whose thread and RFC
   * headers the server threads the outgoing mail onto. */
  const replyTarget = useMemo(() => {
    const inbound = messages.filter((m) => m.direction !== 'outbound')
    return inbound.length > 0 ? inbound[inbound.length - 1] : messages[messages.length - 1] || null
  }, [messages])

  const firstResponse = formatDurationMinutes(thread?.firstResponseMinutes)

  /* Lifted so the presence banner and the composer are the same fact. */
  const [composing, setComposing] = useState(false)
  const [prevThread, setPrevThread] = useState(threadId)
  if (threadId !== prevThread) {
    setPrevThread(threadId)
    setComposing(false)
  }

  if (!open || !threadId) return null

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent
        size="lg"
        title={thread?.subject || 'Conversation'}
        description={
          thread
            ? `${formatNumber(thread.messageCount)} ${thread.messageCount === 1 ? 'message' : 'messages'} · ${
                (thread.participants || []).join(', ') || 'no participants recorded'
              }`
            : 'Loading the conversation…'
        }
        footer={
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        }
      >
        <div className="space-y-4">
          {/* F-4. Advisory only: it never disables or blocks the composer. */}
          <ThreadPresence threadId={threadId} composing={composing} selfId={selfId} />

          {thread ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <AwaitingBadge awaiting={Boolean(thread.hasUnansweredInbound)} />
                {thread.unreadCount > 0 ? (
                  <Badge variant="info">{formatNumber(thread.unreadCount)} unread by you</Badge>
                ) : null}
                <span className="text-xs text-fg-3">
                  Last activity {timeAgo(thread.lastMessageAt) || '—'}
                </span>
              </div>

              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-fg-3">Mailbox</dt>
                <dd className="min-w-0 break-words font-mono text-fg-2">
                  {thread.accountEmail || '—'}
                </dd>
                <dt className="text-fg-3">Started</dt>
                <dd className="text-fg-2 tabular">{formatAbsolute(thread.firstMessageAt)}</dd>
                <dt className="text-fg-3">First response</dt>
                {/* `null` means "no reply yet" — never zero minutes. */}
                <dd className={firstResponse ? 'text-fg-2 tabular' : 'text-fg-3'}>
                  {firstResponse || 'No reply sent yet'}
                </dd>
              </dl>
            </>
          ) : null}

          {error ? (
            <Alert
              variant="danger"
              title="Could not load this conversation"
              action={
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  Retry
                </Button>
              }
            >
              {error}
            </Alert>
          ) : null}

          {thread?.truncated ? (
            <Alert variant="warning" title="This conversation is longer than what is shown">
              Only the oldest {formatNumber(messages.length)} messages were loaded. The rest are
              still in the mailbox — open the thread in Gmail to read them.
            </Alert>
          ) : null}

          {loading ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-line bg-surface p-4">
                <SkeletonText lines={4} />
              </div>
              <div className="rounded-lg border border-line bg-surface p-4">
                <SkeletonText lines={4} />
              </div>
            </div>
          ) : null}

          {!loading && !error && messages.length === 0 ? (
            <EmptyState
              icon={MessageSquare}
              title="Nothing to show in this conversation"
              description="Every message in this thread has been deleted from the workspace."
            />
          ) : null}

          {/* Oldest first, exactly as the server returns them, so the newest
              message is the one nearest the composer. */}
          <div className="space-y-3">
            {messages.map((message) => (
              <ThreadMessage key={message._id} message={message} />
            ))}
          </div>

          {/* F-3. Extraction runs across the CONVERSATION here, not one
              message: `{ threadId }` is the whole point of the thread view. */}
          {canManage && messages.length > 0 ? (
            <ExtractActionsPanel
              threadId={threadId}
              users={users}
              linkedEmail={replyTarget?._id}
              onCreated={onReplied}
            />
          ) : null}

          {canManage && replyTarget ? (
            <ReplyComposer
              emailId={replyTarget._id}
              to={replyTarget.from}
              onSent={onReplied}
              onDraftChange={setComposing}
            />
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

/* -------------------------------------------------------------------------- */
/* Dialogs                                                                     */
/* -------------------------------------------------------------------------- */

function AssignDialog({ open, onOpenChange, emailIds, users, onAssigned }) {
  const [assignee, setAssignee] = useState('')
  const [deadline, setDeadline] = useState('')
  const [priority, setPriority] = useState('Medium')
  const [taskStatus, setTaskStatus] = useState('Pending')
  const [saving, setSaving] = useState(false)

  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open) {
      setAssignee('')
      setDeadline('')
      setPriority('Medium')
      setTaskStatus('Pending')
    }
  }

  const options = useMemo(
    () =>
      users.map((u) => ({
        value: u._id,
        label: u.name || u.email || 'Unnamed user',
        group: u.role ? `${u.role}s` : 'Team',
      })),
    [users]
  )

  const submit = async () => {
    if (!assignee) return
    setSaving(true)
    try {
      const res = await api.post('/gmail/emails/bulk-assign', {
        emailIds,
        assignedTo: assignee,
        deadline: deadline || undefined,
        priority,
      })

      // POST /api/tasks/bulk was implemented server-side and never called.
      // Applying the chosen opening status to the freshly created tasks is the
      // natural, single-round-trip use for it.
      const taskIds = (res.data?.tasks || []).map((t) => t._id).filter(Boolean)
      if (taskStatus !== 'Pending' && taskIds.length) {
        await api.post('/tasks/bulk', { taskIds, action: 'status', value: taskStatus })
      }

      toast.success(res.data?.message || `Assigned ${emailIds.length} emails`)
      onOpenChange(false)
      onAssigned()
    } catch (err) {
      toast.error('Could not assign these emails', { description: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="md"
        title={`Assign ${emailIds.length} ${emailIds.length === 1 ? 'email' : 'emails'} as tasks`}
        description="One task is created per email and linked back to it."
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button variant="primary" loading={saving} disabled={!assignee} onClick={submit}>
              Create tasks
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Assignee" required>
            {(field) => (
              <SelectMenu
                id={field.id}
                ariaLabel="Assignee"
                value={assignee}
                onValueChange={setAssignee}
                options={options}
                placeholder="Choose a team member"
              />
            )}
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Deadline" hint="Defaults to three days from now">
              {(field) => (
                <Input
                  {...field}
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                />
              )}
            </FormField>
            <FormField label="Priority">
              {(field) => (
                <Select
                  {...field}
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                  options={PRIORITY_OPTIONS}
                />
              )}
            </FormField>
          </div>

          <FormField label="Opening task status">
            {(field) => (
              <Select
                {...field}
                value={taskStatus}
                onChange={(e) => setTaskStatus(e.target.value)}
                options={TASK_STATUS_OPTIONS}
              />
            )}
          </FormField>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AccountsDialog({ open, onOpenChange, status, isAdmin, onChanged }) {
  const confirm = useConfirm()
  const [connecting, setConnecting] = useState(false)
  const [removing, setRemoving] = useState('')

  const linked = status?.linkedAccounts || []

  const connect = async () => {
    setConnecting(true)
    try {
      const res = await api.get('/gmail/auth-url?mode=extra')
      if (res.data?.authUrl) window.location.href = res.data.authUrl
      else toast.error('The server did not return an authorisation URL')
    } catch (err) {
      toast.error('Could not start the Gmail connection', { description: getErrorMessage(err) })
    } finally {
      setConnecting(false)
    }
  }

  const disconnect = async (account) => {
    const label = account.gmailEmail || 'this account'
    const ok = await confirm({
      title: `Disconnect ${label}?`,
      description: 'Emails fetched from this account are removed from the workspace inbox.',
      confirmLabel: 'Disconnect account',
      cancelLabel: 'Keep connected',
      tone: 'danger',
    })
    if (!ok) return

    setRemoving(account.gmailEmail || account.userId)
    try {
      await api.delete('/gmail/linked-account', {
        data: { gmailEmail: account.gmailEmail || undefined, userId: account.userId },
      })
      toast.success(`${label} disconnected`)
      onChanged()
    } catch (err) {
      toast.error('Could not disconnect the account', { description: getErrorMessage(err) })
    } finally {
      setRemoving('')
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Connected Gmail accounts"
        description="Mail from every connected account is merged into this inbox."
        headerActions={
          isAdmin ? (
            <Button
              size="sm"
              variant="primary"
              loading={connecting}
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={connect}
            >
              Connect another
            </Button>
          ) : null
        }
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        }
      >
        {!status?.gmailEmail && linked.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="No Gmail account is connected"
            description="Connect a mailbox from the dashboard to start syncing mail into the workspace."
          />
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {status?.gmailEmail ? (
              <li className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-fg">{status.gmailEmail}</p>
                  <p className="mt-0.5 text-xs text-fg-3">Primary workspace mailbox</p>
                </div>
                <Badge variant={status.connected ? 'success' : 'warning'}>
                  {status.connected ? 'Connected' : 'Token expired'}
                </Badge>
              </li>
            ) : null}

            {linked.map((account) => (
              <li
                key={account.gmailEmail || account.userId}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm text-fg">
                    {account.gmailEmail || 'Incomplete connection'}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-3">
                    {account.ownerName ? `Connected by ${account.ownerName}` : 'Linked account'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant={account.connected ? 'success' : 'warning'}>
                    {account.connected ? 'Connected' : 'Token expired'}
                  </Badge>
                  {isAdmin ? (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      leftIcon={<Unlink className="h-3.5 w-3.5" />}
                      loading={removing === (account.gmailEmail || account.userId)}
                      onClick={() => disconnect(account)}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Primary actions for the page header. Destructive "clear all" lives inside
 *  the overflow menu, never as a red button on the toolbar. */
function HeaderActions({
  isAdmin,
  syncing,
  exporting,
  hasExported,
  pendingApprovals,
  onSync,
  onExport,
  onOpenKeywords,
  onOpenAccounts,
  onClearAll,
}) {
  return (
    <>
      <Button
        variant="primary"
        loading={syncing}
        leftIcon={<RefreshCw className="h-4 w-4" />}
        onClick={onSync}
      >
        Sync now
      </Button>

      <Button variant="secondary" leftIcon={<KeyRound className="h-4 w-4" />} onClick={onOpenKeywords}>
        Keyword rules
        {pendingApprovals > 0 ? (
          <CountBadge className="ml-1.5" count={pendingApprovals} variant="danger" />
        ) : null}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" iconOnly aria-label="More inbox actions">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Workspace</DropdownMenuLabel>
          <DropdownMenuItem onSelect={onOpenAccounts}>
            <Settings className="h-4 w-4" />
            Connected accounts
          </DropdownMenuItem>
          <DropdownMenuItem disabled={exporting} onSelect={onExport}>
            <Download className="h-4 w-4" />
            {exporting ? 'Exporting…' : 'Export this view (.xls)'}
          </DropdownMenuItem>
          {isAdmin ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive disabled={!hasExported} onSelect={onClearAll}>
                <Trash2 className="h-4 w-4" />
                {hasExported ? 'Clear all emails' : 'Clear all — export first'}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Dense column set: 40px rows, one line per email, subject + snippet in the
 * primary cell exactly as a mail client does it.
 *
 * Unread emphasis is real since S-16: every row carries an `isRead` derived for
 * the requesting user. It used to be faked from `status === 'unassigned'`,
 * which meant an assigned email you had never opened read as "already seen".
 *
 * Column ids are the server's sort field names (`EMAIL_SORT_FIELDS` in
 * `gmailController.js`); only those columns get a sortable header. The opener
 * button that j/k focuses comes from `rowActivation="cell"` on the table.
 */
function buildColumns({ canDelete, onOpen, onAssign, onDelete, onToggleRead }) {
  return [
    {
      accessorKey: 'from',
      meta: { width: '200px' },
      header: 'From',
      cell: ({ row }) => {
        const unread = isUnread(row.original)
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                unread ? 'bg-primary-600' : 'bg-transparent'
              )}
            />
            <span className={cn('truncate', unread ? 'font-medium text-fg' : 'text-fg-2')}>
              {row.original.from || 'Unknown sender'}
            </span>
            {/* The dot is decorative; this is what a screen reader hears. */}
            <span className="sr-only">{unread ? 'Unread' : 'Read'}</span>
          </span>
        )
      },
    },
    {
      accessorKey: 'subject',
      /* The row opener — DataTable wraps this cell in the real
       * <button data-row-open> that Enter activates and j/k focus. */
      meta: { primary: true, rowOpener: true },
      header: 'Subject',
      cell: ({ row }) => {
        const email = row.original
        return (
          <span
            className={cn(
              'block truncate',
              isUnread(email) ? 'font-medium text-fg' : 'text-fg-2'
            )}
          >
            {email.subject || '(no subject)'}
            {email.snippet ? <span className="font-normal text-fg-3"> — {email.snippet}</span> : null}
          </span>
        )
      },
    },
    {
      id: 'account',
      enableSorting: false,
      meta: { width: '190px' },
      header: 'Mailbox',
      cell: ({ row }) => (
        <span className="truncate font-mono text-xs text-fg-3">{accountOf(row.original) || '—'}</span>
      ),
    },
    {
      id: 'keyword',
      enableSorting: false,
      meta: { width: '130px' },
      header: 'Rule',
      cell: ({ row }) =>
        row.original.matchedKeyword ? (
          <Badge variant="info">{row.original.matchedKeyword}</Badge>
        ) : (
          <span className="text-fg-off">—</span>
        ),
    },
    {
      accessorKey: 'status',
      meta: { width: '120px' },
      header: 'Status',
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      accessorKey: 'date',
      meta: { width: '120px', numeric: true },
      header: 'Received',
      cell: ({ row }) => (
        <Tooltip content={formatAbsolute(row.original.date)}>
          <span className="tabular">{timeAgo(row.original.date) || '—'}</span>
        </Tooltip>
      ),
    },
    {
      id: 'actions',
      enableSorting: false,
      meta: { width: '56px', truncate: false },
      header: () => <span className="sr-only">Actions</span>,
      cell: ({ row }) => (
        <RowMenu
          email={row.original}
          canDelete={canDelete}
          onOpen={onOpen}
          onAssign={onAssign}
          onDelete={onDelete}
          onToggleRead={onToggleRead}
        />
      ),
    },
  ]
}

/**
 * Conversation columns (F-1).
 *
 * A row describes a whole thread, so there is no `_id`, no per-message status
 * and no body — `threadId` is the row key and `snippet` is the preview. Only
 * the ids the server actually sorts on carry a sortable header
 * (`THREAD_SORT_FIELDS`); everything else is explicitly `enableSorting: false`
 * so a header click cannot silently reorder just the visible page.
 */
function buildThreadColumns() {
  return [
    {
      id: 'participants',
      enableSorting: false,
      meta: { width: '210px' },
      header: 'Participants',
      cell: ({ row }) => {
        const people = row.original.participants || []
        const unread = (row.original.unreadCount || 0) > 0
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span
              aria-hidden="true"
              className={cn(
                'h-1.5 w-1.5 shrink-0 rounded-full',
                unread ? 'bg-primary-600' : 'bg-transparent'
              )}
            />
            <span className={cn('truncate', unread ? 'font-medium text-fg' : 'text-fg-2')}>
              {people[0] || row.original.latestFrom || 'Unknown sender'}
              {people.length > 1 ? (
                <span className="text-fg-3"> +{formatNumber(people.length - 1)}</span>
              ) : null}
            </span>
            <span className="sr-only">
              {unread ? `${row.original.unreadCount} unread by you` : 'No unread messages'}
            </span>
          </span>
        )
      },
    },
    {
      accessorKey: 'subject',
      meta: { primary: true, rowOpener: true },
      header: 'Conversation',
      cell: ({ row }) => {
        const thread = row.original
        const unread = (thread.unreadCount || 0) > 0
        return (
          <span className={cn('block truncate', unread ? 'font-medium text-fg' : 'text-fg-2')}>
            {thread.subject || '(no subject)'}
            {thread.snippet ? (
              <span className="font-normal text-fg-3"> — {thread.snippet}</span>
            ) : null}
          </span>
        )
      },
    },
    {
      id: 'awaiting',
      enableSorting: false,
      meta: { width: '150px' },
      header: 'Reply state',
      cell: ({ row }) => <AwaitingBadge awaiting={Boolean(row.original.hasUnansweredInbound)} />,
    },
    {
      accessorKey: 'messageCount',
      meta: { width: '100px', numeric: true },
      header: 'Messages',
      cell: ({ row }) => (
        <span className="tabular">{formatNumber(row.original.messageCount ?? 0)}</span>
      ),
    },
    {
      accessorKey: 'unreadCount',
      meta: { width: '90px', numeric: true },
      header: 'Unread',
      cell: ({ row }) => {
        const count = row.original.unreadCount || 0
        return count > 0 ? (
          <span className="tabular font-medium text-fg">{formatNumber(count)}</span>
        ) : (
          <span className="text-fg-off">—</span>
        )
      },
    },
    {
      accessorKey: 'lastMessageAt',
      meta: { width: '150px', numeric: true },
      header: 'Last message',
      cell: ({ row }) => {
        const outbound = row.original.lastDirection === 'outbound'
        return (
          <Tooltip content={formatAbsolute(row.original.lastMessageAt)}>
            <span className="inline-flex items-center justify-end gap-1.5 tabular">
              {outbound ? (
                <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5 text-fg-3" />
              ) : (
                <ArrowDownLeft aria-hidden="true" className="h-3.5 w-3.5 text-fg-3" />
              )}
              <span className="sr-only">{outbound ? 'We sent the last message.' : 'They sent the last message.'}</span>
              {timeAgo(row.original.lastMessageAt) || '—'}
            </span>
          </Tooltip>
        )
      },
    },
  ]
}

/* -------------------------------------------------------------------------- */
/* Filter toolbar                                                              */
/* -------------------------------------------------------------------------- */

/** Labelled filter select. The label is visually hidden but real — the toolbar
 *  has no room for six visible labels and `aria-label` alone is weaker. */
function FilterSelect({ id, label, width, value, options, onChange }) {
  return (
    <div className={width}>
      <Label htmlFor={id} className="sr-only">
        {label}
      </Label>
      <Select id={id} size="sm" value={value} options={options} onChange={onChange} />
    </div>
  )
}

function InboxFilters({ view, accounts, searchInput, onSearchChange, onFilter, onClearAll, searchRef }) {
  const dateActive = Boolean(view.from || view.to)
  const threadMode = view.group === 'thread'
  /* Only filters the ACTIVE endpoint understands count as active, so
   * "Clear filters" never claims to have cleared something invisible. */
  const anyActive = threadMode
    ? Boolean(view.q || view.account || view.from || view.to || view.unanswered || view.unread)
    : Boolean(
        view.q || view.account || view.status || view.read || view.keyword || view.from || view.to
      )

  return (
    <Toolbar
      left={
        <>
          <div className="w-[280px]">
            <Label htmlFor="inbox-search" className="sr-only">
              Search emails by subject or sender
            </Label>
            <Input
              id="inbox-search"
              ref={searchRef}
              type="search"
              size="sm"
              value={searchInput}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Search subject or sender…  ( / )"
              leadingIcon={<Search />}
            />
          </div>

          {accounts.length > 1 ? (
            <FilterSelect
              id="inbox-account"
              label="Filter by mailbox"
              width="w-[220px]"
              value={view.account}
              onChange={(e) => onFilter({ account: e.target.value })}
              options={[
                { value: '', label: 'All mailboxes' },
                ...accounts.map((a) => ({ value: a, label: a })),
              ]}
            />
          ) : null}

          {threadMode ? (
            <>
              {/* The backlog view. The server deliberately ships no separate
                  "breach list" endpoint — this filter IS it. */}
              <Button
                size="sm"
                variant={view.unanswered ? 'primary' : 'secondary'}
                aria-pressed={Boolean(view.unanswered)}
                leftIcon={<Clock className="h-4 w-4" />}
                onClick={() => onFilter({ unanswered: view.unanswered ? '' : 'true' })}
              >
                Awaiting reply
              </Button>
              <Button
                size="sm"
                variant={view.unread ? 'primary' : 'secondary'}
                aria-pressed={Boolean(view.unread)}
                leftIcon={<MailOpen className="h-4 w-4" />}
                onClick={() => onFilter({ unread: view.unread ? '' : 'true' })}
              >
                Unread by me
              </Button>
            </>
          ) : (
            <>
              <FilterSelect
                id="inbox-status"
                label="Filter by status"
                width="w-[150px]"
                value={view.status}
                options={STATUS_OPTIONS}
                onChange={(e) => onFilter({ status: e.target.value })}
              />

              <FilterSelect
                id="inbox-read"
                label="Filter by your read state"
                width="w-[170px]"
                value={view.read}
                options={READ_OPTIONS}
                onChange={(e) => onFilter({ read: e.target.value })}
              />

              <FilterSelect
                id="inbox-keyword"
                label="Filter by keyword rule"
                width="w-[160px]"
                value={view.keyword}
                options={KEYWORD_OPTIONS}
                onChange={(e) => onFilter({ keyword: e.target.value })}
              />
            </>
          )}

          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant={dateActive ? 'primary' : 'secondary'} leftIcon={<CalendarDays className="h-4 w-4" />}>
                {dateActive ? `${view.from || 'Any'} to ${view.to || 'now'}` : 'Date range'}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[260px] space-y-3">
              <FormField label="Received from">
                {(field) => (
                  <Input
                    {...field}
                    type="date"
                    size="sm"
                    value={view.from}
                    onChange={(e) => onFilter({ from: e.target.value })}
                  />
                )}
              </FormField>
              <FormField label="Received to">
                {(field) => (
                  <Input
                    {...field}
                    type="date"
                    size="sm"
                    value={view.to}
                    onChange={(e) => onFilter({ to: e.target.value })}
                  />
                )}
              </FormField>
              <Button
                size="sm"
                variant="ghost"
                fullWidth
                disabled={!dateActive}
                onClick={() => onFilter({ from: '', to: '' })}
              >
                Clear dates
              </Button>
            </PopoverContent>
          </Popover>

          {anyActive ? (
            <Button size="sm" variant="ghost" leftIcon={<X className="h-4 w-4" />} onClick={onClearAll}>
              Clear filters
            </Button>
          ) : null}
        </>
      }
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Page                                                                        */
/* -------------------------------------------------------------------------- */

export default function EmailInbox() {
  const { user, isAdmin, isHead } = useAuth()
  const userId = user?._id
  const flagKey = downloadFlagKey(userId)
  const canManage = isAdmin || isHead
  const confirm = useConfirm()
  const { view, patch } = useInboxParams()

  const listRef = useRef(null)
  const searchRef = useRef(null)
  const searchTimer = useRef(0)

  const [searchInput, setSearchInput] = useState(view.q)
  const [prevQ, setPrevQ] = useState(view.q)
  if (view.q !== prevQ) {
    // Documented React pattern for adjusting state when an input changes —
    // keeps the box in step with back/forward navigation.
    setPrevQ(view.q)
    setSearchInput(view.q)
  }

  const [listNonce, setListNonce] = useState(0)
  const [auxNonce, setAuxNonce] = useState(0)
  const [selection, setSelection] = useState({})
  const [syncing, setSyncing] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [assignIds, setAssignIds] = useState(null)
  const [showAccounts, setShowAccounts] = useState(false)
  const [showKeywords, setShowKeywords] = useState(false)
  const [hasExported, setHasExported] = useState(() => {
    try {
      return window.localStorage.getItem(downloadFlagKey(userId)) === 'true'
    } catch {
      return false
    }
  })

  /* ---- data ------------------------------------------------------------- */

  const listParams = useMemo(
    () => ({
      page: view.page,
      limit: view.limit,
      sort: view.sort,
      category: view.tab,
      ...(view.q ? { q: view.q } : {}),
      ...(view.account ? { accountEmail: view.account } : {}),
      ...(view.status ? { status: view.status } : {}),
      ...(view.read ? { read: view.read } : {}),
      ...(view.keyword ? { keyword: view.keyword } : {}),
      ...(view.from ? { from: view.from } : {}),
      ...(view.to ? { to: view.to } : {}),
    }),
    [view]
  )

  /* F-1 conversation list. `q` and the date range select MESSAGES server-side
   * and are then resolved to a thread-id set, so the counters on a row still
   * describe the whole conversation. */
  const threadParams = useMemo(
    () => ({
      page: view.page,
      limit: view.limit,
      sort: view.threadSort,
      ...(view.q ? { q: view.q } : {}),
      ...(view.account ? { accountEmail: view.account } : {}),
      ...(view.from ? { dateFrom: view.from } : {}),
      ...(view.to ? { dateTo: view.to } : {}),
      ...(view.unanswered ? { unanswered: 'true' } : {}),
      ...(view.unread ? { unread: 'true' } : {}),
    }),
    [view]
  )

  const threadMode = view.group === 'thread'
  /* Exactly one list is ever in flight: the inactive mode passes '' and its
   * hook does not fetch at all. */
  const paramsJson = useMemo(
    () => (canManage && !threadMode ? JSON.stringify(listParams) : ''),
    [canManage, listParams, threadMode]
  )
  const threadParamsJson = useMemo(
    () => (canManage && threadMode ? JSON.stringify(threadParams) : ''),
    [canManage, threadMode, threadParams]
  )

  const messageList = useEmailList('/gmail/emails', paramsJson, listNonce)
  const threadList = useEmailList(
    '/gmail/threads',
    threadParamsJson,
    listNonce,
    'Could not load conversations.'
  )
  const { rows, total, loading, error } = threadMode ? threadList : messageList
  const { patchRows } = messageList
  const aux = useInboxAux(canManage, auxNonce)
  const detail = useEmailDetail(canManage && !threadMode ? view.openId : '', listNonce)
  const threadDetail = useThreadDetail(
    canManage && threadMode ? view.openThreadId : '',
    listNonce
  )

  const accounts = useMemo(() => {
    const all = [
      aux.status?.gmailEmail,
      ...(aux.status?.linkedAccounts || []).map((a) => a.gmailEmail),
    ].filter(Boolean)
    return Array.from(new Set(all))
  }, [aux.status])

  const selectedIds = useMemo(
    () => Object.keys(selection).filter((id) => selection[id]),
    [selection]
  )
  const openSummary = useMemo(
    () => rows.find((r) => r._id === view.openId) || null,
    [rows, view.openId]
  )

  const refresh = useCallback(() => setListNonce((n) => n + 1), [])
  const refreshAll = useCallback(() => {
    setListNonce((n) => n + 1)
    setAuxNonce((n) => n + 1)
  }, [])

  /* Auto-refresh. `refresh` is stable, so the interval is created once — the
   * old implementation rebuilt it on every keystroke. */
  useEffect(() => {
    const id = window.setInterval(refresh, AUTO_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => () => window.clearTimeout(searchTimer.current), [])

  /* ---- handlers --------------------------------------------------------- */

  const applyFilter = useCallback(
    (next) => {
      setSelection({})
      patch(next)
    },
    [patch]
  )

  const onSearchChange = useCallback(
    (value) => {
      setSearchInput(value)
      window.clearTimeout(searchTimer.current)
      searchTimer.current = window.setTimeout(() => applyFilter({ q: value.trim() }), SEARCH_DEBOUNCE_MS)
    },
    [applyFilter]
  )

  const clearFilters = useCallback(() => {
    setSearchInput('')
    applyFilter({
      q: '',
      account: '',
      status: '',
      read: '',
      keyword: '',
      from: '',
      to: '',
      unanswered: '',
      unread: '',
    })
  }, [applyFilter])

  const focusSearch = useCallback(() => searchRef.current?.focus(), [])

  /* Real sortable headers write straight to `?sort=`; the server does the
   * ordering, so the visible page is never silently re-sorted on its own. */
  const sorting = useMemo(
    () => [
      { id: view.sort.startsWith('-') ? view.sort.slice(1) : view.sort, desc: view.sort.startsWith('-') },
    ],
    [view.sort]
  )

  const handleSortingChange = useCallback(
    (next) => {
      const [s] = next
      applyFilter({ sort: s ? `${s.desc ? '-' : ''}${s.id}` : DEFAULT_SORT })
    },
    [applyFilter]
  )

  const threadSorting = useMemo(
    () => [
      {
        id: view.threadSort.startsWith('-') ? view.threadSort.slice(1) : view.threadSort,
        desc: view.threadSort.startsWith('-'),
      },
    ],
    [view.threadSort]
  )

  const handleThreadSortingChange = useCallback(
    (next) => {
      const [s] = next
      applyFilter({ tsort: s ? `${s.desc ? '-' : ''}${s.id}` : DEFAULT_THREAD_SORT })
    },
    [applyFilter]
  )

  const openEmail = useCallback(
    (email) => patch({ id: email._id }, { resetPage: false }),
    [patch]
  )
  const closeEmail = useCallback(() => patch({ id: '' }, { resetPage: false }), [patch])

  const openThread = useCallback(
    (thread) => patch({ thread: thread.threadId }, { resetPage: false }),
    [patch]
  )
  const closeThread = useCallback(() => patch({ thread: '' }, { resetPage: false }), [patch])

  /* Switching mode closes whichever reading pane was open and drops the other
   * mode's row selection — the two lists do not share a row identity. */
  const setGroup = useCallback(
    (group) => {
      setSelection({})
      applyFilter({ group: group === 'thread' ? 'thread' : '', id: '', thread: '' })
    },
    [applyFilter]
  )

  /* ---- read state (S-16) ------------------------------------------------ */

  /**
   * Read state is a per-user relation on a shared mailbox, so this only ever
   * changes what the signed-in user sees — never what a colleague sees.
   *
   * The rows are patched locally rather than refetched: a `?read=` filter would
   * otherwise make a row vanish from under the pointer the moment it is marked,
   * and re-running the query would also lose the scroll position.
   */
  const markRead = useCallback(
    async (ids, read, { silent = false } = {}) => {
      if (!Array.isArray(ids) || ids.length === 0) return
      const readAt = read ? new Date().toISOString() : null
      patchRows(ids, { isRead: read, readAt })
      try {
        if (ids.length === 1) {
          await api.patch(`/gmail/emails/${ids[0]}/read`, { read })
        } else {
          const res = await api.patch('/gmail/emails/read', { ids, read })
          const failed = Number(res.data?.failed) || 0
          if (failed > 0) {
            const rejected = (res.data?.results || [])
              .filter((r) => r && !r.ok)
              .map((r) => r.id)
            patchRows(rejected, { isRead: !read, readAt: read ? null : readAt })
            toast.warning(
              `${ids.length - failed} marked as ${read ? 'read' : 'unread'}, ${failed} could not be changed`
            )
            return
          }
        }
        if (!silent) {
          toast.success(
            ids.length === 1
              ? `Email marked as ${read ? 'read' : 'unread'}`
              : `${formatNumber(ids.length)} emails marked as ${read ? 'read' : 'unread'}`
          )
        }
      } catch (err) {
        // Roll the optimistic patch back so the list never lies.
        patchRows(ids, { isRead: !read, readAt: read ? null : readAt })
        if (!silent) {
          toast.error('Could not update the read state', { description: getErrorMessage(err) })
        }
      }
    },
    [patchRows]
  )

  const [marking, setMarking] = useState('')

  const markSelected = useCallback(
    async (read) => {
      setMarking(read ? 'read' : 'unread')
      try {
        await markRead(selectedIds, read)
      } finally {
        setMarking('')
      }
    },
    [markRead, selectedIds]
  )

  /* Opening the reading pane marks the message read — the server deliberately
   * does NOT do this on GET, so that a prefetch cannot clear the badge. */
  const openId = view.openId
  const openedUnread = openSummary ? isUnread(openSummary) : false
  useEffect(() => {
    if (!canManage || !openId || !openedUnread) return
    markRead([openId], true, { silent: true })
  }, [canManage, openId, openedUnread, markRead])

  const deleteEmail = useCallback(
    async (email) => {
      const ok = await confirm({
        title: `Delete “${email.subject || 'this email'}”?`,
        description: 'The message is removed from the workspace and unlinked from any task.',
        confirmLabel: 'Delete email',
        cancelLabel: 'Keep email',
        tone: 'danger',
      })
      if (!ok) return
      try {
        await api.delete(`/gmail/emails/${email._id}`)
        toast.success('Email deleted')
        if (view.openId === email._id) closeEmail()
        refresh()
      } catch (err) {
        toast.error('Could not delete the email', { description: getErrorMessage(err) })
      }
    },
    [confirm, closeEmail, refresh, view.openId]
  )

  const deleteSelected = useCallback(async () => {
    const ids = selectedIds
    // DELETE /api/gmail/emails with NO body still means "clear the whole
    // inbox". Sending an empty array would be read as a bulk delete of nothing,
    // but there is no reason to make the round trip at all.
    if (ids.length === 0) return

    const ok = await confirm({
      title: `Delete ${ids.length} ${ids.length === 1 ? 'email' : 'emails'}?`,
      description: 'They are removed from the workspace and unlinked from their tasks.',
      confirmLabel: `Delete ${ids.length}`,
      cancelLabel: 'Keep them',
      tone: 'danger',
    })
    if (!ok) return

    setDeleting(true)
    try {
      // S-15: one scoped bulk delete. This used to fan out N x
      // `DELETE /gmail/emails/:id` through `Promise.allSettled`. The `{ ids }`
      // body is what distinguishes it from the Admin-only "clear all" on the
      // same URL, so it is always sent.
      const res = await api.delete('/gmail/emails', { data: { ids } })
      const deleted = Number(res.data?.deleted ?? ids.length)
      const failed = Number(res.data?.failed ?? 0)

      if (failed > 0) {
        // Per-id results, so a partial failure names its reason rather than
        // being reported as a bare count.
        const reasons = Array.from(
          new Set(
            (res.data?.results || [])
              .filter((r) => r && !r.ok)
              .map((r) => r.message)
              .filter(Boolean)
          )
        )
        toast.warning(`${formatNumber(deleted)} deleted, ${formatNumber(failed)} could not be deleted`, {
          description: reasons.join(' '),
        })
      } else {
        toast.success(
          `${formatNumber(deleted)} ${deleted === 1 ? 'email' : 'emails'} deleted`
        )
      }
      setSelection({})
      if (ids.includes(view.openId)) closeEmail()
      refresh()
    } catch (err) {
      toast.error('Could not delete the selected emails', { description: getErrorMessage(err) })
    } finally {
      setDeleting(false)
    }
  }, [closeEmail, confirm, refresh, selectedIds, view.openId])

  const syncNow = useCallback(async () => {
    setSyncing(true)
    try {
      const res = await api.post('/gmail/fetch')
      const count = res.data?.count ?? 0
      toast.success(count ? `Synced ${count} new emails` : 'Inbox is already up to date')
      if (count > 0) {
        setHasExported(false)
        try {
          window.localStorage.removeItem(flagKey)
        } catch {
          /* storage disabled — the lock simply stays open */
        }
      }
      refreshAll()
    } catch (err) {
      toast.error('Sync failed', { description: getErrorMessage(err) })
    } finally {
      setSyncing(false)
    }
  }, [flagKey, refreshAll])

  const exportView = useCallback(async () => {
    setExporting(true)
    try {
      const collected = []
      let page = 1
      let pages = 1
      do {
        const res = await api.get('/gmail/emails', {
          params: { ...listParams, page, limit: EXPORT_PAGE_SIZE },
        })
        const { rows: batch, pagination } = readList(res.data)
        collected.push(...batch)
        pages = pagination?.totalPages ?? 1
        page += 1
      } while (page <= pages && page <= EXPORT_MAX_PAGES)

      if (collected.length === 0) {
        toast.warning('There is nothing to export in this view')
        return
      }

      const stamp = new Date().toISOString().slice(0, 10)
      downloadBlob(
        new Blob([buildWorkbook(collected)], { type: 'application/vnd.ms-excel;charset=utf-8;' }),
        `inbox-backup-${stamp}.xls`
      )
      setHasExported(true)
      try {
        window.localStorage.setItem(flagKey, 'true')
      } catch {
        /* storage disabled — deletion stays locked, which is the safe default */
      }
      toast.success(`Exported ${collected.length} emails`, {
        description: 'Deletion is now unlocked for this browser.',
      })
    } catch (err) {
      toast.error('Export failed', { description: getErrorMessage(err) })
    } finally {
      setExporting(false)
    }
  }, [flagKey, listParams])

  /* The typed challenge is the shared dialog's (`requireTyped`); only the
   * consequence summary was ever page-specific. */
  const clearAllEmails = useCallback(async () => {
    const ok = await confirm({
      title: 'Clear every email in the workspace?',
      description: (
        <>
          <p>This removes all synced emails and unlinks them from their tasks.</p>
          <p className="mt-2">
            {formatNumber(total)} {total === 1 ? 'email is' : 'emails are'} in the current view.
            Export a backup before continuing. Tasks created from these emails keep their history
            but lose the linked message.
          </p>
        </>
      ),
      confirmLabel: 'Clear all emails',
      cancelLabel: 'Keep emails',
      tone: 'danger',
      requireTyped: { value: CLEAR_ALL_PHRASE },
    })
    if (!ok) return

    try {
      const res = await api.delete('/gmail/emails')
      toast.success(res.data?.message || 'All emails cleared')
      setSelection({})
      refreshAll()
    } catch (err) {
      toast.error('Could not clear the inbox', { description: getErrorMessage(err) })
    }
  }, [confirm, refreshAll, total])

  /* ---- command palette --------------------------------------------------- */

  useRegisterCommands(
    canManage
      ? [
          {
            id: 'inbox-sync',
            label: 'Sync inbox now',
            group: 'Inbox',
            icon: <RefreshCw className="h-4 w-4" />,
            keywords: ['fetch', 'gmail', 'refresh'],
            onSelect: syncNow,
          },
          {
            id: 'inbox-search',
            label: 'Search emails',
            group: 'Inbox',
            icon: <Search className="h-4 w-4" />,
            keywords: ['find', 'subject', 'sender'],
            onSelect: focusSearch,
          },
          {
            id: 'inbox-toggle-group',
            label: threadMode ? 'Switch to messages' : 'Switch to conversations',
            group: 'Inbox',
            icon: <MessageSquare className="h-4 w-4" />,
            keywords: ['thread', 'conversation', 'grouped', 'view'],
            onSelect: () => setGroup(threadMode ? 'message' : 'thread'),
          },
          {
            id: 'inbox-unanswered',
            label: 'Show conversations awaiting a reply',
            group: 'Inbox',
            icon: <Clock className="h-4 w-4" />,
            keywords: ['backlog', 'sla', 'breach', 'unanswered', 'thread'],
            onSelect: () => applyFilter({ group: 'thread', unanswered: 'true', id: '' }),
          },
          {
            id: 'inbox-toggle-unread',
            label: view.read === 'false' ? 'Show read and unread' : 'Show unread only',
            group: 'Inbox',
            icon: <MailOpen className="h-4 w-4" />,
            keywords: ['unread', 'new', 'filter'],
            onSelect: () => applyFilter({ read: view.read === 'false' ? '' : 'false' }),
          },
          {
            id: 'inbox-toggle-unassigned',
            label:
              view.status === 'unassigned'
                ? 'Show emails of any status'
                : 'Show unassigned emails only',
            group: 'Inbox',
            icon: <InboxIcon className="h-4 w-4" />,
            keywords: ['needs attention', 'filter'],
            onSelect: () =>
              applyFilter({ status: view.status === 'unassigned' ? '' : 'unassigned' }),
          },
          {
            id: 'inbox-clear-filters',
            label: 'Clear inbox filters',
            group: 'Inbox',
            icon: <X className="h-4 w-4" />,
            keywords: ['reset', 'all mail'],
            onSelect: clearFilters,
          },
          {
            id: 'inbox-keyword-rules',
            label: 'Open keyword rules',
            group: 'Inbox',
            icon: <KeyRound className="h-4 w-4" />,
            keywords: ['approvals', 'automation'],
            onSelect: () => setShowKeywords(true),
          },
        ]
      : [],
    [
      canManage,
      syncNow,
      focusSearch,
      applyFilter,
      clearFilters,
      setGroup,
      threadMode,
      view.status,
      view.read,
    ]
  )

  /* ---- keyboard --------------------------------------------------------- */

  const overlayOpen =
    Boolean(view.openId) ||
    Boolean(view.openThreadId) ||
    Boolean(assignIds) ||
    showAccounts ||
    showKeywords

  useEffect(() => {
    const moveFocus = (delta) => {
      const nodes = Array.from(listRef.current?.querySelectorAll('[data-row-open]') || [])
      if (nodes.length === 0) return
      const index = nodes.indexOf(document.activeElement)
      const next =
        index === -1
          ? delta > 0
            ? 0
            : nodes.length - 1
          : Math.min(nodes.length - 1, Math.max(0, index + delta))
      nodes[next].focus()
      nodes[next].scrollIntoView({ block: 'nearest' })
    }

    const onKeyDown = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      // A drawer or dialog owns the keyboard while it is open (Radix handles
      // Escape, focus trapping and arrow keys inside it).
      if (overlayOpen) return
      const target = event.target
      const tag = target?.tagName
      const typing =
        tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable

      if (event.key === '/' && !typing) {
        event.preventDefault()
        searchRef.current?.focus()
        return
      }
      if (typing) return

      switch (event.key) {
        case 'j':
          event.preventDefault()
          moveFocus(1)
          break
        case 'k':
          event.preventDefault()
          moveFocus(-1)
          break
        case 'x': {
          // Conversation rows are not selectable — a thread id is not an email
          // id, and every bulk action on this page takes email ids.
          if (threadMode) return
          const id = document.activeElement?.getAttribute?.('data-row-open')
          if (!id) return
          event.preventDefault()
          setSelection((prev) => ({ ...prev, [id]: !prev[id] }))
          break
        }
        case 'Escape':
          setSelection((prev) => (Object.keys(prev).length ? {} : prev))
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlayOpen, threadMode])

  /* ---- columns ---------------------------------------------------------- */

  const columns = useMemo(
    () =>
      buildColumns({
        canDelete: hasExported,
        onOpen: openEmail,
        onAssign: setAssignIds,
        onDelete: deleteEmail,
        onToggleRead: markRead,
      }),
    [deleteEmail, hasExported, openEmail, markRead]
  )

  const threadColumns = useMemo(() => buildThreadColumns(), [])

  /* ---- render ----------------------------------------------------------- */

  if (!canManage) {
    return (
      <>
        <PageHeader title="Inbox" description="Shared workspace mail" />
        <PageBody>
          <Alert variant="info" title="The shared inbox is limited to Admins and Heads">
            Your assigned work is on the Tasks screen, with the source email attached to each task.
            <div className="mt-2">
              <Button as={Link} to="/tasks" variant="link">
                Go to my tasks
              </Button>
            </div>
          </Alert>
        </PageBody>
      </>
    )
  }

  const filtered = threadMode
    ? Boolean(view.q || view.account || view.from || view.to || view.unanswered || view.unread)
    : Boolean(
        view.q || view.account || view.status || view.read || view.keyword || view.from || view.to
      )

  return (
    <>
      <PageHeader
        title="Inbox"
        description="Every synced mailbox in one queue. Convert mail into assigned work."
        actions={
          <HeaderActions
            isAdmin={isAdmin}
            syncing={syncing}
            exporting={exporting}
            hasExported={hasExported}
            pendingApprovals={aux.pendingApprovals}
            onSync={syncNow}
            onExport={exportView}
            onOpenKeywords={() => setShowKeywords(true)}
            onOpenAccounts={() => setShowAccounts(true)}
            onClearAll={clearAllEmails}
          />
        }
      />

      <Toolbar
        left={
          /* Gmail's category labels are a MESSAGE property; the thread endpoint
             has no `category` parameter, so the tabs are not rendered in
             conversation mode rather than shown doing nothing. */
          threadMode ? (
            <p className="text-sm text-fg-2">
              {loading
                ? 'Loading conversations…'
                : `${formatNumber(total)} ${total === 1 ? 'conversation' : 'conversations'}`}
              <span className="ml-2 text-fg-3">
                Replies we sent are part of the thread, so an answered mail no longer looks
                untouched.
              </span>
            </p>
          ) : (
            <Tabs value={view.tab} onValueChange={(tab) => applyFilter({ tab })}>
              <TabsList className="border-b-0">
                {TABS.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    /* Only the active tab carries a count, and it is the same
                     * `pagination.total` that produced the rows below it. */
                    count={tab.value === view.tab && !loading ? formatNumber(total) : undefined}
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )
        }
        right={
          <>
            <SegmentedControl
              ariaLabel="Group mail by"
              value={view.group}
              onValueChange={setGroup}
              options={GROUP_OPTIONS}
            />
            <Tooltip content="Refresh the list">
              <Button variant="ghost" size="sm" iconOnly aria-label="Refresh the list" onClick={refresh}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </Tooltip>
          </>
        }
      />

      <InboxFilters
        view={view}
        accounts={accounts}
        searchInput={searchInput}
        searchRef={searchRef}
        onSearchChange={onSearchChange}
        onFilter={applyFilter}
        onClearAll={clearFilters}
      />

      {selectedIds.length > 0 ? (
        <BulkBar
          count={selectedIds.length}
          canDelete={hasExported}
          deleting={deleting}
          marking={marking}
          onAssign={() => setAssignIds(selectedIds)}
          onDelete={deleteSelected}
          onMarkRead={markSelected}
          onClear={() => setSelection({})}
        />
      ) : null}

      <PageBody fill className="space-y-3">
        {error ? (
          <Alert
            variant="danger"
            title="Could not load the inbox"
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : null}

        {!hasExported && isAdmin ? (
          <Alert variant="info" title="Deletion is locked">
            Export a backup of the inbox to unlock single and bulk deletion in this browser.
          </Alert>
        ) : null}

        {/* Part of the fill chain: this wrapper must pass the height
          * constraint through to the DataTable or the containment breaks. */}
        <div ref={listRef} className="flex min-h-0 flex-1 flex-col">
          {threadMode ? (
            <DataTable
              fill
              ariaLabel="Conversations"
              data={rows}
              columns={threadColumns}
              loading={loading}
              getRowId={(row) => row.threadId}
              onRowClick={openThread}
              rowActivation="cell"
              sorting={threadSorting}
              onSortingChange={handleThreadSortingChange}
              density="default"
              pagination={{
                page: view.page,
                pageSize: view.limit,
                total,
                itemLabel: 'conversations',
                onPageChange: (page) => patch({ page }, { resetPage: false }),
                onPageSizeChange: (limit) => applyFilter({ limit }),
              }}
              emptyState={
                filtered
                  ? {
                      icon: Search,
                      title: 'No conversations match these filters',
                      description: view.unanswered
                        ? 'Nothing in this mailbox is waiting on a reply — that is the good outcome.'
                        : 'Try a different mailbox, search term or date range.',
                      secondaryAction: { label: 'Clear filters', onClick: clearFilters },
                    }
                  : {
                      icon: MessageSquare,
                      title: 'No conversations yet',
                      description:
                        'Threads appear here once mail has been synced. Replies you send join the conversation they answer.',
                      action: { label: 'Sync now', onClick: syncNow },
                    }
              }
            />
          ) : (
            <DataTable
              fill
              ariaLabel="Workspace emails"
              data={rows}
              columns={columns}
              loading={loading}
              enableSelection
              rowSelection={selection}
              onRowSelectionChange={setSelection}
              getRowId={(row) => row._id}
              onRowClick={openEmail}
              rowActivation="cell"
              sorting={sorting}
              onSortingChange={handleSortingChange}
              density="default"
              pagination={{
                page: view.page,
                pageSize: view.limit,
                total,
                itemLabel: 'emails',
                onPageChange: (page) => {
                  setSelection({})
                  patch({ page }, { resetPage: false })
                },
                onPageSizeChange: (limit) => applyFilter({ limit }),
              }}
              emptyState={
                filtered
                  ? {
                      icon: Search,
                      title: 'No emails match these filters',
                      description: 'Try a different mailbox, status or date range.',
                      secondaryAction: { label: 'Clear filters', onClick: clearFilters },
                    }
                  : {
                      icon: InboxIcon,
                      title: 'Nothing in this folder yet',
                      description: 'New mail appears here after the next sync.',
                      action: { label: 'Sync now', onClick: syncNow },
                    }
              }
            />
          )}
        </div>

        <p className="text-xs text-fg-3">
          Keyboard: <kbd className="rounded-sm border border-line bg-subtle px-1">j</kbd> /{' '}
          <kbd className="rounded-sm border border-line bg-subtle px-1">k</kbd> move ·{' '}
          <kbd className="rounded-sm border border-line bg-subtle px-1">Enter</kbd> open ·{' '}
          <kbd className="rounded-sm border border-line bg-subtle px-1">x</kbd> select ·{' '}
          <kbd className="rounded-sm border border-line bg-subtle px-1">/</kbd> search ·{' '}
          <kbd className="rounded-sm border border-line bg-subtle px-1">Esc</kbd> close
        </p>

        <p className="text-xs text-fg-3">
          Read and unread are yours alone. This is a shared mailbox, so marking a message read does
          not change how it looks for anyone else.
        </p>
      </PageBody>

      <ThreadDrawer
        open={threadMode && Boolean(view.openThreadId)}
        threadId={view.openThreadId}
        thread={threadDetail.thread}
        loading={threadDetail.loading}
        error={threadDetail.error}
        canManage={canManage}
        users={aux.users}
        selfId={userId}
        onOpenChange={(next) => !next && closeThread()}
        onRetry={refresh}
        onReplied={refresh}
      />

      <EmailDrawer
        open={Boolean(view.openId)}
        summary={openSummary || (view.openId ? { _id: view.openId } : null)}
        email={detail.email}
        loading={detail.loading}
        error={detail.error}
        canManage={canManage}
        canDelete={hasExported}
        users={aux.users}
        onOpenChange={(next) => !next && closeEmail()}
        onAssign={setAssignIds}
        onDelete={deleteEmail}
        onToggleRead={markRead}
        onTasksCreated={refresh}
      />

      <AssignDialog
        open={Boolean(assignIds)}
        onOpenChange={(next) => !next && setAssignIds(null)}
        emailIds={assignIds || []}
        users={aux.users}
        onAssigned={() => {
          setAssignIds(null)
          setSelection({})
          refresh()
        }}
      />

      <AccountsDialog
        open={showAccounts}
        onOpenChange={setShowAccounts}
        status={aux.status}
        isAdmin={isAdmin}
        onChanged={refreshAll}
      />

      <KeywordApprovalModal
        isOpen={showKeywords}
        onClose={() => setShowKeywords(false)}
        onRuleUpdated={refreshAll}
      />
    </>
  )
}
