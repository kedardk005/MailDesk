import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Ban,
  Check,
  Mail,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserCog,
  Users,
  UserX,
  X,
} from 'lucide-react'
import api, { getErrorMessage, isCanceled } from '../../api/axios'
import { useAuth } from '../../components/AuthProvider'
import { useRegisterCommands } from '../../components/CommandRegistry'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  FormField,
  Input,
  PageBody,
  PageHeader,
  Select,
  Toolbar,
  Tooltip,
  toast,
  useConfirm,
} from '../../components/ui'
import { PASSWORD_MIN_LENGTH, isLongEnough } from '../../lib/passwordPolicy'
import { formatNumber, timeAgo } from '../../lib/utils'

/* ---------------------------------------------------------------------------
 * Constants — the role/status vocabularies mirror server/models/User.js and the
 * Zod schemas in server/middleware/schemas.js exactly.
 * ------------------------------------------------------------------------ */

const DEFAULT_SORT = '-createdAt'
const DEFAULT_LIMIT = 25
const PAGE_SIZES = [25, 50, 100]

/** POST /api/users accepts Head|Employee only. PUT /api/users/:id accepts all three. */
const CREATABLE_ROLES = ['Employee', 'Head']
const EDITABLE_ROLES = ['Employee', 'Head', 'Admin']
const STATUSES = ['Pending', 'Approved', 'Rejected']

const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All roles' },
  ...EDITABLE_ROLES.map((r) => ({ value: r, label: r })),
]

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All statuses' },
  ...STATUSES.map((s) => ({ value: s, label: s })),
]

/**
 * Sorting is server-side and lives in `?sort=`. `DataTable` is fed the same
 * state through `sorting`/`onSortingChange`, so the headers are real and the
 * visible page is never re-ordered locally.
 *
 * Mirrors `USER_SORT_FIELDS` in `server/controllers/userController.js` — a
 * column outside this list must not get a sortable header.
 */
const SORT_FIELDS = ['createdAt', 'name', 'email', 'role', 'status', 'lastLoginAt']

const ROLE_BADGE = { Admin: 'warning', Head: 'info', Employee: 'neutral' }
const STATUS_BADGE = { Approved: 'success', Pending: 'warning', Rejected: 'danger' }

const MAX_ACCOUNTS_CEILING = 50
const MAX_ALLOWED_ADDRESSES = 100
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

/* ---------------------------------------------------------------------------
 * Pure helpers
 * ------------------------------------------------------------------------ */

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : dateFormatter.format(d)
}

function formatDateTime(value) {
  if (!value) return 'Unknown'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? 'Unknown' : dateTimeFormatter.format(d)
}

/**
 * Accepts both shapes from docs/audits/API-LIST-CONTRACT.md:
 *   paginated -> { data: [...], pagination: {...} }
 *   legacy    -> [...]        (bare array, capped server-side)
 * `pagination: null` tells the caller it must page/filter/sort locally.
 */
function readList(payload) {
  if (Array.isArray(payload)) return { rows: payload, pagination: null }
  if (payload && Array.isArray(payload.data)) {
    return { rows: payload.data, pagination: payload.pagination || null }
  }
  return { rows: [], pagination: null }
}

/** Fallback view maths for the legacy (un-paginated) response shape. */
function applyLocalView(rows, { q, role, status, sort, page, limit }) {
  const needle = q.trim().toLowerCase()
  let out = rows.filter((u) => {
    if (role && u.role !== role) return false
    if (status && (u.status || 'Approved') !== status) return false
    if (!needle) return true
    return `${u.name || ''} ${u.email || ''} ${u.gmailEmail || ''}`.toLowerCase().includes(needle)
  })

  const desc = sort.startsWith('-')
  const field = desc ? sort.slice(1) : sort
  out = [...out].sort((a, b) => {
    const av = a?.[field]
    const bv = b?.[field]
    if (av === bv) return 0
    if (av == null) return 1
    if (bv == null) return -1
    const cmp =
      field === 'createdAt'
        ? new Date(av).getTime() - new Date(bv).getTime()
        : String(av).localeCompare(String(bv), undefined, { sensitivity: 'base' })
    return desc ? -cmp : cmp
  })

  const start = (page - 1) * limit
  return { rows: out.slice(start, start + limit), total: out.length }
}

/** Gmail connections visible on a user record, tolerating `select: false` fields. */
function gmailSummary(user) {
  // S-4: `linkedGmailAccounts` is `select: false` on the schema and never
  // reaches the client (it holds OAuth refresh tokens). The server now sends
  // `connectedAccountCount` and the address list without the credentials, so
  // the count no longer under-reports a Head with several linked mailboxes.
  const serverAddresses = Array.isArray(user?.connectedAccountEmails)
    ? user.connectedAccountEmails.filter(Boolean)
    : null
  const legacyLinked = Array.isArray(user?.linkedGmailAccounts)
    ? user.linkedGmailAccounts.map((a) => a?.gmailEmail).filter(Boolean)
    : []
  const addresses =
    serverAddresses ??
    Array.from(new Set([user?.gmailEmail, ...legacyLinked].filter(Boolean)))
  const rawCount = Number(user?.connectedAccountCount)
  const rawLimit = Number(user?.maxConnectedAccounts)
  return {
    addresses,
    count: Number.isFinite(rawCount) ? rawCount : addresses.length,
    limit: Number.isFinite(rawLimit) ? rawLimit : 5,
    allowed: Array.isArray(user?.allowedGmailAccounts) ? user.allowedGmailAccounts : [],
  }
}

/** Mirrors createUserSchema / updateUserSchema so the user sees errors inline. */
function validateUserForm(values, { requirePassword }) {
  const errors = {}

  const name = (values.name || '').trim()
  if (!name) errors.name = 'Name is required.'
  else if (name.length > 120) errors.name = 'Name is too long (120 characters maximum).'

  const email = (values.email || '').trim()
  if (!email) errors.email = 'Email address is required.'
  else if (!EMAIL_RE.test(email)) errors.email = 'Enter a valid email address.'
  else if (email.length > 254) errors.email = 'Email address is too long (254 characters maximum).'

  if (requirePassword) {
    const password = values.password || ''
    if (!password) errors.password = 'Password is required.'
    else if (!isLongEnough(password))
      errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
    else if (password.length > 128) errors.password = 'Password is too long (128 characters maximum).'
  }

  const allowedRoles = requirePassword ? CREATABLE_ROLES : EDITABLE_ROLES
  if (!allowedRoles.includes(values.role)) errors.role = 'Select a role.'

  if (!requirePassword && !STATUSES.includes(values.status)) {
    errors.status = 'Select an account status.'
  }

  return errors
}

/** Mirrors the maxConnectedAccounts / allowedGmailAccounts rules on the server. */
function validatePermissionsForm({ maxConnectedAccounts, allowedGmailAccounts }) {
  const errors = {}
  const raw = String(maxConnectedAccounts ?? '').trim()
  const n = Number(raw)

  if (raw === '') errors.maxConnectedAccounts = 'Enter a connection limit.'
  else if (!Number.isInteger(n)) errors.maxConnectedAccounts = 'Enter a whole number.'
  else if (n < 0) errors.maxConnectedAccounts = 'The limit cannot be negative.'
  else if (n > MAX_ACCOUNTS_CEILING) {
    errors.maxConnectedAccounts = `The limit cannot exceed ${MAX_ACCOUNTS_CEILING}.`
  }

  if (allowedGmailAccounts.length > MAX_ALLOWED_ADDRESSES) {
    errors.allowedGmailAccounts = `No more than ${MAX_ALLOWED_ADDRESSES} addresses can be allow-listed.`
  } else if (allowedGmailAccounts.some((a) => !EMAIL_RE.test(a))) {
    errors.allowedGmailAccounts = 'Every allow-listed entry must be a valid email address.'
  }

  return errors
}

const EMPTY_CREATE = { name: '', email: '', password: '', role: 'Employee' }

/* ---------------------------------------------------------------------------
 * Page
 * ------------------------------------------------------------------------ */

export default function ManageUsers() {
  const { user: currentUser } = useAuth()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()

  /* --- URL-owned view state ------------------------------------------- */
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const limitParam = Number(searchParams.get('limit')) || DEFAULT_LIMIT
  const limit = PAGE_SIZES.includes(limitParam) ? limitParam : DEFAULT_LIMIT
  const sortParam = searchParams.get('sort') || DEFAULT_SORT
  const sortField = sortParam.startsWith('-') ? sortParam.slice(1) : sortParam
  const sort = SORT_FIELDS.includes(sortField) ? sortParam : DEFAULT_SORT
  const qParam = searchParams.get('q') || ''
  const roleParam = EDITABLE_ROLES.includes(searchParams.get('role')) ? searchParams.get('role') : ''
  const statusParam = STATUSES.includes(searchParams.get('status')) ? searchParams.get('status') : ''
  const hasFilters = Boolean(qParam || roleParam || statusParam)

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

  const reviewPending = useCallback(
    () => setParams({ status: 'Pending', page: 1 }),
    [setParams]
  )

  useRegisterCommands(
    [
      {
        id: 'users-review-pending',
        label: 'Review pending registrations',
        group: 'Users',
        icon: <UserCheck className="h-4 w-4" />,
        keywords: ['approve', 'awaiting', 'signup'],
        onSelect: reviewPending,
      },
    ],
    [reviewPending]
  )

  /* --- Data ------------------------------------------------------------ */
  const [reloadToken, setReloadToken] = useState(0)
  const [pendingToken, setPendingToken] = useState(0)
  const [debouncedQ, setDebouncedQ] = useState(qParam)
  const [result, setResult] = useState({ key: null, rows: [], total: 0, error: null })
  const [pendingCount, setPendingCount] = useState(null)
  const [rowSelection, setRowSelection] = useState({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(qParam), 300)
    return () => clearTimeout(timer)
  }, [qParam])

  const query = useMemo(
    () => ({ page, limit, sort, q: debouncedQ, role: roleParam, status: statusParam }),
    [page, limit, sort, debouncedQ, roleParam, statusParam]
  )
  const queryKey = useMemo(() => `${reloadToken}:${JSON.stringify(query)}`, [reloadToken, query])

  useEffect(() => {
    const controller = new AbortController()
    const params = { page: query.page, limit: query.limit, sort: query.sort }
    if (query.q) params.q = query.q
    if (query.role) params.role = query.role
    if (query.status) params.status = query.status

    api
      .get('/users', { params, signal: controller.signal })
      .then((res) => {
        const { rows, pagination } = readList(res.data)
        if (pagination) {
          setResult({
            key: queryKey,
            rows,
            total: Number(pagination.total) || rows.length,
            error: null,
          })
        } else {
          // Legacy un-paginated response: page and filter locally so the screen
          // stays correct until the server migration lands.
          const view = applyLocalView(rows, query)
          setResult({ key: queryKey, rows: view.rows, total: view.total, error: null })
        }
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setResult({
          key: queryKey,
          rows: [],
          total: 0,
          error: getErrorMessage(err, 'Could not load users.'),
        })
      })

    return () => controller.abort()
  }, [query, queryKey])

  // Pending registrations are the gate on access now that registration issues no
  // token, so the count is fetched independently of the current filter.
  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/users', { params: { page: 1, limit: 1, status: 'Pending' }, signal: controller.signal })
      .then((res) => {
        const { rows, pagination } = readList(res.data)
        setPendingCount(
          pagination
            ? Number(pagination.total) || 0
            : rows.filter((u) => (u.status || 'Approved') === 'Pending').length
        )
      })
      .catch((err) => {
        // Unknown, not zero — the banner simply stays hidden.
        if (!isCanceled(err)) setPendingCount(null)
      })
    return () => controller.abort()
  }, [reloadToken, pendingToken])

  const loading = result.key !== queryKey
  const rows = result.rows
  const total = result.total
  const error = result.error

  const reload = useCallback(() => setReloadToken((n) => n + 1), [])

  /**
   * S-5: `PUT /api/users/:id` returns the full updated document (including
   * `maxConnectedAccounts` and `allowedGmailAccounts`, the two fields the Gmail
   * permission form edits), so a saved row is patched in place. The page used to
   * re-GET the entire list after every save purely to see what it had written.
   */
  const applyUser = useCallback((updated) => {
    if (!updated?._id) return
    setResult((prev) => ({
      ...prev,
      rows: prev.rows.map((u) => (u._id === updated._id ? { ...u, ...updated } : u)),
    }))
  }, [])

  /**
   * A row patched in place is enough for a detail edit, but a role or status
   * change can move the row out of an active filter and always changes the
   * pending-registration count — so those two consequences are refreshed
   * explicitly rather than by reloading the page's data wholesale.
   */
  const afterSave = useCallback(
    (previous, updated) => {
      if (!updated?._id) {
        // Older server build: partial response, nothing safe to patch from.
        reload()
        return
      }
      applyUser(updated)

      const roleChanged = Boolean(previous) && updated.role !== previous.role
      const statusChanged =
        Boolean(previous) &&
        (updated.status || 'Approved') !== (previous.status || 'Approved')

      if (roleChanged || statusChanged) {
        setPendingToken((n) => n + 1)
        if (roleParam || statusParam) reload()
      }
    },
    [applyUser, reload, roleParam, statusParam]
  )

  const selectedUsers = useMemo(
    () => rows.filter((u) => rowSelection[u._id]),
    [rows, rowSelection]
  )

  /** Gmail addresses already known to the system, for the allow-list picker. */
  const knownGmailAddresses = useMemo(() => {
    const set = new Set()
    rows.forEach((u) => gmailSummary(u).addresses.forEach((a) => set.add(a)))
    return Array.from(set).sort()
  }, [rows])

  /* --- Dialog state ---------------------------------------------------- */
  const [createOpen, setCreateOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [permissionsTarget, setPermissionsTarget] = useState(null)

  /* --- Mutations ------------------------------------------------------- */

  const patchUser = useCallback(
    async (target, body, successMessage) => {
      setBusy(true)
      try {
        const res = await api.put(`/users/${target._id}`, body)
        toast.success(successMessage)
        afterSave(target, res.data)
        return true
      } catch (err) {
        toast.error('Could not update user', { description: getErrorMessage(err) })
        return false
      } finally {
        setBusy(false)
      }
    },
    [afterSave]
  )

  const changeStatus = useCallback(
    async (target, status) => {
      const label = status === 'Approved' ? 'approve' : status === 'Rejected' ? 'reject' : 'suspend'
      const ok = await confirm({
        title: `${label[0].toUpperCase()}${label.slice(1)} ${target.name}?`,
        description:
          status === 'Approved'
            ? `${target.email} will be able to sign in immediately.`
            : `${target.email} loses access immediately and every active session is signed out.`,
        confirmLabel: `${label[0].toUpperCase()}${label.slice(1)} account`,
        tone: status === 'Approved' ? 'info' : 'warning',
      })
      if (!ok) return
      await patchUser(target, { status }, `${target.name} — status set to ${status}.`)
    },
    [confirm, patchUser]
  )

  const changeRole = useCallback(
    async (target, role) => {
      if (role === target.role) return
      const ok = await confirm({
        title: `Change ${target.name} to ${role}?`,
        description: `${target.email} moves from ${target.role} to ${role}. Their current sessions are signed out so the new permissions take effect immediately.`,
        confirmLabel: `Set role to ${role}`,
        tone: 'warning',
      })
      if (!ok) return
      await patchUser(target, { role }, `${target.name} is now ${role}.`)
    },
    [confirm, patchUser]
  )

  /* Typed confirmation comes from the shared dialog (`requireTyped`); the
   * consequence summary below is the only part that was ever page-specific. */
  const deleteUser = useCallback(
    async (target) => {
      const email = target.email || ''
      const ok = await confirm({
        title: `Delete ${target.name || email}?`,
        description: (
          <div className="flex flex-col gap-3">
            <p>
              This removes their access immediately. Sessions are revoked, Gmail credentials are
              deleted, and their tasks and emails are unassigned. Activity log entries and task
              comments are retained for the audit trail.
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-fg-3">Role</dt>
              <dd>{target.role || 'Unknown'}</dd>
              <dt className="text-fg-3">Status</dt>
              <dd>{target.status || 'Approved'}</dd>
              <dt className="text-fg-3">Created</dt>
              <dd className="tabular">{formatDateTime(target.createdAt)}</dd>
            </dl>
          </div>
        ),
        confirmLabel: 'Delete user',
        cancelLabel: 'Keep account',
        tone: 'danger',
        requireTyped: {
          value: email,
          hint: 'Deletion is confirmed by typing the exact email address on the account.',
        },
      })
      if (!ok) return

      try {
        await api.delete(`/users/${target._id}`)
        toast.success(`${target.name || email} deleted.`)
        setRowSelection({})
        reload()
      } catch (err) {
        toast.error('Could not delete user', { description: getErrorMessage(err) })
      }
    },
    [confirm, reload]
  )

  const runBulkStatus = useCallback(
    async (status) => {
      const targets = selectedUsers.filter(
        (u) => (u.status || 'Approved') !== status && u._id !== currentUser?._id
      )
      if (targets.length === 0) {
        toast.warning(`Nothing to ${status === 'Approved' ? 'approve' : 'reject'} in the selection.`)
        return
      }
      const ok = await confirm({
        title: `${status === 'Approved' ? 'Approve' : 'Reject'} ${formatNumber(targets.length)} ${
          targets.length === 1 ? 'account' : 'accounts'
        }?`,
        description:
          status === 'Approved'
            ? 'Each account will be able to sign in immediately and will receive an approval email.'
            : 'Each account loses access immediately and every active session is signed out.',
        confirmLabel: status === 'Approved' ? 'Approve accounts' : 'Reject accounts',
        tone: status === 'Approved' ? 'info' : 'warning',
      })
      if (!ok) return

      setBusy(true)
      try {
        const outcomes = await Promise.allSettled(
          targets.map((u) => api.put(`/users/${u._id}`, { status }))
        )
        const failed = outcomes.filter((o) => o.status === 'rejected')
        const succeeded = outcomes.length - failed.length
        if (succeeded > 0) {
          toast.success(
            `${formatNumber(succeeded)} ${succeeded === 1 ? 'account' : 'accounts'} ${
              status === 'Approved' ? 'approved' : 'rejected'
            }.`
          )
        }
        if (failed.length > 0) {
          toast.error(
            `${formatNumber(failed.length)} ${failed.length === 1 ? 'account' : 'accounts'} failed.`,
            { description: getErrorMessage(failed[0].reason) }
          )
        }
        setRowSelection({})
        reload()
      } finally {
        setBusy(false)
      }
    },
    [confirm, currentUser, reload, selectedUsers]
  )

  /* --- Columns --------------------------------------------------------- */

  const columns = useMemo(
    () => [
      {
        /* accessorKey, not id: TanStack's getCanSort() requires an accessor,
         * so an id-only column renders no sort button at all. The key is also
         * the server's sort field name. */
        accessorKey: 'name',
        header: 'User',
        meta: { primary: true, width: '220px' },
        cell: ({ row }) => {
          const u = row.original
          const isSelf = u._id === currentUser?._id
          return (
            <div className="flex items-center gap-2.5">
              <Avatar size="sm" name={u.name} id={u._id} />
              <span className="min-w-0 truncate">
                {u.name || 'Unnamed user'}
                {isSelf ? <span className="ml-1.5 text-xs text-fg-3">(you)</span> : null}
              </span>
            </div>
          )
        },
      },
      {
        accessorKey: 'email',
        header: 'Email',
        meta: { width: '230px' },
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-2">{row.original.email || '—'}</span>
        ),
      },
      {
        accessorKey: 'role',
        header: 'Role',
        meta: { width: '110px', truncate: false },
        cell: ({ row }) => (
          <Badge size="sm" variant={ROLE_BADGE[row.original.role] || 'neutral'}>
            {row.original.role || 'Unknown'}
          </Badge>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        meta: { width: '110px', truncate: false },
        cell: ({ row }) => {
          const status = row.original.status || 'Approved'
          return (
            <Badge size="sm" variant={STATUS_BADGE[status] || 'neutral'}>
              {status}
            </Badge>
          )
        },
      },
      {
        id: 'gmail',
        header: 'Gmail',
        enableSorting: false,
        meta: { width: '120px', truncate: false, numeric: true },
        cell: ({ row }) => {
          const { addresses, count, limit: cap, allowed } = gmailSummary(row.original)
          const detail =
            addresses.length > 0
              ? addresses.join(', ')
              : 'No Gmail account connected on this record.'
          return (
            <Tooltip
              content={
                allowed.length > 0
                  ? `${detail} — restricted to ${allowed.length} allow-listed ${
                      allowed.length === 1 ? 'address' : 'addresses'
                    }.`
                  : detail
              }
            >
              <span className="inline-flex items-center gap-1.5 tabular">
                <span className={count > 0 ? 'text-fg' : 'text-fg-3'}>
                  {count} / {cap}
                </span>
                {allowed.length > 0 ? (
                  <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 text-fg-3" />
                ) : null}
              </span>
            </Tooltip>
          )
        },
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        meta: { width: '120px' },
        cell: ({ row }) => (
          <span className="tabular text-fg-3">{formatDate(row.original.createdAt)}</span>
        ),
      },
      {
        // S-4: `lastLoginAt` is a real, indexed, sortable field now.
        accessorKey: 'lastLoginAt',
        header: 'Last sign-in',
        meta: { width: '130px' },
        cell: ({ row }) => {
          const value = row.original.lastLoginAt
          return value ? (
            <Tooltip content={formatDateTime(value)}>
              <span className="text-fg-3">{timeAgo(value)}</span>
            </Tooltip>
          ) : (
            <span className="text-fg-3">Never signed in</span>
          )
        },
      },
      {
        id: 'actions',
        // A blank <th> is an axe `empty-table-header` violation — the actions
        // cells would be announced with no column name.
        header: () => <span className="sr-only">Actions</span>,
        enableSorting: false,
        meta: { width: '56px', truncate: false },
        cell: ({ row }) => {
          const u = row.original
          const isSelf = u._id === currentUser?._id
          const status = u.status || 'Approved'
          return (
            <div className="flex justify-end">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    iconOnly
                    aria-label={`Actions for ${u.name || u.email}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>{u.name || u.email}</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={() => setEditTarget(u)}>
                    <Pencil className="h-4 w-4" />
                    Edit details
                  </DropdownMenuItem>

                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <UserCog className="h-4 w-4" />
                      Change role
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuRadioGroup
                        value={u.role}
                        onValueChange={(role) => changeRole(u, role)}
                      >
                        {EDITABLE_ROLES.map((role) => (
                          <DropdownMenuRadioItem key={role} value={role} disabled={isSelf}>
                            {role}
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>

                  <DropdownMenuItem onSelect={() => setPermissionsTarget(u)}>
                    <Mail className="h-4 w-4" />
                    Gmail permissions
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  {status === 'Pending' ? (
                    <>
                      <DropdownMenuItem onSelect={() => changeStatus(u, 'Approved')}>
                        <UserCheck className="h-4 w-4" />
                        Approve registration
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => changeStatus(u, 'Rejected')}>
                        <UserX className="h-4 w-4" />
                        Reject registration
                      </DropdownMenuItem>
                    </>
                  ) : null}

                  {status === 'Approved' ? (
                    <DropdownMenuItem disabled={isSelf} onSelect={() => changeStatus(u, 'Rejected')}>
                      <Ban className="h-4 w-4" />
                      Deactivate access
                    </DropdownMenuItem>
                  ) : null}

                  {status === 'Rejected' ? (
                    <DropdownMenuItem onSelect={() => changeStatus(u, 'Approved')}>
                      <UserCheck className="h-4 w-4" />
                      Restore access
                    </DropdownMenuItem>
                  ) : null}

                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive disabled={isSelf} onSelect={() => deleteUser(u)}>
                    <Trash2 className="h-4 w-4" />
                    Delete user
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )
        },
      },
    ],
    [changeRole, changeStatus, deleteUser, currentUser]
  )

  /* --- Render ---------------------------------------------------------- */

  const selectionCount = selectedUsers.length
  const pendingInSelection = selectedUsers.filter(
    (u) => (u.status || 'Approved') === 'Pending'
  ).length

  const clearFilters = useCallback(() => {
    setParams({ q: null, role: null, status: null, page: 1 })
  }, [setParams])

  return (
    <>
      <PageHeader
        title="Users"
        description="Accounts, roles, approvals and Gmail permissions for the workspace."
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
              variant="primary"
              leftIcon={<Plus className="h-4 w-4" />}
              onClick={() => setCreateOpen(true)}
            >
              Add user
            </Button>
          </>
        }
      />

      <Toolbar
        left={
          <>
            <label htmlFor="filter-role" className="text-xs text-fg-3">
              Role
            </label>
            <Select
              id="filter-role"
              size="sm"
              className="w-[130px]"
              value={roleParam}
              onChange={(e) => setParams({ role: e.target.value, page: 1 })}
              options={ROLE_FILTER_OPTIONS}
            />
            <label htmlFor="filter-status" className="text-xs text-fg-3">
              Status
            </label>
            <Select
              id="filter-status"
              size="sm"
              className="w-[140px]"
              value={statusParam}
              onChange={(e) => setParams({ status: e.target.value, page: 1 })}
              options={STATUS_FILTER_OPTIONS}
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
            <label htmlFor="user-search" className="sr-only">
              Search users by name or email
            </label>
            <Input
              id="user-search"
              size="sm"
              type="search"
              className="w-[240px]"
              placeholder="Search name or email…"
              leadingIcon={<Search className="h-4 w-4" />}
              value={qParam}
              onChange={(e) => setParams({ q: e.target.value, page: 1 }, { replace: true })}
            />
          </>
        }
      />

      {selectionCount > 0 ? (
        <Toolbar
          className="bg-primary-subtle"
          left={
            <span className="text-sm text-fg-2">
              {formatNumber(selectionCount)} selected
              {pendingInSelection > 0
                ? ` · ${formatNumber(pendingInSelection)} awaiting approval`
                : ''}
            </span>
          }
          right={
            <>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<Check className="h-4 w-4" />}
                loading={busy}
                onClick={() => runBulkStatus('Approved')}
              >
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                leftIcon={<X className="h-4 w-4" />}
                loading={busy}
                onClick={() => runBulkStatus('Rejected')}
              >
                Reject
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRowSelection({})}>
                Clear selection
              </Button>
            </>
          }
        />
      ) : null}

      <PageBody fill>
        {pendingCount > 0 && statusParam !== 'Pending' ? (
          <Alert
            variant="warning"
            title={`${formatNumber(pendingCount)} ${
              pendingCount === 1 ? 'registration is' : 'registrations are'
            } awaiting approval`}
            className="mb-4"
            action={
              <Button size="sm" onClick={() => setParams({ status: 'Pending', page: 1 })}>
                Review pending
              </Button>
            }
          >
            Registration no longer signs anyone in. These people cannot access the workspace until
            an administrator approves them here.
          </Alert>
        ) : null}

        {error ? (
          <Alert
            variant="danger"
            title="Could not load users"
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
          fill
          ariaLabel="Users"
          data={rows}
          columns={columns}
          loading={loading}
          enableSelection
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          getRowId={(r) => r._id}
          density="default"
          sorting={sorting}
          onSortingChange={handleSortingChange}
          pagination={{
            page,
            pageSize: limit,
            total,
            onPageChange: (p) => setParams({ page: p }),
            onPageSizeChange: (size) => setParams({ limit: size, page: 1 }),
            itemLabel: 'users',
          }}
          emptyState={
            hasFilters
              ? {
                  icon: Search,
                  title: 'No users match these filters',
                  description: 'Try a different role, status or search term.',
                  secondaryAction: { label: 'Clear filters', onClick: clearFilters },
                }
              : {
                  icon: Users,
                  title: 'No users yet',
                  description: 'Add the first Head or Employee account to get started.',
                  action: { label: 'Add user', onClick: () => setCreateOpen(true) },
                }
          }
        />
      </PageBody>

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false)
          reload()
        }}
      />

      {/* Mounted per target so form state is seeded from props on mount — no
          state-syncing effect, and no stale values when a second row is opened. */}
      {editTarget ? (
        <EditUserDialog
          key={editTarget._id}
          target={editTarget}
          isSelf={editTarget._id === currentUser?._id}
          onClose={() => setEditTarget(null)}
          onSaved={(updated) => {
            const previous = editTarget
            setEditTarget(null)
            afterSave(previous, updated)
          }}
        />
      ) : null}

      {permissionsTarget ? (
        <GmailPermissionsDialog
          key={permissionsTarget._id}
          target={permissionsTarget}
          knownAddresses={knownGmailAddresses}
          onClose={() => setPermissionsTarget(null)}
          onSaved={(updated) => {
            const previous = permissionsTarget
            setPermissionsTarget(null)
            afterSave(previous, updated)
          }}
        />
      ) : null}
    </>
  )
}

/* ---------------------------------------------------------------------------
 * Create
 * ------------------------------------------------------------------------ */

function CreateUserDialog({ open, onOpenChange, onCreated }) {
  const [values, setValues] = useState(EMPTY_CREATE)
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const handleOpenChange = (next) => {
    if (!next) {
      setValues(EMPTY_CREATE)
      setErrors({})
    }
    onOpenChange(next)
  }

  const submit = async (e) => {
    e.preventDefault()
    const found = validateUserForm(values, { requirePassword: true })
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSaving(true)
    try {
      await api.post('/users', {
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
        role: values.role,
      })
      toast.success(`${values.name.trim()} created.`)
      setValues(EMPTY_CREATE)
      setErrors({})
      onCreated()
    } catch (err) {
      toast.error('Could not create user', { description: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        size="md"
        title="Add user"
        description="Creates an approved Head or Employee account. Administrators cannot be created here."
        dismissable={!saving}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={submit}>
              Create user
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <FormField label="Full name" required error={errors.name}>
            {(field) => (
              <Input
                {...field}
                value={values.name}
                autoComplete="off"
                maxLength={120}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              />
            )}
          </FormField>

          <FormField label="Email address" required error={errors.email}>
            {(field) => (
              <Input
                {...field}
                type="email"
                value={values.email}
                autoComplete="off"
                maxLength={254}
                onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
              />
            )}
          </FormField>

          <FormField
            label="Temporary password"
            required
            hint={`At least ${PASSWORD_MIN_LENGTH} characters. Ask the user to change it after their first sign-in.`}
            error={errors.password}
          >
            {(field) => (
              <Input
                {...field}
                type="password"
                value={values.password}
                autoComplete="new-password"
                maxLength={128}
                onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
              />
            )}
          </FormField>

          <FormField label="Role" required error={errors.role}>
            {(field) => (
              <Select
                {...field}
                value={values.role}
                onChange={(e) => setValues((v) => ({ ...v, role: e.target.value }))}
                options={CREATABLE_ROLES.map((r) => ({ value: r, label: r }))}
              />
            )}
          </FormField>

          {/* Enables Enter-to-submit without a second visible button. */}
          <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
            Create user
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------------------------------------------------------
 * Edit
 * ------------------------------------------------------------------------ */

function EditUserDialog({ target, isSelf, onClose, onSaved }) {
  const [values, setValues] = useState(() => ({
    name: target.name || '',
    email: target.email || '',
    role: target.role || 'Employee',
    status: target.status || 'Approved',
  }))
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    const found = validateUserForm(values, { requirePassword: false })
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSaving(true)
    try {
      const res = await api.put(`/users/${target._id}`, {
        name: values.name.trim(),
        email: values.email.trim(),
        role: values.role,
        status: values.status,
      })
      toast.success(`${values.name.trim()} updated.`)
      // S-5: hand the full updated document back so the list patches the row
      // instead of re-fetching the page.
      onSaved(res.data)
    } catch (err) {
      toast.error('Could not update user', { description: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const roleChanged = values.role !== target.role
  const statusChanged = values.status !== (target.status || 'Approved')

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="md"
        title={`Edit ${target.name || target.email}`}
        description="Changes to role or status sign the account out of every active session."
        dismissable={!saving}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={submit}>
              Save changes
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <FormField label="Full name" required error={errors.name}>
            {(field) => (
              <Input
                {...field}
                value={values.name}
                maxLength={120}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              />
            )}
          </FormField>

          <FormField label="Email address" required error={errors.email}>
            {(field) => (
              <Input
                {...field}
                type="email"
                value={values.email}
                maxLength={254}
                onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))}
              />
            )}
          </FormField>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField
              label="Role"
              required
              error={errors.role}
              hint={isSelf ? 'You cannot change your own role.' : undefined}
            >
              {(field) => (
                <Select
                  {...field}
                  disabled={isSelf}
                  value={values.role}
                  onChange={(e) => setValues((v) => ({ ...v, role: e.target.value }))}
                  options={EDITABLE_ROLES.map((r) => ({ value: r, label: r }))}
                />
              )}
            </FormField>

            <FormField
              label="Account status"
              required
              error={errors.status}
              hint={isSelf ? 'You cannot change your own status.' : undefined}
            >
              {(field) => (
                <Select
                  {...field}
                  disabled={isSelf}
                  value={values.status}
                  onChange={(e) => setValues((v) => ({ ...v, status: e.target.value }))}
                  options={STATUSES.map((s) => ({ value: s, label: s }))}
                />
              )}
            </FormField>
          </div>

          {roleChanged || statusChanged ? (
            <Alert variant="warning" title="This will sign the account out">
              {roleChanged ? `Role ${target.role} → ${values.role}. ` : ''}
              {statusChanged ? `Status ${target.status || 'Approved'} → ${values.status}. ` : ''}
              Every active session and socket connection for {target.email} is revoked on save.
            </Alert>
          ) : null}

          <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
            Save changes
          </button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------------------------------------------------------
 * Gmail permissions
 * ------------------------------------------------------------------------ */

function GmailPermissionsDialog({ target, knownAddresses, onClose, onSaved }) {
  const summary = gmailSummary(target)
  const [maxAccounts, setMaxAccounts] = useState(() => String(summary.limit))
  const [allowed, setAllowed] = useState(() => summary.allowed)
  const [draft, setDraft] = useState('')
  const [errors, setErrors] = useState({})
  const [saving, setSaving] = useState(false)

  const pickable = Array.from(new Set([...knownAddresses, ...summary.addresses])).sort()
  const custom = allowed.filter((a) => !pickable.includes(a))

  const toggle = (address) => {
    setAllowed((list) =>
      list.includes(address) ? list.filter((a) => a !== address) : [...list, address]
    )
  }

  const addDraft = () => {
    const value = draft.trim().toLowerCase()
    if (!value) return
    if (!EMAIL_RE.test(value)) {
      setErrors((e) => ({ ...e, draft: 'Enter a valid email address.' }))
      return
    }
    if (allowed.includes(value)) {
      setErrors((e) => ({ ...e, draft: 'That address is already allow-listed.' }))
      return
    }
    setAllowed((list) => [...list, value])
    setDraft('')
    setErrors((e) => ({ ...e, draft: undefined }))
  }

  const submit = async (e) => {
    e.preventDefault()
    const found = validatePermissionsForm({
      maxConnectedAccounts: maxAccounts,
      allowedGmailAccounts: allowed,
    })
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSaving(true)
    try {
      const res = await api.put(`/users/${target._id}`, {
        maxConnectedAccounts: Number(maxAccounts),
        allowedGmailAccounts: allowed,
      })
      toast.success(`Gmail permissions saved for ${target.name || target.email}.`)
      // S-5: these are exactly the two fields the old response omitted.
      onSaved(res.data)
    } catch (err) {
      toast.error('Could not save Gmail permissions', { description: getErrorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        size="md"
        title={`Gmail permissions — ${target.name || target.email}`}
        description="Controls how many mailboxes this account may connect, and which addresses are permitted."
        dismissable={!saving}
        footer={
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={saving}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="primary" loading={saving} onClick={submit}>
              Save permissions
            </Button>
          </>
        }
      >
        <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
          <FormField
            label="Maximum connected accounts"
            required
            hint={`Between 0 and ${MAX_ACCOUNTS_CEILING}. Set 0 to block new connections entirely.`}
            error={errors.maxConnectedAccounts}
          >
            {(field) => (
              <Input
                {...field}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_ACCOUNTS_CEILING}
                step={1}
                className="w-[140px]"
                value={maxAccounts}
                onChange={(e) => setMaxAccounts(e.target.value)}
              />
            )}
          </FormField>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-fg-2">
              Allowed Gmail addresses
            </legend>
            <p className="text-xs text-fg-3">
              Leave the list empty to permit any address, up to the limit above. Adding entries
              restricts this account to exactly those addresses.
            </p>

            {pickable.length > 0 ? (
              <div className="flex max-h-40 flex-col gap-1.5 overflow-y-auto rounded-lg border border-line p-2">
                {pickable.map((address) => (
                  <Checkbox
                    key={address}
                    id={`allow-${target._id}-${address}`}
                    size="sm"
                    label={address}
                    checked={allowed.includes(address)}
                    onCheckedChange={() => toggle(address)}
                  />
                ))}
              </div>
            ) : (
              <p className="rounded-lg border border-line bg-subtle px-3 py-2 text-xs text-fg-3">
                No Gmail addresses are known to the system yet. Add one below.
              </p>
            )}

            {custom.length > 0 ? (
              <ul className="flex flex-wrap gap-1.5">
                {custom.map((address) => (
                  <li key={address}>
                    <Badge size="md" variant="outline">
                      <span className="font-mono text-xs">{address}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${address} from the allow list`}
                        className="ml-1 rounded-sm text-fg-3 hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
                        onClick={() => toggle(address)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}

            <FormField label="Add another address" error={errors.draft || errors.allowedGmailAccounts}>
              {(field) => (
                <div className="flex gap-2">
                  <Input
                    {...field}
                    type="email"
                    placeholder="name@example.com"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addDraft()
                      }
                    }}
                  />
                  <Button variant="secondary" onClick={addDraft} disabled={!draft.trim()}>
                    Add
                  </Button>
                </div>
              )}
            </FormField>

            <p className="text-xs text-fg-3 tabular">
              {allowed.length === 0
                ? 'Any address permitted'
                : `${formatNumber(allowed.length)} of ${MAX_ALLOWED_ADDRESSES} allow-listed`}
            </p>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  )
}
