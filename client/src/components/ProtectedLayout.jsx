import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import api from '../api/axios'
import { getSocket, isAuthHandshakeError } from '../lib/socket'
import { useAuth } from './AuthProvider'
import { CommandPalette } from './CommandPalette'
import { CommandRegistryProvider } from './CommandRegistry'
import ErrorBoundary from './ErrorBoundary'
import Navbar from './Navbar'
import Sidebar from './Sidebar'
import { toast } from './ui/Toaster'

const COLLAPSED_KEY = 'maildesk_sidebar_collapsed'

/**
 * Fixed application shell.
 *
 *   ┌ TopBar 48 ─────────────────────────────────┐
 *   │ Sidebar 240/56 │ main (the ONLY scroller)  │
 *   └────────────────┴───────────────────────────┘
 *
 * The body does not scroll; `<main>` does. The sidebar is a flex sibling on
 * desktop, so the old 20px clipping bug (sidebar `w-[260px]` against content
 * offset `lg:pl-60` = 240px) is structurally impossible now.
 *
 * Session freshness: the previous implementation polled `/auth/me` every 8
 * seconds — 450 requests/hour/tab against a 300-per-15-minutes per-IP limiter,
 * so an office behind one NAT self-throttled at about three users. Now the
 * Socket.io handshake carries the signal (the server rejects a stale
 * `tokenVersion`) and a 5-minute poll is the fallback.
 */
export function ProtectedLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, setUser, logout } = useAuth()

  const [isSidebarOpen, setSidebarOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const [paletteOpen, setPaletteOpen] = useState(false)

  const knownRoleRef = useRef(user?.role || null)

  /* SCROLL CONTAINMENT — the document must never be a scroller inside the app.
   *
   * The shell below is `h-screen overflow-hidden` and `<main>` owns scrolling,
   * yet Chromium still gives the *viewport* a scrollbar on some pages: content
   * inside `<main>` (measured: /inbox 1378px, /profile 1648px against a 720px
   * viewport) leaks into the document's scrollable overflow, so a wheel at the
   * bottom of `<main>` chains to the window and drags the whole app up into a
   * blank page. Locking overflow on <html>/<body> while the shell is mounted
   * removes that scrollbar entirely; public pages (Landing/Login) are outside
   * this layout and keep their normal document scrolling. */
  useEffect(() => {
    const html = document.documentElement
    const prevHtml = html.style.overflow
    const prevBody = document.body.style.overflow
    html.style.overflow = 'hidden'
    document.body.style.overflow = 'hidden'
    return () => {
      html.style.overflow = prevHtml
      document.body.style.overflow = prevBody
    }
  }, [])

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c
      try {
        window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  const forceSignOut = useCallback(
    (message) => {
      logout()
      if (message) toast.error(message)
      navigate('/login', { replace: true })
    },
    [logout, navigate]
  )

  /** One authoritative refresh of the current user. */
  const syncSession = useCallback(
    async (signal) => {
      try {
        const res = await api.get('/auth/me', { signal })
        const latest = res.data
        if (!latest) return

        if (latest.status && latest.status !== 'Approved') {
          forceSignOut('Your account is no longer active. Contact an administrator.')
          return
        }

        // Role change: update context state. Never window.location.reload() —
        // that threw away unsaved work and every in-flight request.
        if (knownRoleRef.current && latest.role !== knownRoleRef.current) {
          toast.info(`Your role changed to ${latest.role}. Navigation has been updated.`)
        }
        knownRoleRef.current = latest.role
        setUser(latest)
      } catch (err) {
        // 401/403 are already handled by the axios response interceptor.
        if (err?.name !== 'CanceledError' && err?.code !== 'ERR_CANCELED') {
          console.error('[session] sync failed:', err)
        }
      }
    },
    [forceSignOut, setUser]
  )

  /* Initial sync + slow fallback poll. */
  useEffect(() => {
    const controller = new AbortController()
    syncSession(controller.signal)

    const interval = window.setInterval(
      () => syncSession(),
      5 * 60 * 1000 // 5 minutes — the socket is the primary signal
    )

    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [syncSession])

  /* Socket-driven session/role invalidation. */
  useEffect(() => {
    const socket = getSocket()
    if (!socket) return undefined

    const onConnectError = (error) => {
      if (isAuthHandshakeError(error)) {
        // The handshake rejects a revoked or version-bumped token. Confirm with
        // one REST call so a transient server restart cannot sign people out.
        socket.disconnect()
        syncSession()
      } else {
        console.warn('[socket] connection error:', error?.message)
      }
    }

    /* Optional server-pushed signals. Harmless if the server never emits them —
     * the handshake rejection and the 5-minute poll already cover the cases. */
    const onSessionInvalidated = () =>
      forceSignOut('Your session was ended. Please sign in again.')
    const onUserUpdated = () => syncSession()

    socket.on('connect_error', onConnectError)
    socket.on('session:invalidated', onSessionInvalidated)
    socket.on('user:updated', onUserUpdated)

    return () => {
      socket.off('connect_error', onConnectError)
      socket.off('session:invalidated', onSessionInvalidated)
      socket.off('user:updated', onUserUpdated)
    }
  }, [syncSession, forceSignOut])

  return (
    /* The registry must wrap BOTH the routed page (which registers commands)
     * and the single palette (which reads them). There is exactly one palette
     * in the app — see CommandRegistry.jsx. */
    <CommandRegistryProvider>
      <div className="flex h-screen flex-col overflow-hidden bg-canvas text-fg">
        <Navbar
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
          onToggleCollapsed={toggleCollapsed}
          onOpenCommandPalette={() => setPaletteOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <Sidebar
            isOpen={isSidebarOpen}
            onClose={() => setSidebarOpen(false)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />

          {/* The ONLY scroll container in the app. It is a flex column so a
            * page can opt into scroll containment: `<PageBody fill>` takes the
            * remaining height (`flex-1 min-h-0`) and the table body inside it
            * becomes the scroller instead of <main>. Pages that do not opt in
            * stack exactly as before and <main> scrolls. */}
          <main
            id="main-content"
            className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-canvas custom-scrollbar"
          >
            <ErrorBoundary compact resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </main>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </CommandRegistryProvider>
  )
}

export default ProtectedLayout
