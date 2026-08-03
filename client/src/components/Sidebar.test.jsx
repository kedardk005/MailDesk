/**
 * Sidebar navigation × roles.
 *
 * The class of bug guarded here (volume-audit D6): a route the router admits
 * and the server serves, but the navigation never shows — a dead end reachable
 * only by typing the URL. Head + /reports was exactly that. The inverse is
 * guarded too: a link shown to a role the server would 403.
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TEST_USER } from '../test/handlers'
import { renderWithProviders, seedSession } from '../test/utils'

import Sidebar from './Sidebar'

const renderAs = (role) => {
  seedSession({ user: { ...TEST_USER, role } })
  return renderWithProviders(<Sidebar isOpen={false} onClose={() => {}} />)
}

const link = (name) => screen.queryByRole('link', { name })

describe('Sidebar role visibility', () => {
  it('shows Reports to Head — the API serves Head-scoped reports and the route admits them', () => {
    renderAs('Head')
    expect(link('Reports')).toBeInTheDocument()
    // Admin-only surfaces stay hidden: the server 403s a Head on both.
    expect(link('Users & Approvals')).not.toBeInTheDocument()
    expect(link('Activity Log')).not.toBeInTheDocument()
    expect(link('Inbox')).toBeInTheDocument()
  })

  it('keeps Admin navigation complete', () => {
    renderAs('Admin')
    for (const name of [
      'Dashboard',
      'Inbox',
      'Tasks',
      'Clients',
      'Reports',
      'Users & Approvals',
      'Activity Log',
      'My Profile',
    ]) {
      expect(link(name)).toBeInTheDocument()
    }
  })

  it('never shows an Employee a link the server would reject', () => {
    renderAs('Employee')
    // GET /api/gmail/emails and /api/reports/* both 403 an Employee.
    expect(link('Inbox')).not.toBeInTheDocument()
    expect(link('Reports')).not.toBeInTheDocument()
    expect(link('Users & Approvals')).not.toBeInTheDocument()
    expect(link('Activity Log')).not.toBeInTheDocument()
    // What remains is fully served to Employees.
    for (const name of ['Dashboard', 'Tasks', 'Clients', 'My Profile']) {
      expect(link(name)).toBeInTheDocument()
    }
  })
})
