import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from './AuthProvider'

/**
 * Requires a session. Preserves the attempted URL so login can bounce back.
 */
export function ProtectedRoute({ children }) {
  const { isAuthenticated } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />
  }

  return children
}

export default ProtectedRoute
