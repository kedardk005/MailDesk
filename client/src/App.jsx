import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'

import AdminRoute from './components/AdminRoute'
import AuthProvider from './components/AuthProvider'
import ErrorBoundary from './components/ErrorBoundary'
import NotFound from './components/NotFound'
import ProtectedRoute from './components/ProtectedRoute'
import ThemeProvider from './components/ThemeProvider'
import { ConfirmProvider } from './components/ui/ConfirmDialog'
import { Toaster } from './components/ui/Toaster'
import { TooltipProvider } from './components/ui/Tooltip'
import { Skeleton } from './components/ui/Skeleton'

/* ---------------------------------------------------------------------------
 * Code splitting.
 * The app used to ship as a single 638 kB chunk, so /login downloaded TaskList,
 * EmailInbox, Reports and socket.io before anyone could type a password.
 * Every route below is its own chunk.
 * ------------------------------------------------------------------------- */
/* The shell itself is lazy too: it pulls socket.io, and an unauthenticated
 * visitor on /login has no use for a realtime connection. */
const ProtectedLayout = lazy(() => import('./components/ProtectedLayout'))

const Landing = lazy(() => import('./pages/Landing'))
const Login = lazy(() => import('./pages/Login'))
const Register = lazy(() => import('./pages/Register'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const EmailInbox = lazy(() => import('./pages/EmailInbox'))
const TaskList = lazy(() => import('./pages/TaskList'))
const ClientList = lazy(() => import('./pages/ClientList'))
const Profile = lazy(() => import('./pages/Profile'))
const Reports = lazy(() => import('./pages/admin/Reports'))
const ManageUsers = lazy(() => import('./pages/admin/ManageUsers'))
const ActivityLog = lazy(() => import('./pages/admin/ActivityLog'))

/** Route-level fallback — a layout-shaped skeleton, never a bare spinner. */
function RouteSkeleton() {
  return (
    <div className="p-6" role="status" aria-label="Loading page">
      <Skeleton className="h-7 w-48" />
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-lg border border-line bg-surface px-4 py-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-6 w-16" />
          </div>
        ))}
      </div>
      <div className="mt-6 rounded-lg border border-line bg-surface">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex h-10 items-center gap-4 border-b border-line px-3 last:border-0"
          >
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 flex-[2]" />
            <Skeleton className="h-3 flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Per-route isolation: a throw inside one page renders an inline error with the
 * shell and navigation still usable, instead of a white screen.
 */
function RouteShell({ children }) {
  const location = useLocation()
  return (
    <ErrorBoundary compact resetKey={location.key}>
      <Suspense fallback={<RouteSkeleton />}>{children}</Suspense>
    </ErrorBoundary>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <ConfirmProvider>
              <BrowserRouter>
                <Routes>
                  <Route
                    path="/"
                    element={
                      <RouteShell>
                        <Landing />
                      </RouteShell>
                    }
                  />
                  <Route
                    path="/login"
                    element={
                      <RouteShell>
                        <Login />
                      </RouteShell>
                    }
                  />
                  <Route
                    path="/register"
                    element={
                      <RouteShell>
                        <Register />
                      </RouteShell>
                    }
                  />
                  <Route
                    path="/forgot-password"
                    element={
                      <RouteShell>
                        <ForgotPassword />
                      </RouteShell>
                    }
                  />
                  {/*
                    Reset links mailed by the server point at
                    `${FRONTEND_URL}/reset-password?token=…`. ForgotPassword is
                    token-driven: with no `?token=` it renders the request form,
                    with one it renders the reset form. Same component, so no
                    extra import and no extra chunk.
                  */}
                  <Route
                    path="/reset-password"
                    element={
                      <RouteShell>
                        <ForgotPassword />
                      </RouteShell>
                    }
                  />

                  <Route
                    element={
                      <ProtectedRoute>
                        <Suspense fallback={<RouteSkeleton />}>
                          <ProtectedLayout />
                        </Suspense>
                      </ProtectedRoute>
                    }
                  >
                    <Route
                      path="/dashboard"
                      element={
                        <RouteShell>
                          <Dashboard />
                        </RouteShell>
                      }
                    />
                    <Route
                      path="/inbox"
                      element={
                        <RouteShell>
                          <EmailInbox />
                        </RouteShell>
                      }
                    />
                    <Route
                      path="/tasks"
                      element={
                        <RouteShell>
                          <TaskList />
                        </RouteShell>
                      }
                    />
                    <Route
                      path="/clients"
                      element={
                        <RouteShell>
                          <ClientList />
                        </RouteShell>
                      }
                    />
                    <Route
                      path="/profile"
                      element={
                        <RouteShell>
                          <Profile />
                        </RouteShell>
                      }
                    />

                    <Route
                      path="/reports"
                      // The server has always served reports to Head and contains
                      // Head-scoping logic; gating this Admin-only client-side meant
                      // that branch could never run. The page hides the Admin-only
                      // employee-performance tab for Head on its own.
                      element={
                        <AdminRoute roles={['Admin', 'Head']} title="Reports">
                          <RouteShell>
                            <Reports />
                          </RouteShell>
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/admin/users"
                      element={
                        <AdminRoute title="Users & approvals">
                          <RouteShell>
                            <ManageUsers />
                          </RouteShell>
                        </AdminRoute>
                      }
                    />
                    <Route
                      path="/admin/activities"
                      element={
                        <AdminRoute title="Activity log">
                          <RouteShell>
                            <ActivityLog />
                          </RouteShell>
                        </AdminRoute>
                      }
                    />

                    {/* 404 inside the shell — the user keeps their navigation. */}
                    <Route path="*" element={<NotFound />} />
                  </Route>

                  {/* Any other path falls through to the shell's 404 above,
                      which redirects to /login when there is no session. */}
                  <Route path="/404" element={<Navigate to="/dashboard" replace />} />
                </Routes>
              </BrowserRouter>

              {/* Mounted once — replaces the toast block copy-pasted into 7 pages. */}
              <Toaster />
            </ConfirmProvider>
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
