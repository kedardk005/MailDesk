/**
 * AUDIT L-9 — `/admin/*` used to redirect silently.
 *
 * An Employee who opened `/admin/users` or `/reports` — from a bookmark, or a
 * link a colleague pasted into an email — landed on `/dashboard` with nothing
 * on screen to say why. The link simply appeared not to work, which reads as a
 * broken app rather than a closed door. `/inbox` already got this right: it
 * renders the page frame with an info Alert naming the roles that may open it
 * and a link to where that user's own work lives.
 *
 * These tests pin the three things that make the difference:
 *   1. the refusal is VISIBLE and names both the page and the roles,
 *   2. it offers a way onward that suits the signed-in role, and
 *   3. the URL does not change — the user can still see what they asked for,
 *      and nothing is auto-redirected out from under them.
 *
 * The authorisation itself is unchanged and still server-enforced; this is
 * only about what the refused user is told.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Route, Routes, useLocation } from 'react-router-dom'

import AdminRoute from './AdminRoute'
import { renderWithProviders, seedSession, TEST_USER } from '../test/utils'

const EMPLOYEE = { ...TEST_USER, _id: 'u-emp', name: 'Ravi Kumar', role: 'Employee' }
const HEAD = { ...TEST_USER, _id: 'u-head', name: 'Priya Nair', role: 'Head' }

/** Renders the current pathname so a test can assert the URL was left alone. */
function PathProbe() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

function renderGate({ user, route, roles, title }) {
  if (user) seedSession({ user })
  return renderWithProviders(
    <>
      <PathProbe />
      <Routes>
        <Route
          path={route}
          element={
            <AdminRoute roles={roles} title={title}>
              <h1>Secret page</h1>
            </AdminRoute>
          }
        />
        <Route path="/login" element={<h1>Sign in</h1>} />
        <Route path="/dashboard" element={<h1>Dashboard</h1>} />
        <Route path="/tasks" element={<h1>Tasks</h1>} />
      </Routes>
    </>,
    { route }
  )
}

describe('AdminRoute — a refused role is told why', () => {
  it('lets an allowed role straight through', () => {
    renderGate({ user: TEST_USER, route: '/admin/users', title: 'Users & approvals' })

    expect(screen.getByRole('heading', { name: 'Secret page' })).toBeInTheDocument()
    expect(screen.queryByText(/Restricted area/)).toBeNull()
  })

  it('explains the refusal instead of silently landing an Employee on /dashboard', () => {
    renderGate({ user: EMPLOYEE, route: '/admin/users', title: 'Users & approvals' })

    expect(screen.queryByRole('heading', { name: 'Secret page' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Dashboard' })).toBeNull()

    /* Names the page, names who may open it, and says which role you are. */
    expect(
      screen.getByText('Users & approvals is limited to Admins')
    ).toBeInTheDocument()
    expect(screen.getByText(/signed in as Employee/)).toBeInTheDocument()

    /* The URL the user asked for is still the URL they are on. */
    expect(screen.getByTestId('path')).toHaveTextContent('/admin/users')
  })

  it('points an Employee at Tasks, where their own work actually is', () => {
    renderGate({ user: EMPLOYEE, route: '/reports', roles: ['Admin', 'Head'], title: 'Reports' })

    expect(screen.getByText('Reports is limited to Admins and Heads')).toBeInTheDocument()

    const onward = screen.getByRole('link', { name: 'Go to my tasks' })
    expect(onward).toHaveAttribute('href', '/tasks')
  })

  it('points a Head at the dashboard rather than at Tasks', () => {
    renderGate({ user: HEAD, route: '/admin/activities', title: 'Activity log' })

    expect(screen.getByText('Activity log is limited to Admins')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Go to the dashboard' })).toHaveAttribute(
      'href',
      '/dashboard'
    )
  })

  it('still sends a signed-out visitor to /login, not to the explanation', () => {
    renderGate({ user: null, route: '/admin/users', title: 'Users & approvals' })

    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument()
    expect(screen.queryByText(/Restricted area/)).toBeNull()
  })
})
