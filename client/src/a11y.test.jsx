/**
 * Accessibility regression guard (jest-axe).
 *
 * PROJECT_AUDIT found the pre-rebuild client shipping ONE `aria-label` in the
 * whole app and 64 of 70 form labels with no association to their control. The
 * rebuild fixed that by construction — `FormField` generates the id and wires
 * `for` / `aria-describedby` / `aria-invalid`, `DataTable` requires an
 * `ariaLabel`, `Pagination` generates a unique select id. These tests are what
 * stops it drifting back.
 *
 * `color-contrast` is off everywhere: jsdom has no layout or computed colour, so
 * axe cannot evaluate it and reports nothing useful either way. Contrast is a
 * design-token concern, checked in the design system, not here.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { axe } from 'jest-axe'
import { useState } from 'react'
import { http, HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'

import ClientList from './pages/ClientList'
import Login from './pages/Login'
import NotificationBell from './components/NotificationBell'
import { Button } from './components/ui/Button'
import { DataTable } from './components/ui/DataTable'
import { Dialog, DialogContent } from './components/ui/Dialog'
import { FormField } from './components/ui/FormField'
import { Input } from './components/ui/Input'
import { Select } from './components/ui/Select'
import { Textarea } from './components/ui/Textarea'
import { API, listResponse } from './test/handlers'
import { renderWithProviders, seedSession } from './test/utils'
import { server } from './test/server'

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } }

const check = async (element, extraRules = {}) => {
  expect(
    await axe(element, { rules: { ...AXE_OPTIONS.rules, ...extraRules } })
  ).toHaveNoViolations()
}

describe('a11y — Login', () => {
  it('has no axe violations', async () => {
    const { container } = renderWithProviders(<Login />, { route: '/login' })
    await screen.findByRole('heading', { name: 'Sign in' })
    await check(container)
  })

  it('has no axe violations while showing per-field errors', async () => {
    const user = userEvent.setup()
    const { container } = renderWithProviders(<Login />, { route: '/login' })

    // Submitting empty puts both fields into the invalid state.
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    await screen.findByText('Enter your work email address.')

    await check(container)
  })

  it('associates every input with its visible label', () => {
    renderWithProviders(<Login />, { route: '/login' })
    /* Anchored: `Label` appends an aria-hidden "*" for required fields, and an
     * unanchored /password/i would also match the "Show password" toggle. */
    expect(screen.getByLabelText(/^Email address/)).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute('type', 'password')
  })
})

describe('a11y — a page rendering a DataTable', () => {
  it('ClientList has no axe violations with rows on screen', async () => {
    seedSession()
    server.use(
      http.get(`${API}/clients`, () =>
        HttpResponse.json(
          listResponse(
            [
              { _id: 'c1', name: 'Acme Exports', email: 'ops@acme.test', phone: '9999999999' },
              { _id: 'c2', name: 'Meridian Foods', email: 'hi@meridian.test', phone: '8888888888' },
            ],
            { total: 2 }
          )
        )
      )
    )

    const { container } = renderWithProviders(<ClientList />, { route: '/clients' })
    await screen.findByText('Acme Exports')

    /* `empty-table-header` was suppressed here while the actions column was
     * declared with `header: ''`. Both ClientList and ManageUsers now use the
     * sr-only "Actions" header that EmailInbox and TaskList always had, so the
     * rule runs with everything else. */
    await check(container)
  })

  it('a bare DataTable with selection, sorting and pagination has no violations', async () => {
    const { container } = render(
      <main>
        <DataTable
          ariaLabel="Clients"
          data={[
            { id: 'r1', name: 'Acme Exports', open: 3 },
            { id: 'r2', name: 'Meridian Foods', open: 7 },
          ]}
          columns={[
            { id: 'name', accessorKey: 'name', header: 'Client', meta: { primary: true } },
            { id: 'open', accessorKey: 'open', header: 'Open', meta: { numeric: true } },
          ]}
          enableSelection
          getRowId={(r) => r.id}
          rowSelection={{ r1: true }}
          onRowSelectionChange={() => {}}
          sorting={[{ id: 'name', desc: false }]}
          onSortingChange={() => {}}
          pagination={{
            page: 1,
            pageSize: 25,
            total: 60,
            onPageChange: () => {},
            onPageSizeChange: () => {},
          }}
        />
      </main>
    )

    await check(container)
  })

  it('two tables on one screen do not produce duplicate ids', async () => {
    const columns = [{ id: 'name', accessorKey: 'name', header: 'Name' }]
    const pagination = {
      page: 1,
      pageSize: 25,
      total: 60,
      onPageChange: () => {},
      onPageSizeChange: () => {},
    }
    const { container } = render(
      <main>
        <DataTable ariaLabel="Clients" data={[{ name: 'A' }]} columns={columns} pagination={pagination} />
        <DataTable ariaLabel="Vendors" data={[{ name: 'B' }]} columns={columns} pagination={pagination} />
      </main>
    )

    // axe's duplicate-id-active / duplicate-id-aria rules cover this directly.
    await check(container)
  })
})

describe('a11y — an open Dialog', () => {
  function DialogHarness() {
    const [open, setOpen] = useState(false)
    return (
      <main>
        <Button onClick={() => setOpen(true)}>Edit client</Button>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            title="Edit client"
            description="Update the client record."
            footer={
              <>
                <Button variant="secondary">Cancel</Button>
                <Button variant="primary">Save</Button>
              </>
            }
          >
            <FormField label="Client name" required>
              {(field) => <Input {...field} defaultValue="Acme Exports" />}
            </FormField>
          </DialogContent>
        </Dialog>
      </main>
    )
  }

  it('has no axe violations while open', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)

    await user.click(screen.getByRole('button', { name: 'Edit client' }))
    const dialog = await screen.findByRole('dialog')
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    // The dialog is portalled outside the render container.
    await check(document.body)
  })
})

describe('a11y — the notification centre', () => {
  const ROWS = [
    {
      _id: 'n1',
      type: 'task_assigned',
      message: 'New task assigned: Q3 GST filing',
      taskId: 't1',
      read: false,
      createdAt: new Date().toISOString(),
    },
    {
      _id: 'n2',
      type: 'task_overdue',
      message: 'Task overdue: Renew trade licence',
      taskId: 't2',
      read: true,
      createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    },
  ]

  it('has no violations with the popover open, and does not take focus on mount', async () => {
    seedSession()
    server.use(
      http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ count: 1 })),
      http.get(`${API}/notifications`, () => HttpResponse.json(listResponse(ROWS, { total: 2 })))
    )

    const { user } = renderWithProviders(
      <main>
        <NotificationBell />
      </main>
    )

    const trigger = await screen.findByRole('button', { name: 'Notifications, 1 unread' })
    // A live arrival must never steal focus from whatever the user is doing.
    expect(document.body).toHaveFocus()

    await user.click(trigger)
    await screen.findByRole('heading', { name: 'Notifications' })

    // Portalled outside the render container, like the Dialog above.
    await check(document.body)
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    seedSession()
    server.use(
      http.get(`${API}/notifications/unread-count`, () => HttpResponse.json({ count: 0 })),
      http.get(`${API}/notifications`, () => HttpResponse.json(listResponse(ROWS, { total: 2 })))
    )

    const { user } = renderWithProviders(<NotificationBell />)
    const trigger = await screen.findByRole('button', { name: 'Notifications, none unread' })

    await user.click(trigger)
    await screen.findByRole('heading', { name: 'Notifications' })

    await user.keyboard('{Escape}')

    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Notifications' })).not.toBeInTheDocument()
    )
    expect(trigger).toHaveFocus()
  })
})

describe('a11y — a FormField form', () => {
  it('a form of every control type has no violations, error state included', async () => {
    const { container } = render(
      <main>
        <form aria-label="New task">
          <FormField label="Title" required hint="Shown in the task list.">
            {(field) => <Input {...field} defaultValue="Q3 GST filing" />}
          </FormField>

          <FormField label="Client" error="Choose a client.">
            {(field) => (
              <Select
                {...field}
                placeholder="Select a client"
                options={[{ value: 'acme', label: 'Acme Exports' }]}
              />
            )}
          </FormField>

          <FormField label="Notes" hint="Optional.">
            {(field) => <Textarea {...field} />}
          </FormField>

          <Button type="submit" variant="primary">
            Create task
          </Button>
        </form>
      </main>
    )

    await check(container)
  })

  it('wires the error message and the hint through aria-describedby', () => {
    render(
      <FormField label="Client" error="Choose a client." hint="Ignored while erroring.">
        {(field) => <Input {...field} />}
      </FormField>
    )

    const input = screen.getByLabelText('Client')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Choose a client.')
    expect(screen.getByRole('alert')).toHaveTextContent('Choose a client.')
  })

  it('describes the control with the hint when there is no error', () => {
    render(
      <FormField label="Title" hint="Shown in the task list.">
        {(field) => <Input {...field} />}
      </FormField>
    )

    expect(screen.getByLabelText('Title')).toHaveAccessibleDescription('Shown in the task list.')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('generates a unique id per field so two forms can coexist', () => {
    render(
      <>
        <FormField label="Title">{(field) => <Input {...field} />}</FormField>
        <FormField label="Title">{(field) => <Input {...field} />}</FormField>
      </>
    )

    const [a, b] = screen.getAllByLabelText('Title')
    expect(a.id).toBeTruthy()
    expect(a.id).not.toBe(b.id)
  })
})
