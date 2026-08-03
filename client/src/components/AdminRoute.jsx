import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

/**
 * Role gate. Defaults to Admin-only.
 *
 * @param {string|string[]} [roles='Admin']
 */
export function AdminRoute({ children, roles = 'Admin' }) {
  const { isAuthenticated, hasRole } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  if (!hasRole(roles)) {
    return <Navigate to="/dashboard" replace />
  }

  return children
}

export default AdminRoute
