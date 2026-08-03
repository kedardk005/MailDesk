import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCheck } from 'lucide-react'
import api from '../api/axios'
import { getSocket, isAuthHandshakeError } from '../lib/socket'
import { cn, timeAgo } from '../lib/utils'
import { useAuth } from './AuthProvider'
import { Button } from './ui/Button'
import { CountBadge } from './ui/Badge'
import { EmptyState } from './ui/EmptyState'
import { Popover, PopoverContent, PopoverTrigger } from './ui/Popover'

/**
 * Notification bell.
 *
 * Fixed here: hard-coded socket URL (now env-driven via lib/socket), no
 * `connect_error` handler (a rejected handshake retried silently forever),
 * a bouncing bell, and a permanently pulsing unread chip.
 *
 * The socket is the shared singleton — this component no longer opens its own.
 */
export function NotificationBell() {
  const navigate = useNavigate()
  const { token } = useAuth()
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [open, setOpen] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const fetchNotifications = useCallback(async (signal) => {
    try {
      const res = await api.get('/notifications', { signal })
      if (!mounted.current) return
      const list = Array.isArray(res.data) ? res.data : []
      setNotifications(list)
      setUnreadCount(list.filter((n) => !n.read).length)
    } catch (err) {
      if (err?.code !== 'ERR_CANCELED') {
        console.error('[notifications] fetch failed:', err)
      }
    }
  }, [])

  useEffect(() => {
    if (!token) return undefined
    const controller = new AbortController()
    // Fetch-on-mount: every setState happens after an await, in the promise
    // callback. The rule cannot see across the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchNotifications(controller.signal)
    return () => controller.abort()
  }, [token, fetchNotifications])

  /* Real-time updates over the shared socket. `token` in the dependency list
   * re-subscribes after a tokenVersion change (password reset, role change). */
  useEffect(() => {
    if (!token) return undefined
    const socket = getSocket()
    if (!socket) return undefined

    const onNew = (notification) => {
      if (!mounted.current || !notification) return
      setNotifications((prev) => [notification, ...prev])
      setUnreadCount((prev) => prev + 1)
    }

    const onConnectError = (error) => {
      // Silent infinite retry was the old behaviour. Log once and stop.
      if (isAuthHandshakeError(error)) {
        console.warn('[notifications] socket rejected the session; live updates paused.')
        socket.disconnect()
      } else {
        console.warn('[notifications] socket unavailable:', error?.message)
      }
    }

    socket.on('newNotification', onNew)
    socket.on('connect_error', onConnectError)

    return () => {
      socket.off('newNotification', onNew)
      socket.off('connect_error', onConnectError)
    }
  }, [token])

  const markAsRead = async (id, isRead) => {
    if (isRead) return
    try {
      await api.put(`/notifications/${id}/read`)
      setNotifications((prev) => prev.map((n) => (n._id === id ? { ...n, read: true } : n)))
      setUnreadCount((prev) => Math.max(0, prev - 1))
    } catch (err) {
      console.error('[notifications] mark as read failed:', err)
    }
  }

  const markAllAsRead = async () => {
    if (unreadCount === 0) return
    try {
      await api.put('/notifications/read-all')
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('[notifications] mark all as read failed:', err)
    }
  }

  const handleClick = async (n) => {
    await markAsRead(n._id, n.read)
    if (n.taskId) navigate(`/tasks?expandTaskId=${n.taskId}`)
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          className="relative"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5">
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

      <PopoverContent align="end" className="w-[340px] p-0">
        <div className="flex items-center justify-between border-b border-line px-3 py-2">
          <p className="text-sm font-semibold text-fg">Notifications</p>
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

        <div
          className="max-h-[320px] overflow-y-auto custom-scrollbar"
          role="log"
          aria-live="polite"
        >
          {notifications.length === 0 ? (
            <EmptyState
              icon={Bell}
              title="No notifications"
              description="Task assignments and comments will appear here."
              className="py-8"
            />
          ) : (
            <ul className="divide-y divide-line">
              {notifications.slice(0, 20).map((n) => (
                <li key={n._id}>
                  <button
                    type="button"
                    onClick={() => handleClick(n)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left',
                      'transition-colors duration-100 hover:bg-subtle',
                      'focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-600',
                      !n.read && 'bg-primary-subtle'
                    )}
                  >
                    <span
                      className={cn(
                        'text-sm leading-snug',
                        n.read ? 'text-fg-2' : 'font-medium text-fg'
                      )}
                    >
                      {n.message}
                    </span>
                    <span className="text-xs tabular text-fg-3">{timeAgo(n.createdAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default NotificationBell
