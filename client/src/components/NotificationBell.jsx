import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck, RefreshCw } from 'lucide-react'
import api, { getErrorMessage } from '../api/axios'
import {
  countUnread,
  describeNotification,
  groupNotifications,
  mergeNotifications,
  notificationHref,
  visibleToRole,
} from '../lib/notifications'
import { affects, subscribe } from '../lib/queryCache'
import { useCachedQuery } from '../lib/useCachedQuery'
import { cn, timeAgo } from '../lib/utils'
import { useAuth } from './AuthProvider'
import { Button } from './ui/Button'
import { CountBadge } from './ui/Badge'
import { EmptyState } from './ui/EmptyState'
import { Popover, PopoverContent, PopoverTrigger } from './ui/Popover'
import { Skeleton } from './ui/Skeleton'

/**
 * Notification centre.
 *
 * Scoping is the SERVER's job and it already does it: `GET /api/notifications`
 * filters on `userId: req.user._id`, every emit is `io.to(<userId>)` and never
 * a broadcast, and the overdue cron sends supervisors one digest rather than
 * one row per task. Nothing here re-filters for ownership — there is no leak to
 * fix, and pretending otherwise would only add a second place to get it wrong.
 * What this component adds is presentation and reach:
 *
 *   - **grouped** Today / Yesterday / Earlier, not thirty undifferentiated rows;
 *   - **typed** — a distinct icon and semantic tone per `NOTIFICATION_EVENTS`
 *     member, plus a written type label so the icon is never the only cue
 *     (lib/notifications.js owns the table);
 *   - **role-aware** — a type an Employee could never act on is not shown to
 *     them, and a mail assignment deep-links an Employee to their task rather
 *     than to an inbox their role cannot open;
 *   - **deep links** to the task drawer / the assigned-mail filter / the
 *     approval queue, not a bare list;
 *   - real loading, empty, error-with-retry and load-more states.
 *
 * ### Freshness
 *
 * The list and the badge count are two cached queries (lib/queryCache.js).
 * `ProtectedLayout` turns every `newNotification` socket event into a cache
 * invalidation, which both queries observe — so a live arrival refreshes them
 * without this component owning a socket subscription (it used to own a second
 * one), and reopening the bell inside the TTL costs no request at all.
 *
 * ### Counting
 *
 * The badge reads `GET /notifications/unread-count` — one authoritative number
 * over a covered index — rather than counting the rows on screen, which would
 * under-report past the page size. Optimistic mark-read is a subtraction from
 * that single number, never a second accumulator, so it cannot double-count.
 */

const PAGE_SIZE = 30
const FIRST_PAGE = { page: 1, limit: PAGE_SIZE }
const NO_OVERRIDES = { ids: new Set(), all: false }

/** Both contract shapes plus the pre-migration bare array. */
function readRows(payload) {
  if (Array.isArray(payload)) return payload
  return Array.isArray(payload?.data) ? payload.data : []
}

export function NotificationBell() {
  const navigate = useNavigate()
  const { token, role } = useAuth()

  const [open, setOpen] = useState(false)
  /* Pages 2+ live here. Deliberately NOT cached: loading older rows is a rare,
   * explicit action, and caching an accumulated tail would mean reconciling it
   * against every page-1 invalidation. */
  const [extraRows, setExtraRows] = useState([])
  const [nextPage, setNextPage] = useState(2)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(null)

  const enabled = Boolean(token)

  const listQuery = useCachedQuery('/notifications', FIRST_PAGE, {
    enabled,
    failureMessage: 'Could not load notifications.',
  })
  const countQuery = useCachedQuery('/notifications/unread-count', null, { enabled })

  /* Optimistic read state, so a click does not wait for the round trip and the
   * refetch it triggers. Reset the moment real data arrives — otherwise
   * `all: true` would keep marking FUTURE arrivals as read. Adjusting state
   * during render is the documented way to follow a changing input. */
  const [overrides, setOverrides] = useState(NO_OVERRIDES)
  const [seenData, setSeenData] = useState(listQuery.data)
  if (seenData !== listQuery.data) {
    setSeenData(listQuery.data)
    setOverrides(NO_OVERRIDES)
  }

  /* An invalidation — a mark-read here, or a `newNotification` relayed by
   * ProtectedLayout — makes the accumulated tail meaningless, because page 2 of
   * the old ordering is not page 2 of the new one. Collapse back to page 1. */
  useEffect(() => {
    return subscribe((prefixes) => {
      if (!affects(prefixes, '/notifications')) return
      setExtraRows([])
      setNextPage(2)
      setMoreError(null)
    })
  }, [])

  const firstRows = useMemo(() => readRows(listQuery.data), [listQuery.data])
  const pagination = listQuery.data?.pagination ?? null

  /** Newest first, no duplicate `_id`, optimistic read state applied. */
  const rows = useMemo(() => {
    const merged = mergeNotifications(extraRows, firstRows)
    return merged.map((n) => (overrides.all || overrides.ids.has(n._id) ? { ...n, read: true } : n))
  }, [extraRows, firstRows, overrides])

  /* Role gate. An Employee never sees a type they cannot act on — see
   * NOTIFICATION_TYPES.roles. Untyped rows are always kept. */
  const visible = useMemo(() => rows.filter((n) => visibleToRole(n, role)), [rows, role])
  const groups = useMemo(() => groupNotifications(visible), [visible])

  /** The badge. One server number, adjusted by the optimistic overrides. */
  const serverUnread = Number(countQuery.data?.count)
  const unreadCount = useMemo(() => {
    if (overrides.all) return 0
    const base = Number.isFinite(serverUnread) ? serverUnread : countUnread(visible)
    return Math.max(0, base - overrides.ids.size)
  }, [serverUnread, overrides, visible])

  const loadedCount = rows.length
  const total = Number(pagination?.total)
  const hasMore = Number.isFinite(total) && loadedCount < total

  /* --- actions ---------------------------------------------------------- */

  const markAsRead = useCallback(async (id, isRead) => {
    if (isRead) return
    setOverrides((prev) => ({ ...prev, ids: new Set(prev.ids).add(id) }))
    try {
      // Invalidates `/notifications*`, so the list and the count both refetch
      // and the override is dropped once the real data lands.
      await api.put(`/notifications/${id}/read`)
    } catch (err) {
      console.error('[notifications] mark as read failed:', err)
      setOverrides((prev) => {
        const ids = new Set(prev.ids)
        ids.delete(id)
        return { ...prev, ids }
      })
    }
  }, [])

  const markAllAsRead = useCallback(async () => {
    if (unreadCount === 0) return
    setOverrides({ ids: new Set(), all: true })
    try {
      await api.put('/notifications/read-all')
    } catch (err) {
      console.error('[notifications] mark all as read failed:', err)
      setOverrides(NO_OVERRIDES)
    }
  }, [unreadCount])

  const loadMore = useCallback(async () => {
    setLoadingMore(true)
    setMoreError(null)
    try {
      const res = await api.get('/notifications', { params: { page: nextPage, limit: PAGE_SIZE } })
      setExtraRows((prev) => mergeNotifications(prev, readRows(res.data)))
      setNextPage((p) => p + 1)
    } catch (err) {
      setMoreError(getErrorMessage(err, 'Could not load more notifications.'))
    } finally {
      setLoadingMore(false)
    }
  }, [nextPage])

  const handleSelect = useCallback(
    (notification) => {
      markAsRead(notification._id, notification.read)
      const href = notificationHref(notification, role)
      if (href) {
        setOpen(false)
        navigate(href)
      }
    },
    [markAsRead, navigate, role]
  )

  const retry = listQuery.refetch

  /* --- render ------------------------------------------------------------ */

  const badgeLabel =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications, none unread'

  return (
    <>
      {/*
        The count is announced on its own polite region rather than by making
        the list `aria-live`. A live LIST re-reads every row whenever it
        changes; a live COUNT says the one thing that changed. Neither moves
        focus, so an arrival can never interrupt what the user is doing.
      */}
      <span className="sr-only" role="status" aria-live="polite">
        {unreadCount > 0 ? `${unreadCount} unread notifications` : ''}
      </span>

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="sm" iconOnly aria-label={badgeLabel} className="relative">
            <Bell className="h-4 w-4" />
            {unreadCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5" aria-hidden="true">
                <CountBadge
                  count={unreadCount}
                  max={9}
                  variant="danger"
                  className="h-4 min-w-[16px] px-1"
                />
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>

        {/* Radix gives the content `role="dialog"`, which axe requires to have
            an accessible name; without this the popover announces as an unnamed
            dialog. */}
        <PopoverContent align="end" aria-label="Notifications" className="w-[360px] p-0">
          <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="text-sm font-semibold text-fg">Notifications</h2>
            {unreadCount > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={markAllAsRead}
                leftIcon={<CheckCheck className="h-3.5 w-3.5" />}
              >
                Mark all read
              </Button>
            ) : null}
          </div>

          <div className="max-h-[360px] overflow-y-auto custom-scrollbar">
            {listQuery.loading ? (
              <NotificationSkeleton />
            ) : listQuery.error ? (
              <div className="px-4 py-8 text-center" role="alert">
                <p className="text-sm font-medium text-fg">Could not load notifications</p>
                <p className="mt-1 text-sm text-fg-3">{listQuery.error}</p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  size="sm"
                  onClick={retry}
                  leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                >
                  Try again
                </Button>
              </div>
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Bell}
                title="You're all caught up"
                description="Task assignments, comments and approvals will appear here."
                className="py-8"
              />
            ) : (
              <>
                {groups.map((group) => (
                  <section key={group.id} aria-label={group.label}>
                    <h3 className="sticky top-0 z-10 bg-elevated px-3 py-1.5 text-2xs font-semibold uppercase tracking-wide text-fg-3">
                      {group.label}
                    </h3>
                    <ul className="divide-y divide-line border-b border-line last:border-b-0">
                      {group.items.map((n) => (
                        <li key={n._id}>
                          <NotificationRow notification={n} role={role} onSelect={handleSelect} />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}

                {moreError ? (
                  <p className="px-3 py-2 text-xs text-danger-text" role="alert">
                    {moreError}
                  </p>
                ) : null}

                {hasMore ? (
                  <div className="p-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      className="w-full"
                      onClick={loadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? 'Loading…' : `Load older (${total - loadedCount} more)`}
                    </Button>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * One row.
 *
 * Unread is carried by a dot AND the font weight — shape channels, so it never
 * depends on the tint being visible. The type label is written out beside the
 * icon for the same reason: colour marks the exception, it never carries the
 * meaning on its own (docs/audits/IMPL-light-theme.md).
 */
function NotificationRow({ notification, role, onSelect }) {
  const { label, icon: Icon, toneClass } = describeNotification(notification)
  const href = notificationHref(notification, role)
  const unread = !notification.read

  return (
    <button
      type="button"
      onClick={() => onSelect(notification)}
      aria-label={`${label}: ${notification.message}${unread ? ' (unread)' : ''}`}
      className={cn(
        'flex w-full items-start gap-2.5 px-3 py-2.5 text-left',
        'transition-colors duration-100 hover:bg-subtle',
        'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-600',
        unread && 'bg-primary-subtle'
      )}
    >
      <Icon aria-hidden="true" className={cn('mt-0.5 h-4 w-4 shrink-0', toneClass)} />

      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="text-2xs font-semibold uppercase tracking-wide text-fg-3">{label}</span>
          {unread ? (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-primary-600" />
          ) : null}
        </span>
        <span
          className={cn(
            'mt-0.5 block text-sm leading-snug',
            unread ? 'font-medium text-fg' : 'text-fg-2'
          )}
        >
          {notification.message}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-3">
          <span className="tabular">{timeAgo(notification.createdAt)}</span>
          {href ? null : <span className="text-fg-off">· Nothing to open</span>}
        </span>
      </span>
    </button>
  )
}

/** Mirrors the real row layout — icon, type line, message, timestamp. */
function NotificationSkeleton() {
  return (
    <div role="status" aria-label="Loading notifications" className="divide-y divide-line">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start gap-2.5 px-3 py-2.5">
          <Skeleton className="h-4 w-4 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2 w-20" />
          </div>
        </div>
      ))}
    </div>
  )
}

export default NotificationBell
