import { Link, Navigate } from 'react-router-dom'
import { LogIn, Mail } from 'lucide-react'

import { useAuth } from '../components/AuthProvider'
import { Button } from '../components/ui'

/**
 * Root route.
 *
 * This used to be a fake SaaS marketing page: "Trusted by 500+ teams
 * worldwide" over five invented avatars, hardcoded metrics seeded to
 * 1,248 emails / 340 tasks, invented trends ("↑ 12% this week"), three
 * 400–500px animated blobs, and "Start for Free" / "See a Demo" CTAs for
 * products that do not exist. It also called the Admin/Head-only
 * `/reports/overall` endpoint for every signed-in visitor, including
 * Employees, who got a 403 toast on the landing page.
 *
 * MailDesk is internal company software with no public signup, so the root
 * route is now just an entry point: signed in goes to the dashboard, signed
 * out gets a sign-in card. No statistics, no testimonials, no network calls.
 */
export default function Landing() {
  const { isAuthenticated } = useAuth()

  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <main className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[420px]">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 items-center justify-center rounded-lg border border-primary-border bg-primary-subtle text-primary-text"
            >
              <Mail className="h-4 w-4" />
            </span>
            <span className="text-md font-semibold tracking-tight text-fg">K M KOTHARI</span>
          </div>

          <div className="mt-6 rounded-lg border border-line bg-surface p-6">
            <h1 className="text-xl font-semibold text-fg">Email and task workspace</h1>
            <p className="mt-1.5 text-sm text-fg-2">
              Shared inbox, client records and task assignment for the office. Sign in with your
              work account to continue.
            </p>

            <Button
              as={Link}
              to="/login"
              variant="primary"
              size="lg"
              fullWidth
              leftIcon={<LogIn className="h-4 w-4" />}
              className="mt-6"
            >
              Sign in
            </Button>

            <p className="mt-4 text-sm text-fg-3">
              No account yet?{' '}
              <Link
                to="/register"
                className="rounded font-medium text-primary-text underline underline-offset-2 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
              >
                Request access
              </Link>
              . An administrator has to approve the request before you can sign in.
            </p>
          </div>

          <p className="mt-4 text-xs text-fg-3">
            Trouble signing in? Contact your workspace administrator.
          </p>
        </div>
      </main>
    </div>
  )
}
