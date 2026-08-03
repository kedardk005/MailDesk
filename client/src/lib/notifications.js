import {
  Bell,
  CheckCircle2,
  ClipboardList,
  Info,
  Mail,
  MessageSquare,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'

/**
 * Notification presentation: one place that knows what a `type` means, what it
 * looks like, where clicking it should land, and which roles can act on it.
 *
 * Kept out of the component so the rules are unit-testable without rendering a
 * Radix popover, and so there is exactly one table to keep in step with the
 * server.
 *
 * ## The types
 *
 * `TYPES` mirrors `NOTIFICATION_EVENTS` in `server/models/User.js` — read from
 * there, not guessed. `type` is **optional** on the Notification model, so a
 * row can arrive with none; `UNKNOWN` is the fallback and is never a crash.
 *
 * ## Colour
 *
 * Per docs/audits/IMPL-light-theme.md: neutral is the default and colour marks
 * the exception. Only the ICON carries the semantic tone — the message, the
 * timestamp and the row background stay neutral, so a busy bell does not turn
 * into a colour chart. Unread state is signalled by a dot plus font weight (a
 * shape channel), never by hue alone, and every row also carries a written
 * type label, so the icon is never the only cue.
 */

/** @typedef {'neutral'|'primary'|'success'|'warning'|'danger'} Tone */

const TONE_CLASS = {
  neutral: 'text-fg-3',
  primary: 'text-primary-text',
  success: 'text-success-text',
  warning: 'text-warning-text',
  danger: 'text-danger-text',
}

/**
 * The canonical table. `roles` lists the roles that can actually DO something
 * with the notification; a role outside it never sees the row (see
 * `visibleToRole`).
 */
export const NOTIFICATION_TYPES = {
  task_assigned: {
    label: 'Task assigned',
    icon: ClipboardList,
    // Awaiting the recipient's action — the "primary" rule from the theme doc.
    tone: 'primary',
    roles: ['Admin', 'Head', 'Employee'],
  },
  task_completed: {
    label: 'Task completed',
    icon: CheckCircle2,
    tone: 'success',
    // Only ever written to a task's creator, and only Admin/Head can create
    // tasks (server/routes/taskRoutes.js). Listed for all three because an
    // Employee who somehow received one can still open the task.
    roles: ['Admin', 'Head', 'Employee'],
  },
  task_overdue: {
    label: 'Task overdue',
    icon: TriangleAlert,
    tone: 'danger',
    roles: ['Admin', 'Head', 'Employee'],
  },
  task_comment: {
    label: 'Comment',
    icon: MessageSquare,
    tone: 'neutral',
    roles: ['Admin', 'Head', 'Employee'],
  },
  email_assigned: {
    label: 'Mail assigned',
    icon: Mail,
    tone: 'primary',
    roles: ['Admin', 'Head', 'Employee'],
  },
  email_approval: {
    label: 'Approval',
    icon: ShieldCheck,
    tone: 'warning',
    // The approval queue lives behind /inbox and every keyword-rule route is
    // authorizeRoles('Admin','Head'). An Employee can do nothing with this.
    roles: ['Admin', 'Head'],
  },
  system: {
    label: 'System',
    icon: Info,
    tone: 'neutral',
    roles: ['Admin', 'Head', 'Employee'],
  },
}

/** Fallback for a row with no `type`, or a `type` this client does not know. */
export const UNKNOWN_TYPE = {
  label: 'Update',
  icon: Bell,
  tone: 'neutral',
  roles: ['Admin', 'Head', 'Employee'],
}

/**
 * @param {object} notification
 * @returns {{label: string, icon: Function, tone: Tone, toneClass: string}}
 */
export function describeNotification(notification) {
  const meta = NOTIFICATION_TYPES[notification?.type] || UNKNOWN_TYPE
  return { ...meta, toneClass: TONE_CLASS[meta.tone] || TONE_CLASS.neutral }
}

/**
 * Can `role` act on this type at all?
 *
 * An untyped row is always shown: suppressing rows the client cannot classify
 * would hide real information (the overdue cron writes the assignee's own row
 * with no `type` — see server/utils/cronJobs.js).
 *
 * @param {object} notification
 * @param {string|null} role
 * @returns {boolean}
 */
export function visibleToRole(notification, role) {
  if (!role) return true
  const meta = NOTIFICATION_TYPES[notification?.type]
  if (!meta) return true
  return meta.roles.includes(role)
}

/**
 * Where clicking this notification should land — the actual task drawer, the
 * inbox filter or the approval queue, never a bare list.
 *
 * Role matters: `/inbox` is Admin/Head only (App.jsx + Sidebar.jsx), so an
 * Employee's mail assignment routes to the task the server auto-created for it
 * instead (`ensureTaskForEmail`), which is the surface they can actually reach.
 *
 * @param {object} notification
 * @param {string|null} role
 * @returns {string|null} a router path, or null when there is nothing to open
 */
export function notificationHref(notification, role) {
  if (!notification) return null
  const canReachInbox = role === 'Admin' || role === 'Head'

  // A taskId is the strongest signal there is, whatever the type says.
  if (notification.taskId) return `/tasks?expandTaskId=${notification.taskId}`

  switch (notification.type) {
    case 'task_assigned':
    case 'task_comment':
    case 'task_completed':
      return '/tasks'
    case 'task_overdue':
      // The supervisor digest covers many tasks and carries no single id.
      return '/tasks?status=Late'
    case 'email_assigned':
      return canReachInbox ? '/inbox?status=assigned' : '/tasks'
    case 'email_approval':
      return canReachInbox ? '/inbox?approval=pending' : null
    case 'system':
      return null
    default:
      return null
  }
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000

function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Today / Yesterday / Earlier.
 *
 * A flat list of thirty rows is not scannable; a calendar-relative heading is
 * the cheapest thing that makes "is this new?" answerable at a glance without
 * reading every timestamp. Empty groups are dropped, and order is preserved
 * within a group (the endpoint already sorts `-createdAt`).
 *
 * @param {Array<object>} notifications
 * @param {number} [now] epoch ms, injectable so the tests are not clock-flaky
 * @returns {Array<{id: string, label: string, items: Array<object>}>}
 */
export function groupNotifications(notifications, now = Date.now()) {
  const todayStart = startOfDay(now)
  const yesterdayStart = todayStart - DAY_MS

  const groups = [
    { id: 'today', label: 'Today', items: [] },
    { id: 'yesterday', label: 'Yesterday', items: [] },
    { id: 'earlier', label: 'Earlier', items: [] },
  ]

  for (const n of notifications || []) {
    const at = new Date(n?.createdAt ?? 0).getTime()
    // An unparseable date is not "1970" — it is most plausibly just-arrived,
    // and burying it under "Earlier" would hide a live notification.
    const bucket = !Number.isFinite(at) || at >= todayStart ? 0 : at >= yesterdayStart ? 1 : 2
    groups[bucket].items.push(n)
  }

  return groups.filter((g) => g.items.length > 0)
}

/**
 * Merge socket arrivals and fetched pages into one list, newest first, with no
 * duplicate `_id`.
 *
 * This is what stops the badge double-counting: a notification that arrives
 * over the socket AND comes back in the next page load is one row, counted
 * once.
 *
 * @param {Array<object>} existing
 * @param {Array<object>} incoming
 * @returns {Array<object>}
 */
export function mergeNotifications(existing, incoming) {
  const byId = new Map()
  for (const n of [...(incoming || []), ...(existing || [])]) {
    if (!n?._id) continue
    if (!byId.has(n._id)) byId.set(n._id, n)
  }
  return [...byId.values()].sort(
    (a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0)
  )
}

/** @returns {number} unread rows in `list` */
export function countUnread(list) {
  return (list || []).filter((n) => !n.read).length
}
