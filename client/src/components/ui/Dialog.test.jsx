/**
 * Dialog / Drawer / ConfirmDialog.
 *
 * These replaced hand-rolled `position: fixed` divs and `window.confirm()`.
 * The whole reason for taking the Radix dependency is the behaviour asserted
 * here — focus trap, ESC, focus restore, background hidden from AT — so if it
 * ever stops holding, the primitives are back to being decorative markup.
 *
 * `requireTyped` gets its own block: it is the last gate in front of "clear the
 * entire inbox", and a challenge that is not reset between opens, or that
 * accepts the wrong case, is not a gate.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { ConfirmDialog, ConfirmProvider, useConfirm } from './ConfirmDialog'
import { Dialog, DialogContent, DialogTrigger } from './Dialog'
import { Drawer, DrawerContent, DrawerTrigger } from './Drawer'

/* -------------------------------------------------------------------------- */
/* Dialog                                                                      */
/* -------------------------------------------------------------------------- */

function DialogHarness({ dismissable = true } = {}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Outside control
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button type="button">Open dialog</button>
        </DialogTrigger>
        <DialogContent title="Edit client" description="Change the client record." dismissable={dismissable}>
          <label htmlFor="client-name">Client name</label>
          <input id="client-name" />
          <button type="button">Save</button>
        </DialogContent>
      </Dialog>
    </>
  )
}

describe('Dialog', () => {
  it('exposes a dialog labelled by its title and described by its description', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAccessibleName('Edit client')
    expect(dialog).toHaveAccessibleDescription('Change the client record.')
  })

  it('hides the rest of the page from assistive tech while it is open', async () => {
    const user = userEvent.setup()
    const { container } = render(<DialogHarness />)

    expect(container).not.toHaveAttribute('aria-hidden')

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')

    /* Radix 1.1.x implements modality by marking every sibling of the portal
     * `aria-hidden`, NOT by putting `aria-modal` on the content — see the note
     * in docs/audits/IMPL-client-tests.md. This assertion tracks what the
     * library actually does, so it fails if modality silently disappears. */
    await waitFor(() => expect(container).toHaveAttribute('aria-hidden', 'true'))
  })

  it('moves focus into the dialog and traps Tab inside it', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    const dialog = await screen.findByRole('dialog')

    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))

    /* Tab all the way round: focus must never land on "Outside control". */
    for (let i = 0; i < 8; i += 1) {
      await user.tab()
      expect(dialog.contains(document.activeElement)).toBe(true)
    }
  })

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)

    const trigger = screen.getByRole('button', { name: 'Open dialog' })
    await user.click(trigger)
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes from the header close button', async () => {
    const user = userEvent.setup()
    render(<DialogHarness />)

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'Close dialog' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('dismissable={false} blocks Escape — for a dirty form', async () => {
    const user = userEvent.setup()
    render(<DialogHarness dismissable={false} />)

    await user.click(screen.getByRole('button', { name: 'Open dialog' }))
    await screen.findByRole('dialog')

    await user.keyboard('{Escape}')
    // Give the close animation a chance to have happened, then assert it did not.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})

/* -------------------------------------------------------------------------- */
/* Drawer                                                                      */
/* -------------------------------------------------------------------------- */

function DrawerHarness() {
  const [open, setOpen] = useState(false)
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        <button type="button">Open panel</button>
      </DrawerTrigger>
      <DrawerContent title="Re: GST filing" description="from accounts@example.com">
        <button type="button">Reply</button>
      </DrawerContent>
    </Drawer>
  )
}

describe('Drawer', () => {
  it('is a dialog with the same guarantees as Dialog', async () => {
    const user = userEvent.setup()
    render(<DrawerHarness />)

    const trigger = screen.getByRole('button', { name: 'Open panel' })
    await user.click(trigger)

    const drawer = await screen.findByRole('dialog')
    expect(drawer).toHaveAccessibleName('Re: GST filing')
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true))

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('closes from its labelled close button', async () => {
    const user = userEvent.setup()
    render(<DrawerHarness />)

    await user.click(screen.getByRole('button', { name: 'Open panel' }))
    await screen.findByRole('dialog')

    await user.click(screen.getByRole('button', { name: 'Close panel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

/* -------------------------------------------------------------------------- */
/* ConfirmDialog                                                               */
/* -------------------------------------------------------------------------- */

function ConfirmHarness({ requireTyped, onConfirm = () => {} }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Clear inbox
      </button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Clear the entire inbox?"
        description="All stored emails are deleted permanently."
        confirmLabel="Clear inbox"
        requireTyped={requireTyped}
        onConfirm={onConfirm}
      />
    </>
  )
}

describe('ConfirmDialog', () => {
  it('runs onConfirm and closes with no typed challenge', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmHarness onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')

    await user.click(within(dialog).getByRole('button', { name: 'Clear inbox' }))

    expect(onConfirm).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('Cancel closes without confirming', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmHarness onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(onConfirm).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('requireTyped: confirm stays disabled until the exact phrase is typed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Clear inbox' })
    const field = within(dialog).getByRole('textbox')

    expect(confirm).toBeDisabled()

    await user.type(field, 'DEL')
    expect(confirm).toBeDisabled()

    await user.type(field, 'ETE')
    expect(confirm).toBeEnabled()

    await user.click(confirm)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('requireTyped: the challenge is case-sensitive', async () => {
    const user = userEvent.setup()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')
    const confirm = within(dialog).getByRole('button', { name: 'Clear inbox' })

    await user.type(within(dialog).getByRole('textbox'), 'delete')
    expect(confirm).toBeDisabled()
  })

  it('requireTyped: surrounding whitespace is forgiven', async () => {
    const user = userEvent.setup()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')

    await user.type(within(dialog).getByRole('textbox'), '  DELETE  ')
    expect(within(dialog).getByRole('button', { name: 'Clear inbox' })).toBeEnabled()
  })

  it('requireTyped: the field is cleared between opens', async () => {
    const user = userEvent.setup()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} />)

    const open = screen.getByRole('button', { name: 'Clear inbox' })
    await user.click(open)
    let dialog = await screen.findByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), 'DELETE')
    expect(within(dialog).getByRole('button', { name: 'Clear inbox' })).toBeEnabled()

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

    /* Re-opening must NOT arrive pre-armed with the previous answer. */
    await user.click(open)
    dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('textbox')).toHaveValue('')
    expect(within(dialog).getByRole('button', { name: 'Clear inbox' })).toBeDisabled()
  })

  it('requireTyped: Enter in the field confirms only once armed', async () => {
    const user = userEvent.setup()
    const onConfirm = vi.fn()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} onConfirm={onConfirm} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')
    const field = within(dialog).getByRole('textbox')

    await user.type(field, 'nope{Enter}')
    expect(onConfirm).not.toHaveBeenCalled()

    await user.clear(field)
    await user.type(field, 'DELETE{Enter}')
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('labels the challenge field so it is reachable by its label', async () => {
    const user = userEvent.setup()
    render(<ConfirmHarness requireTyped={{ value: 'DELETE' }} />)

    await user.click(screen.getByRole('button', { name: 'Clear inbox' }))
    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByRole('textbox')).toHaveAccessibleName(/type\s+DELETE\s+to confirm/i)
  })
})

/* -------------------------------------------------------------------------- */
/* useConfirm — the imperative API                                             */
/* -------------------------------------------------------------------------- */

function ImperativeHarness({ onResult }) {
  const confirm = useConfirm()
  return (
    <button
      type="button"
      onClick={async () => {
        onResult(
          await confirm({
            title: 'Delete task?',
            confirmLabel: 'Delete task',
          })
        )
      }}
    >
      Delete
    </button>
  )
}

describe('useConfirm', () => {
  it('resolves true on confirm and false on cancel, reusing one mounted dialog', async () => {
    const user = userEvent.setup()
    const onResult = vi.fn()
    render(
      <ConfirmProvider>
        <ImperativeHarness onResult={onResult} />
      </ConfirmProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete task' }))
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true))

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false))
  })

  it('resolves false when the dialog is dismissed with Escape', async () => {
    const user = userEvent.setup()
    const onResult = vi.fn()
    render(
      <ConfirmProvider>
        <ImperativeHarness onResult={onResult} />
      </ConfirmProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Delete' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')

    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false))
  })

  it('throws a useful error outside <ConfirmProvider>', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<ImperativeHarness onResult={() => {}} />)).toThrow(
      /useConfirm\(\) must be used inside <ConfirmProvider>/
    )
  })
})
