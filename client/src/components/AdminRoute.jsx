import { Link, Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'
import { Alert } from './ui/Alert'
import { Button } from './ui/Button'
import { PageBody, PageHeader } from './ui/PageHeader'

/**
 * Where a user who cannot open this page should be sent instead. An Employee's
 * work all lives on Tasks; anyone else keeps the dashboard.
 *
 * @param {string} role
 */
function fallbackFor(role) {
  return role === 'Employee'
    ? { to: '/tasks', label: 'Go to my tasks' }
    : { to: '/dashboard', label: 'Go to the dashboard' }
}

/**
 * The in-shell explanation for a page this role cannot open.
 *
 * This replaces a bare `<Navigate to="/dashboard">`. The redirect was safe but
 * mute: an Employee who followed a bookmark or an emailed link to
 * `/admin/users` simply arrived on `/dashboard`, with nothing on screen to say
 * a link had been refused rather than mistyped. `/inbox` already handles the
 * identical situation properly — it renders the page frame with an info Alert
 * naming the roles that may open it and a link to where the user's own work is
 * — so this is that same shape, applied to every role-gated route.
 *
 * It renders inside <ProtectedLayout>, so navigation stays usable and the
 * address bar keeps the URL the user actually asked for.
 */
function AccessDenied({ title, roles }) {
  const { user } = useAuth()
  const fallback = fallbackFor(user?.role)
  const allowed = Array.isArray(roles) ? roles : [roles]
  const allowedText =
    allowed.length === 1 ? `${allowed[0]}s` : `${allowed.slice(0, -1).join('s, ')}s and ${allowed.at(-1)}s`

  return (
    <>
      <PageHeader title={title} description="Restricted area" />
      <PageBody>
        <Alert variant="info" title={`${title} is limited to ${allowedText}`}>
          Your account is signed in as {user?.role || 'a member of staff'}, so this page stays
          closed. Nothing is missing and nothing has gone wrong — the link you followed is simply
          for a different role.
          <div className="mt-2">
            <Button as={Link} to={fallback.to} variant="link">
              {fallback.label}
            </Button>
          </div>
        </Alert>
      </PageBody>
    </>
  )
}

/**
 * Role gate. Defaults to Admin-only.
 *
 * @param {string|string[]} [roles='Admin']
 * @param {string} [title='This page'] - what the page is called, so the refusal
 *        can name it instead of showing a generic wall
 */
export function AdminRoute({ children, roles = 'Admin', title = 'This page' }) {
  const { isAuthenticated, hasRole } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (!hasRole(roles)) {
    return <AccessDenied title={title} roles={roles} />
  }

  return children
}

export default AdminRoute
