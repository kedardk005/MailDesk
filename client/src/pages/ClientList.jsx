import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Building2, Pencil, Plus, Search, Tags, Trash2, Upload, X } from 'lucide-react'

import api, { getErrorMessage, isCanceled } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import { useRegisterCommands } from '../components/CommandRegistry'
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogClose,
  DialogContent,
  Drawer,
  DrawerContent,
  FormField,
  Input,
  PageBody,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  toast,
  useConfirm,
} from '../components/ui'
import { ImportClientsDialog } from '../components/ImportClientsDialog'
import { ClientStatusCodesDialog } from '../components/ClientStatusCodesDialog'
import { formatNumber } from '../lib/utils'
import { useCachedQuery } from '../lib/useCachedQuery'

const PAGE_SIZES = [25, 50, 100]
const DEFAULT_LIMIT = 25

/** Mirrors `CLIENT_SORT_FIELDS` in `server/utils/clientService.js`. A field the
 *  server cannot sort on must not get a header that silently does nothing. */
const SORT_FIELDS = ['name', 'createdAt', 'status', 'contactPerson']
const DEFAULT_SORT = '-createdAt'

const STATUS_OPTIONS = [
  { value: 'All', label: 'All statuses' },
  { value: 'Active', label: 'Active' },
  { value: 'Inactive', label: 'Inactive' },
]

const EMPTY_FORM = {
  name: '',
  code: '',
  address: '',
  contactPerson: '',
  email: '',
  phone: '',
  notes: '',
  status: 'Active',
}

/** A client row can carry a null/blank name; `name.slice()` used to white-screen the page. */
function clientName(client) {
  const value = typeof client?.name === 'string' ? client.name.trim() : ''
  return value || 'Unnamed client'
}

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function isEmailish(value) {
  return /^\S+@\S+\.\S+$/.test(String(value || '').trim())
}

function sortValue(client, key) {
  if (key === 'name') return clientName(client)
  if (key === 'status') return client?.status || 'Active'
  return String(client?.[key] ?? '')
}

/** Local ordering used only while the server still answers in legacy mode. */
function compareClients(sort) {
  const desc = sort.startsWith('-')
  const key = desc ? sort.slice(1) : sort
  return (a, b) => {
    let result
    if (key === 'createdAt') {
      result = new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime()
    } else {
      result = sortValue(a, key).localeCompare(sortValue(b, key), undefined, {
        sensitivity: 'base',
      })
    }
    return desc ? -result : result
  }
}

function matchesQuery(client, needle) {
  const haystack = [
    clientName(client),
    client?.email,
    client?.contactPerson,
    client?.phone,
    ...(Array.isArray(client?.associatedEmails) ? client.associatedEmails : []),
  ]
  return haystack.filter(Boolean).some((value) => String(value).toLowerCase().includes(needle))
}

/** Read-only detail row used by the drawer. */
function DetailRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="min-w-0 text-sm text-fg">{children}</dd>
    </div>
  )
}

/**
 * Client directory.
 *
 * Uses `/api/clients` (the `{ success, data }` surface shared by Admin and
 * Head) rather than the divergent `/api/tasks/clients` Admin-only bare array.
 * It sends the pagination contract (`page`, `limit`, `sort`, `q`) and reads
 * `pagination` from the response; while the server still answers in legacy
 * mode — a capped array with no `pagination` block — the same filtering,
 * sorting and paging is applied locally so the controls never lie about what
 * is on screen.
 */
export default function ClientList() {
  const { isAdmin, isHead } = useAuth()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()

  const canEdit = isAdmin || isHead
  const [importOpen, setImportOpen] = useState(false)
  const [codesOpen, setCodesOpen] = useState(false)
  const canDelete = isAdmin

  /* -- URL state --------------------------------------------------------- */
  const page = Math.max(1, Number(searchParams.get('page')) || 1)
  const limitParam = Number(searchParams.get('limit'))
  const limit = PAGE_SIZES.includes(limitParam) ? limitParam : DEFAULT_LIMIT
  const q = searchParams.get('q') || ''
  const sortParam = searchParams.get('sort') || DEFAULT_SORT
  const sortField = sortParam.startsWith('-') ? sortParam.slice(1) : sortParam
  const sort = SORT_FIELDS.includes(sortField) ? sortParam : DEFAULT_SORT
  const statusParam = searchParams.get('status') || 'All'
  const status = STATUS_OPTIONS.some((o) => o.value === statusParam) ? statusParam : 'All'

  const updateParams = useCallback(
    (patch) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === '' || value === undefined) next.delete(key)
            else next.set(key, String(value))
          }
          if (!('page' in patch)) next.delete('page')
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  /* Sort headers are driven straight off `?sort=`, so the view stays
   * bookmarkable and the server remains the thing that actually orders rows. */
  const sorting = useMemo(
    () => [{ id: sort.startsWith('-') ? sort.slice(1) : sort, desc: sort.startsWith('-') }],
    [sort]
  )

  const handleSortingChange = useCallback(
    (next) => {
      const [s] = next
      updateParams({ sort: s ? `${s.desc ? '-' : ''}${s.id}` : null })
    },
    [updateParams]
  )

  /* -- data ----------------------------------------------------------------
   * Served from the shared query cache: coming back to /clients with the same
   * filters inside the TTL costs no request. A client write (or a socket event
   * implying one) drops the entry, so the directory is never stale on purpose.
   * -------------------------------------------------------------------- */
  const listParams = useMemo(
    () => ({
      page,
      limit,
      sort,
      q: q || undefined,
      status: status === 'All' ? undefined : status,
    }),
    [page, limit, sort, q, status]
  )

  const {
    data: payload,
    error,
    loading,
    refetch: reload,
  } = useCachedQuery('/clients', listParams, {
    failureMessage: 'Could not load the client directory.',
  })

  const raw = useMemo(() => {
    if (Array.isArray(payload)) return payload
    return Array.isArray(payload?.data) ? payload.data : []
  }, [payload])
  const meta = payload?.pagination || null

  /* `GET /api/clients` now reports the residual alongside the page: the tasks
   * and email that belong to no client on file. Without it the Total tasks and
   * Emails columns sum to less than the workspace holds — 353 of 427 tasks and
   * 1,185 of 1,397 emails — and nothing on screen says where the rest went. */
  const unattributed = payload?.unattributed || null

  const serverPaged = Boolean(meta)

  const { rows, total } = useMemo(() => {
    if (serverPaged) {
      return { rows: raw, total: Number(meta?.total) || raw.length }
    }
    const needle = q.trim().toLowerCase()
    let list = raw
    if (status !== 'All') list = list.filter((c) => (c?.status || 'Active') === status)
    if (needle) list = list.filter((c) => matchesQuery(c, needle))
    list = [...list].sort(compareClients(sort))
    const start = (page - 1) * limit
    return { rows: list.slice(start, start + limit), total: list.length }
  }, [serverPaged, meta, raw, q, status, sort, page, limit])

  /* -- search box (debounced into the URL) ------------------------------- */
  const [searchInput, setSearchInput] = useState(q)
  const [syncedQuery, setSyncedQuery] = useState(q)

  // Adjusting state during render is the documented way to follow a prop-like
  // value; an effect here would cause a second render pass on every keystroke.
  if (syncedQuery !== q) {
    setSyncedQuery(q)
    setSearchInput(q)
  }

  useEffect(() => {
    if (searchInput === q) return undefined
    const timer = setTimeout(() => updateParams({ q: searchInput.trim() || null }), 300)
    return () => clearTimeout(timer)
  }, [searchInput, q, updateParams])

  /* -- drawer ------------------------------------------------------------ */
  const [detail, setDetail] = useState(null)

  /* S-10: `GET /api/clients/:id/timeline` is real now — recent tasks and
   * emails for one client, role-scoped server-side. Fetched when the drawer
   * opens rather than with the list, because it is one request per client. */
  const [timelineToken, setTimelineToken] = useState(0)
  const [timelineResult, setTimelineResult] = useState({ key: null, entries: [], error: '' })
  const detailId = detail?._id
  const timelineKey = detailId ? `${detailId}|${timelineToken}` : null

  // Derived, not stored: the panel is "loading" whenever the client on screen
  // is not the client the last response was for. Same pattern as the list.
  const timelineLoading = Boolean(timelineKey) && timelineResult.key !== timelineKey
  const timelineSettled = timelineResult.key === timelineKey ? timelineResult : null

  useEffect(() => {
    if (!timelineKey) return undefined

    const controller = new AbortController()
    api
      .get(`/clients/${detailId}/timeline`, { signal: controller.signal })
      .then((res) => {
        const entries = res.data?.data?.timeline
        setTimelineResult({
          key: timelineKey,
          entries: Array.isArray(entries) ? entries : [],
          error: '',
        })
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setTimelineResult({
          key: timelineKey,
          entries: [],
          error: getErrorMessage(err, 'Could not load this client’s activity.'),
        })
      })

    return () => controller.abort()
  }, [detailId, timelineKey])

  /* -- create / edit dialog ---------------------------------------------- */
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [emails, setEmails] = useState([])
  const [emailDraft, setEmailDraft] = useState('')
  const [formErrors, setFormErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  /* Stable identity: it is a dependency of the command registration below, and
   * a new function every render would re-register on every render. */
  const openCreate = useCallback(() => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setEmails([])
    setEmailDraft('')
    setFormErrors({})
    setFormError('')
    setDialogOpen(true)
  }, [])

  useRegisterCommands(
    canEdit
      ? [
          {
            id: 'clients-new',
            label: 'New client',
            group: 'Clients',
            icon: <Plus className="h-4 w-4" />,
            keywords: ['add', 'create', 'customer'],
            onSelect: openCreate,
          },
        ]
      : [],
    [canEdit, openCreate]
  )

  const openEdit = (client) => {
    setEditing(client)
    setForm({
      name: typeof client?.name === 'string' ? client.name : '',
      code: client?.code || '',
      address: client?.address || '',
      contactPerson: client?.contactPerson || '',
      email: client?.email || '',
      phone: client?.phone || '',
      notes: client?.notes || '',
      status: client?.status || 'Active',
    })
    setEmails(Array.isArray(client?.associatedEmails) ? [...client.associatedEmails] : [])
    setEmailDraft('')
    setFormErrors({})
    setFormError('')
    setDialogOpen(true)
  }

  const addEmail = () => {
    const value = emailDraft.trim().toLowerCase()
    if (!value) return
    if (!isEmailish(value)) {
      setFormErrors((prev) => ({ ...prev, associatedEmails: 'Enter a valid email address.' }))
      return
    }
    if (emails.some((e) => e.toLowerCase() === value)) {
      setFormErrors((prev) => ({ ...prev, associatedEmails: 'That address is already listed.' }))
      return
    }
    setEmails((prev) => [...prev, value])
    setEmailDraft('')
    setFormErrors((prev) => ({ ...prev, associatedEmails: undefined }))
  }

  const removeEmail = (value) => {
    setEmails((prev) => prev.filter((e) => e !== value))
  }

  const submitClient = async (event) => {
    event.preventDefault()
    setFormError('')

    const found = {}
    if (!form.name.trim()) found.name = 'Enter the client name.'
    if (form.email.trim() && !isEmailish(form.email)) found.email = 'Enter a valid email address.'
    setFormErrors(found)
    if (Object.keys(found).length > 0) return

    const body = {
      name: form.name.trim(),
      code: form.code.trim(),
      address: form.address.trim(),
      contactPerson: form.contactPerson.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      notes: form.notes.trim(),
      status: form.status,
      associatedEmails: emails,
    }

    setSaving(true)
    try {
      if (editing) {
        await api.put(`/clients/${editing._id}`, body)
        toast.success('Client updated')
      } else {
        await api.post('/clients', body)
        toast.success('Client created')
      }
      setDialogOpen(false)
      setDetail(null)
      reload()
    } catch (err) {
      setFormError(getErrorMessage(err, 'Could not save the client.'))
    } finally {
      setSaving(false)
    }
  }

  const deleteClient = async (client) => {
    const ok = await confirm({
      title: `Delete “${clientName(client)}”?`,
      description:
        'The client record and its email-routing addresses are removed permanently. Tasks and emails already linked to this client keep their own records.',
      confirmLabel: 'Delete client',
      cancelLabel: 'Keep client',
      tone: 'danger',
    })
    if (!ok) return

    try {
      await api.delete(`/clients/${client._id}`)
      setDetail((current) => (current?._id === client._id ? null : current))
      toast.success('Client deleted')
      reload()
    } catch (err) {
      toast.error('Could not delete the client', { description: getErrorMessage(err) })
    }
  }

  /* -- columns ----------------------------------------------------------- */
  /* Deliberately not memoized: the action cells close over `openEdit` and
   * `deleteClient`, which are re-created every render, so a memo keyed on
   * anything less would hand the table stale callbacks. */
  const columns = (() => {
    const defs = [
      {
        accessorKey: 'name',
        header: 'Client',
        /* The identifying column MUST carry a width. Every body cell is
         * `max-w-0 truncate` (Table.jsx), so a column with no specified width
         * contributes nothing to the auto-layout preferred width and collapses
         * to its <th> label — 76px, seven characters, "Northl…". All the slack
         * went to the columns that did specify one, which is how the email
         * address ended up nearly three times wider than the client name. */
        meta: { primary: true, width: '320px' },
        cell: ({ row }) => {
          const client = row.original
          const contact = client?.contactPerson
          return (
            <div className="min-w-0">
              <span className="block truncate">{clientName(client)}</span>
              {contact ? (
                <span className="block truncate text-xs text-fg-3">{contact}</span>
              ) : null}
            </div>
          )
        },
      },
      {
        accessorKey: 'code',
        header: 'Code',
        /* The practice identifies clients by code, so it earns a column — and
         * it is what the importer matches on, which makes a wrong or missing
         * one worth being able to see. Narrow: codes are a few characters. */
        meta: { width: '96px' },
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-2">{row.original?.code || '—'}</span>
        ),
      },
      {
        accessorKey: 'email',
        header: 'Primary email',
        enableSorting: false,
        meta: { width: '200px' },
        cell: ({ row }) =>
          row.original?.email ? (
            <span className="font-mono text-xs">{row.original.email}</span>
          ) : (
            <span className="text-fg-3">—</span>
          ),
      },
      {
        id: 'associatedEmails',
        header: 'Addresses',
        enableSorting: false,
        meta: { numeric: true, width: '96px' },
        cell: ({ row }) =>
          formatNumber(
            Array.isArray(row.original?.associatedEmails) ? row.original.associatedEmails.length : 0
          ),
      },
      {
        // S-9: clients carry `openTaskCount` alongside `taskCount`, so the
        // column no longer has to hide behind the ambiguous label "Tasks".
        id: 'openTaskCount',
        header: 'Open tasks',
        enableSorting: false,
        meta: { numeric: true, width: '100px' },
        cell: ({ row }) => formatNumber(row.original?.openTaskCount ?? 0),
      },
      {
        id: 'taskCount',
        header: 'Total tasks',
        enableSorting: false,
        meta: { numeric: true, width: '100px' },
        cell: ({ row }) => formatNumber(row.original?.taskCount || 0),
      },
      {
        id: 'mailCount',
        header: 'Emails',
        enableSorting: false,
        meta: { numeric: true, width: '88px' },
        cell: ({ row }) => formatNumber(row.original?.mailCount || 0),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        meta: { width: '104px' },
        cell: ({ row }) => (
          <Badge variant={(row.original?.status || 'Active') === 'Active' ? 'success' : 'neutral'}>
            {row.original?.status || 'Active'}
          </Badge>
        ),
      },
      {
        accessorKey: 'createdAt',
        header: 'Created',
        meta: { width: '120px' },
        cell: ({ row }) => <span className="tabular">{formatDate(row.original?.createdAt)}</span>,
      },
    ]

    if (!canEdit) return defs

    defs.push({
      id: 'actions',
      // A visually empty <th> is an axe `empty-table-header` violation: a
      // screen reader announces the cells under it with no column name.
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      meta: { width: '88px', truncate: false },
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={`Edit ${clientName(row.original)}`}
            onClick={(event) => {
              event.stopPropagation()
              openEdit(row.original)
            }}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          {canDelete ? (
            <Button
              variant="danger-ghost"
              size="sm"
              iconOnly
              aria-label={`Delete ${clientName(row.original)}`}
              onClick={(event) => {
                event.stopPropagation()
                deleteClient(row.original)
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      ),
    })

    return defs
  })()

  const filtersActive = Boolean(q) || status !== 'All'

  return (
    <>
      <PageHeader
        title="Clients"
        description="Client records, their email routing addresses and the work booked against them."
        actions={
          canEdit ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                leftIcon={<Tags className="h-4 w-4" />}
                onClick={() => setCodesOpen(true)}
              >
                Status codes
              </Button>
              <Button
                variant="secondary"
                leftIcon={<Upload className="h-4 w-4" />}
                onClick={() => setImportOpen(true)}
              >
                Import
              </Button>
              <Button variant="primary" leftIcon={<Plus className="h-4 w-4" />} onClick={openCreate}>
                New client
              </Button>
            </div>
          ) : null
        }
      />

      <Toolbar
        left={
          <>
            <label className="sr-only" htmlFor="client-status">
              Filter by status
            </label>
            <div className="w-40">
              <Select
                id="client-status"
                size="sm"
                value={status}
                options={STATUS_OPTIONS}
                onChange={(e) =>
                  updateParams({ status: e.target.value === 'All' ? null : e.target.value })
                }
              />
            </div>
          </>
        }
        right={
          <div className="w-64">
            <label className="sr-only" htmlFor="client-search">
              Search clients
            </label>
            <Input
              id="client-search"
              size="sm"
              type="search"
              placeholder="Search name, contact or email"
              leadingIcon={<Search />}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
        }
      />

      <PageBody fill>
        {error ? (
          <Alert
            variant="danger"
            title="Could not load clients"
            className="mb-4"
            action={
              <Button size="sm" variant="secondary" onClick={reload}>
                Retry
              </Button>
            }
          >
            {error}
          </Alert>
        ) : null}

        <DataTable
          fill
          ariaLabel="Clients"
          data={rows}
          columns={columns}
          loading={loading}
          density="compact"
          getRowId={(row) => row._id}
          onRowClick={(row) => setDetail(row)}
          rowActivation="row"
          sorting={sorting}
          onSortingChange={handleSortingChange}
          pagination={{
            page,
            pageSize: limit,
            total,
            itemLabel: 'clients',
            pageSizeOptions: PAGE_SIZES,
            onPageChange: (next) => updateParams({ page: next }),
            onPageSizeChange: (size) => updateParams({ limit: size, page: 1 }),
          }}
          emptyState={
            filtersActive
              ? {
                  icon: Search,
                  title: 'No clients match these filters',
                  description: 'Try a different search term or clear the filters.',
                  secondaryAction: {
                    label: 'Clear filters',
                    onClick: () => updateParams({ q: null, status: null }),
                  },
                }
              : {
                  icon: Building2,
                  title: 'No clients yet',
                  description: canEdit
                    ? 'Add a client to route their email and track the work booked against them.'
                    : 'An administrator or head has not added any clients yet.',
                  action: canEdit ? { label: 'New client', onClick: openCreate } : undefined,
                }
          }
        />

        {unattributed && (unattributed.taskCount > 0 || unattributed.emailCount > 0) ? (
          <p className="mt-3 shrink-0 text-xs text-fg-3">
            {formatNumber(unattributed.taskCount)}{' '}
            {unattributed.taskCount === 1 ? 'task' : 'tasks'} and{' '}
            {formatNumber(unattributed.emailCount)}{' '}
            {unattributed.emailCount === 1 ? 'email' : 'emails'} are not attributed to any client
            on file, so they are in no row above. Reports → Clients lists them as
            “Unattributed”.
          </p>
        ) : null}
      </PageBody>

      {/* ------------------------------------------------------------------ */}
      {/* Detail drawer                                                      */}
      {/* ------------------------------------------------------------------ */}
      <Drawer open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(null)}>
        {detail ? (
          <DrawerContent
            size="md"
            title={clientName(detail)}
            description={detail.email || 'No primary email address'}
            headerActions={
              canEdit ? (
                <Button
                  size="sm"
                  variant="secondary"
                  leftIcon={<Pencil className="h-4 w-4" />}
                  onClick={() => {
                    // Never stack the edit dialog on top of the drawer.
                    openEdit(detail)
                    setDetail(null)
                  }}
                >
                  Edit
                </Button>
              ) : null
            }
          >
            <div className="flex flex-col gap-6">
              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">Overview</h3>
                <dl className="mt-2">
                  <DetailRow label="Status">
                    <Badge variant={(detail.status || 'Active') === 'Active' ? 'success' : 'neutral'}>
                      {detail.status || 'Active'}
                    </Badge>
                  </DetailRow>
                  <DetailRow label="Contact person">{detail.contactPerson || '—'}</DetailRow>
                  <DetailRow label="Primary email">
                    <span className="break-all font-mono">{detail.email || '—'}</span>
                  </DetailRow>
                  <DetailRow label="Phone">{detail.phone || '—'}</DetailRow>
                  <DetailRow label="Open tasks">
                    <span className="tabular">{formatNumber(detail.openTaskCount ?? 0)}</span>
                  </DetailRow>
                  <DetailRow label="Tasks booked (all time)">
                    <span className="tabular">{formatNumber(detail.taskCount || 0)}</span>
                  </DetailRow>
                  <DetailRow label="Emails matched">
                    <span className="tabular">{formatNumber(detail.mailCount || 0)}</span>
                  </DetailRow>
                </dl>
              </section>

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">
                  Email routing addresses
                </h3>
                {Array.isArray(detail.associatedEmails) && detail.associatedEmails.length > 0 ? (
                  <ul className="mt-2 flex flex-col gap-1.5">
                    {detail.associatedEmails.map((address) => (
                      <li
                        key={address}
                        className="break-all rounded border border-line bg-subtle px-2.5 py-1.5 font-mono text-xs text-fg-2"
                      >
                        {address}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-fg-3">
                    No addresses configured. Mail from this client will not be matched automatically.
                  </p>
                )}
              </section>

              {detail.notes ? (
                <section>
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">Notes</h3>
                  <p className="mt-2 whitespace-pre-wrap text-sm text-fg-2">{detail.notes}</p>
                </section>
              ) : null}

              <section>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-3">Timeline</h3>

                {timelineSettled?.error ? (
                  <Alert
                    variant="warning"
                    title="Activity unavailable"
                    className="mt-2"
                    action={
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setTimelineToken((n) => n + 1)}
                      >
                        Retry
                      </Button>
                    }
                  >
                    {timelineSettled.error}
                  </Alert>
                ) : null}

                <ol className="mt-2 flex flex-col gap-3 border-l border-line pl-4">
                  {(timelineSettled?.entries || []).map((entry) => (
                    <li key={`${entry.type}-${entry.id}`} className="relative">
                      <span
                        aria-hidden="true"
                        className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-line-strong"
                      />
                      <p className="text-sm text-fg">{entry.label}</p>
                      <p className="text-xs text-fg-3">
                        {formatDateTime(entry.at)}
                        {entry.status ? ` · ${entry.status}` : ''}
                      </p>
                    </li>
                  ))}
                  <li className="relative">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary-600"
                    />
                    <p className="text-sm text-fg">Client record created</p>
                    <p className="text-xs text-fg-3">{formatDateTime(detail.createdAt)}</p>
                  </li>
                </ol>

                {timelineLoading ? (
                  <p className="mt-3 text-xs text-fg-3">Loading recent tasks and emails…</p>
                ) : null}
                {timelineSettled && !timelineSettled.error && timelineSettled.entries.length === 0 ? (
                  <p className="mt-3 text-xs text-fg-3">
                    No tasks or emails recorded against this client yet.
                  </p>
                ) : null}
                {timelineSettled && timelineSettled.entries.length > 0 ? (
                  <p className="mt-3 text-xs text-fg-3">
                    The most recent activity you have access to. Employees see their own tasks and
                    mail; a head sees what they created.
                  </p>
                ) : null}
              </section>

              {canDelete ? (
                <section className="border-t border-line pt-4">
                  <Button
                    variant="danger-ghost"
                    leftIcon={<Trash2 className="h-4 w-4" />}
                    onClick={() => deleteClient(detail)}
                  >
                    Delete client
                  </Button>
                </section>
              ) : null}
            </div>
          </DrawerContent>
        ) : null}
      </Drawer>

      {/* ------------------------------------------------------------------ */}
      {/* Create / edit dialog                                               */}
      {/* ------------------------------------------------------------------ */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !saving && setDialogOpen(open)}>
        <DialogContent
          size="lg"
          title={editing ? `Edit ${clientName(editing)}` : 'New client'}
          description="Email received from any listed address is attributed to this client."
          dismissable={!saving}
          footer={
            <>
              <DialogClose asChild>
                <Button variant="secondary" disabled={saving}>
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" form="client-form" variant="primary" loading={saving}>
                {editing ? 'Save changes' : 'Create client'}
              </Button>
            </>
          }
        >
          <form id="client-form" onSubmit={submitClient} className="flex flex-col gap-4" noValidate>
            {formError ? (
              <Alert variant="danger" title="Could not save">
                {formError}
              </Alert>
            ) : null}

            <FormField label="Client name" required error={formErrors.name}>
              {(field) => (
                <Input
                  {...field}
                  placeholder="Reliance Industries"
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                />
              )}
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Contact person" optionalText="(optional)">
                {(field) => (
                  <Input
                    {...field}
                    value={form.contactPerson}
                    onChange={(e) => setForm((p) => ({ ...p, contactPerson: e.target.value }))}
                  />
                )}
              </FormField>

              <FormField label="Status">
                {(field) => (
                  <Select
                    {...field}
                    value={form.status}
                    options={[
                      { value: 'Active', label: 'Active' },
                      { value: 'Inactive', label: 'Inactive' },
                    ]}
                    onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Primary email" optionalText="(optional)" error={formErrors.email}>
                {(field) => (
                  <Input
                    {...field}
                    type="email"
                    placeholder="accounts@company.com"
                    value={form.email}
                    onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                  />
                )}
              </FormField>

              <FormField label="Phone" optionalText="(optional)">
                {(field) => (
                  <Input
                    {...field}
                    type="tel"
                    placeholder="+91 98765 43210"
                    value={form.phone}
                    onChange={(e) => setForm((p) => ({ ...p, phone: e.target.value }))}
                  />
                )}
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                label="Client code"
                optionalText="(optional)"
                error={formErrors.code}
                hint="Your own reference. Spreadsheet imports match on this."
              >
                {(field) => (
                  <Input
                    {...field}
                    placeholder="e.g. 138B"
                    value={form.code}
                    onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
                  />
                )}
              </FormField>

              <FormField label="Address" optionalText="(optional)" error={formErrors.address}>
                {(field) => (
                  <Input
                    {...field}
                    placeholder="Street, town, postcode"
                    value={form.address}
                    onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                  />
                )}
              </FormField>
            </div>

            <FormField
              label="Additional email addresses"
              error={formErrors.associatedEmails}
              hint="Mail from any of these addresses counts towards this client."
            >
              {(field) => (
                <div className="flex gap-2">
                  <Input
                    {...field}
                    type="email"
                    placeholder="billing@company.com"
                    value={emailDraft}
                    onChange={(e) => setEmailDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addEmail()
                      }
                    }}
                  />
                  <Button variant="secondary" onClick={addEmail} className="shrink-0">
                    Add
                  </Button>
                </div>
              )}
            </FormField>

            {emails.length > 0 ? (
              <ul className="-mt-2 flex flex-wrap gap-1.5">
                {emails.map((address) => (
                  <li
                    key={address}
                    className="flex items-center gap-1 rounded-sm border border-line bg-subtle py-1 pl-2 pr-1 font-mono text-xs text-fg-2"
                  >
                    <span className="break-all">{address}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${address}`}
                      onClick={() => removeEmail(address)}
                      className="flex h-4 w-4 items-center justify-center rounded-sm text-fg-3 hover:text-danger-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <FormField label="Notes" optionalText="(optional)">
              {(field) => (
                <Textarea
                  {...field}
                  rows={3}
                  value={form.notes}
                  onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))}
                />
              )}
            </FormField>
          </form>
        </DialogContent>
      </Dialog>

      <ImportClientsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={reload}
      />

      <ClientStatusCodesDialog
        open={codesOpen}
        onOpenChange={setCodesOpen}
        onChanged={reload}
      />
    </>
  )
}
