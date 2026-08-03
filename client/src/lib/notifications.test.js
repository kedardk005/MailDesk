/**
 * Notification presentation rules.
 *
 * The type table has to stay in step with `NOTIFICATION_EVENTS` in
 * `server/models/User.js`, and the fallback path has to survive a row with no
 * `type` at all — which is not hypothetical: the overdue cron writes the
 * assignee's own row without one (server/utils/cronJobs.js).
 */
import { describe, expect, it } from 'vitest'

import {
  NOTIFICATION_TYPES,
  countUnread,
  describeNotification,
  groupNotifications,
  mergeNotifications,
  notificationHref,
  visibleToRole,
} from './notifications'

/** Verbatim from server/models/User.js. */
const SERVER_EVENTS = [
  'task_assigned',
  'task_completed',
  'task_overdue',
  'task_comment',
  'email_assigned',
  'email_approval',
  'system',
]

const at = (iso) => new Date(iso).toISOString()

describe('the type table', () => {
  it('covers exactly the events the server can send', () => {
    expect(Object.keys(NOTIFICATION_TYPES).sort()).toEqual([...SERVER_EVENTS].sort())
  })

  it('gives every type a distinct icon, so colour is never the only channel', () => {
    const icons = Object.values(NOTIFICATION_TYPES).map((t) => t.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  it('falls back to a neutral "Update" for a row with no type', () => {
    const meta = describeNotification({ message: 'Your task is overdue: X' })
    expect(meta.label).toBe('Update')
    expect(meta.tone).toBe('neutral')
    expect(meta.icon).toBeTypeOf('object')
  })

  it('falls back for a type this client has never heard of', () => {
    expect(describeNotification({ type: 'invoice_paid' }).label).toBe('Update')
  })

  it('keeps overdue the only danger tone and comments neutral', () => {
    expect(NOTIFICATION_TYPES.task_overdue.tone).toBe('danger')
    expect(NOTIFICATION_TYPES.task_comment.tone).toBe('neutral')
    expect(NOTIFICATION_TYPES.system.tone).toBe('neutral')
  })
})

describe('role appropriateness', () => {
  it('hides the approval type from an Employee — every keyword-rule route is Admin/Head', () => {
    const approval = { _id: 'n1', type: 'email_approval' }
    expect(visibleToRole(approval, 'Employee')).toBe(false)
    expect(visibleToRole(approval, 'Head')).toBe(true)
    expect(visibleToRole(approval, 'Admin')).toBe(true)
  })

  it('shows every task type to every role', () => {
    for (const type of ['task_assigned', 'task_completed', 'task_overdue', 'task_comment']) {
      expect(visibleToRole({ type }, 'Employee')).toBe(true)
    }
  })

  it('never hides a row it cannot classify', () => {
    expect(visibleToRole({ message: 'something' }, 'Employee')).toBe(true)
    expect(visibleToRole({ type: 'brand_new_type' }, 'Employee')).toBe(true)
  })

  it('shows everything when the role is not known yet', () => {
    expect(visibleToRole({ type: 'email_approval' }, null)).toBe(true)
  })
})

describe('deep links', () => {
  it('opens the task drawer whenever a taskId is present, whatever the type says', () => {
    expect(notificationHref({ type: 'task_comment', taskId: 't7' }, 'Employee')).toBe(
      '/tasks?expandTaskId=t7'
    )
    expect(notificationHref({ type: 'system', taskId: 't7' }, 'Admin')).toBe(
      '/tasks?expandTaskId=t7'
    )
  })

  it('sends the multi-task overdue digest to the Late filter, which has no single id', () => {
    expect(notificationHref({ type: 'task_overdue', taskId: null }, 'Head')).toBe(
      '/tasks?status=Late'
    )
  })

  it('routes a mail assignment to the inbox for Admin/Head', () => {
    expect(notificationHref({ type: 'email_assigned' }, 'Admin')).toBe('/inbox?status=assigned')
    expect(notificationHref({ type: 'email_approval' }, 'Head')).toBe('/inbox?approval=pending')
  })

  it('routes an Employee mail assignment to Tasks — /inbox is Admin/Head only', () => {
    // The server links every assigned email to a task (ensureTaskForEmail), so
    // Tasks is the surface an Employee can actually reach. Sending them to
    // /inbox would bounce off AdminRoute.
    expect(notificationHref({ type: 'email_assigned' }, 'Employee')).toBe('/tasks')
  })

  it('has nothing to open for a system message', () => {
    expect(notificationHref({ type: 'system' }, 'Admin')).toBeNull()
    expect(notificationHref(null, 'Admin')).toBeNull()
  })
})

describe('grouping', () => {
  const NOW = new Date('2026-08-03T14:00:00').getTime()

  it('splits into Today / Yesterday / Earlier', () => {
    const groups = groupNotifications(
      [
        { _id: 'a', createdAt: at('2026-08-03T09:00:00') },
        { _id: 'b', createdAt: at('2026-08-02T22:00:00') },
        { _id: 'c', createdAt: at('2026-07-28T10:00:00') },
      ],
      NOW
    )

    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday', 'Earlier'])
    expect(groups[0].items.map((n) => n._id)).toEqual(['a'])
    expect(groups[1].items.map((n) => n._id)).toEqual(['b'])
    expect(groups[2].items.map((n) => n._id)).toEqual(['c'])
  })

  it('drops empty groups rather than rendering an empty heading', () => {
    const groups = groupNotifications([{ _id: 'a', createdAt: at('2026-08-03T09:00:00') }], NOW)
    expect(groups).toHaveLength(1)
    expect(groups[0].label).toBe('Today')
  })

  it('groups by calendar day, not by a rolling 24 hours', () => {
    // 00:30 today is 13.5 hours ago but is still "Today".
    const groups = groupNotifications([{ _id: 'a', createdAt: at('2026-08-03T00:30:00') }], NOW)
    expect(groups[0].label).toBe('Today')
  })

  it('preserves the order the endpoint sent within a group', () => {
    const groups = groupNotifications(
      [
        { _id: 'newer', createdAt: at('2026-08-03T12:00:00') },
        { _id: 'older', createdAt: at('2026-08-03T08:00:00') },
      ],
      NOW
    )
    expect(groups[0].items.map((n) => n._id)).toEqual(['newer', 'older'])
  })

  it('puts an unparseable timestamp under Today rather than burying it under Earlier', () => {
    const groups = groupNotifications([{ _id: 'a', createdAt: 'not-a-date' }], NOW)
    expect(groups[0].label).toBe('Today')
  })

  it('handles an empty and a missing list', () => {
    expect(groupNotifications([], NOW)).toEqual([])
    expect(groupNotifications(undefined, NOW)).toEqual([])
  })
})

describe('unread accounting', () => {
  it('merges without duplicating an id — the socket arrival and the page load are one row', () => {
    const fromSocket = [{ _id: 'n1', read: false, createdAt: at('2026-08-03T12:00:00') }]
    const fromFetch = [
      { _id: 'n1', read: false, createdAt: at('2026-08-03T12:00:00') },
      { _id: 'n0', read: true, createdAt: at('2026-08-03T09:00:00') },
    ]

    const merged = mergeNotifications(fromSocket, fromFetch)

    expect(merged).toHaveLength(2)
    expect(countUnread(merged)).toBe(1)
  })

  it('sorts the merged list newest first', () => {
    const merged = mergeNotifications(
      [{ _id: 'old', createdAt: at('2026-08-01T10:00:00') }],
      [{ _id: 'new', createdAt: at('2026-08-03T10:00:00') }]
    )
    expect(merged.map((n) => n._id)).toEqual(['new', 'old'])
  })

  it('prefers the incoming copy of a row, so a fresh read:true wins over a stale read:false', () => {
    const merged = mergeNotifications(
      [{ _id: 'n1', read: false, createdAt: at('2026-08-03T10:00:00') }],
      [{ _id: 'n1', read: true, createdAt: at('2026-08-03T10:00:00') }]
    )
    expect(merged[0].read).toBe(true)
    expect(countUnread(merged)).toBe(0)
  })

  it('skips rows with no id rather than keying a list on undefined', () => {
    expect(mergeNotifications([], [{ message: 'no id' }])).toEqual([])
  })

  it('counts nothing for an empty or missing list', () => {
    expect(countUnread([])).toBe(0)
    expect(countUnread(undefined)).toBe(0)
  })
})
