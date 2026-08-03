import { Link, useLocation } from 'react-router-dom'
import { FileQuestion } from 'lucide-react'
import { Button } from './ui/Button'

/**
 * 404 route. Previously `path="*"` silently redirected to /login, so a typo in
 * any URL logged the user out of their mental model of where they were.
 */
export function NotFound() {
  const location = useLocation()
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-6 py-16 text-center">
      <FileQuestion aria-hidden="true" className="h-8 w-8 text-fg-off" strokeWidth={1.5} />
      <h1 className="mt-3 text-xl font-semibold text-fg">Page not found</h1>
      <p className="mt-1 max-w-[420px] text-sm text-fg-3">
        <code className="rounded-sm bg-subtle px-1 py-0.5 text-xs">{location.pathname}</code> does
        not exist. It may have been renamed or you may not have access to it.
      </p>
      <div className="mt-5 flex items-center gap-2">
        <Button as={Link} to="/dashboard" variant="primary">
          Go to Dashboard
        </Button>
        <Button variant="secondary" onClick={() => window.history.back()}>
          Go back
        </Button>
      </div>
    </div>
  )
}

export default NotFound
