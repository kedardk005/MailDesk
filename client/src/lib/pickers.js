/**
 * Shared `loadOptions` sources for the Combobox pickers.
 *
 * Each returns `{ options, total }` under the list contract
 * (docs/audits/API-LIST-CONTRACT.md): the server filters on `?q=`, the
 * `limit` bounds what the picker renders, and `pagination.total` lets the
 * picker say "showing first N of M" instead of silently truncating.
 *
 * Module-level functions on purpose: their identity is stable, so a
 * component can pass them straight to <Combobox loadOptions={…}> without a
 * useCallback.
 */
import api from '../api/axios'
import { timeAgo } from './utils'

/** One page of a picker. Bounded rendering: the cap is announced, not hidden. */
export const PICKER_LIMIT = 20

/** Accepts both contract shapes plus the pre-migration bare array. */
function unwrap(payload) {
  if (Array.isArray(payload)) return { data: payload, pagination: null }
  if (payload && Array.isArray(payload.data)) {
    return { data: payload.data, pagination: payload.pagination || null }
  }
  return { data: [], pagination: null }
}

/** Clients by name/email/contact person. Any authenticated role. */
export async function searchClients({ q, signal }) {
  const res = await api.get('/clients', {
    params: { page: 1, limit: PICKER_LIMIT, sort: 'name', ...(q ? { q } : {}) },
    signal,
  })
  const { data, pagination } = unwrap(res.data)
  return {
    options: data.map((c) => ({
      // Tasks store the client NAME (Task.clientName), so the name is the value.
      value: c.name,
      label: c.name,
      description: c.email || c.contactPerson || undefined,
    })),
    total: pagination?.total ?? data.length,
  }
}

/** Approved users by name/email. `/users` is Admin/Head — matches every caller. */
export async function searchAssignees({ q, signal }) {
  const res = await api.get('/users', {
    params: { page: 1, limit: PICKER_LIMIT, sort: 'name', ...(q ? { q } : {}) },
    signal,
  })
  const { data, pagination } = unwrap(res.data)
  // Some legacy users predate the status field; treat "no status" as approved,
  // exactly as the old preloaded list did.
  const rows = data.filter((u) => !u.status || u.status === 'Approved')
  return {
    options: rows.map((u) => ({
      value: u._id,
      label: u.name || u.email || 'Unnamed user',
      description: [u.role, u.email].filter(Boolean).join(' · ') || undefined,
    })),
    total: pagination?.total ?? data.length,
  }
}

/** Unassigned, non-spam mail by subject/sender. Admin/Head. */
export async function searchLinkableEmails({ q, signal }) {
  const res = await api.get('/gmail/emails', {
    params: { page: 1, limit: PICKER_LIMIT, status: 'unassigned', ...(q ? { q } : {}) },
    signal,
  })
  const { data, pagination } = unwrap(res.data)
  const rows = data.filter((e) => e.status === 'unassigned' && !e.labelIds?.includes('SPAM'))
  return {
    options: rows.map((e) => ({
      value: e._id,
      label: e.subject || '(No subject)',
      description: [e.from, e.date ? timeAgo(e.date) : null].filter(Boolean).join(' · '),
      unread: e.isRead === false,
    })),
    total: pagination?.total ?? data.length,
  }
}
