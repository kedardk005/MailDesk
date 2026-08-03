/**
 * Combobox — the async, server-searched picker.
 *
 * The load-bearing behaviours, in order of what breaks worst:
 *
 *  1. Last QUERY wins. A superseded request is aborted, and even a late
 *     response that somehow lands can never overwrite a newer one. Without
 *     this, a slow search for "a" repaints the list after the user has
 *     already narrowed to "ab".
 *  2. Selection semantics — keyboard and click both deliver the option object.
 *  3. The explicit create path — free text survives, but only through a
 *     visible "Create …" row, never by silently accepting arbitrary input.
 *  4. Empty vs loading vs failed are three different screens.
 *  5. Escape closes the picker WITHOUT closing the Dialog it sits in.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { Combobox } from './Combobox'
import { Dialog, DialogContent } from './Dialog'

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** loadOptions stub that records every call and lets the test settle each. */
function makeSource() {
  const calls = []
  const loadOptions = vi.fn(({ q, signal }) => {
    const d = deferred()
    calls.push({ q, signal, ...d })
    return d.promise
  })
  return { calls, loadOptions }
}

const opt = (label, value = label.toLowerCase(), description) => ({ value, label, description })

function renderPicker(props = {}) {
  const onChange = vi.fn()
  const utils = render(
    <Combobox
      aria-label="Client"
      debounceMs={0}
      value={null}
      onChange={onChange}
      {...props}
    />
  )
  return { onChange, ...utils }
}

const trigger = () => screen.getByRole('combobox', { name: 'Client' })
const searchInput = () => screen.getByPlaceholderText('Type to search…')

describe('Combobox', () => {
  it('opens, searches the source, and renders two-line options', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    renderPicker({ loadOptions })

    /* Hold the element: while the (modal) picker is open, Radix aria-hides
       everything outside the portal, so a role query would no longer see it. */
    const button = trigger()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    await user.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')

    // Opening fires the initial, empty-query request.
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].q).toBe('')
    calls[0].resolve({
      options: [opt('Acme & Co', 'acme', 'billing@acme.test'), opt('Bharat Traders', 'bt')],
      total: 2,
    })

    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getByText('Acme & Co')).toBeInTheDocument()
    // Second line renders alongside the first.
    expect(within(listbox).getByText('billing@acme.test')).toBeInTheDocument()

    // Typing is debounced into a new query. (Paste: one change, one request.)
    await user.click(searchInput())
    await user.paste('bha')
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].q).toBe('bha')
  })

  it('is last-QUERY-wins: superseded requests are aborted and a late stale response never lands', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    renderPicker({ loadOptions })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].resolve({ options: [opt('Everything')], total: 1 })
    await screen.findByText('Everything')

    await user.type(searchInput(), 'a')
    await waitFor(() => expect(calls).toHaveLength(2))
    await user.type(searchInput(), 'b')
    await waitFor(() => expect(calls).toHaveLength(3))

    // The "a" request was aborted the moment "ab" superseded it.
    expect(calls[1].signal.aborted).toBe(true)
    expect(calls[2].signal.aborted).toBe(false)

    // The newer response lands…
    calls[2].resolve({ options: [opt('AB Industries')], total: 1 })
    await screen.findByText('AB Industries')

    // …and the SLOW EARLIER response arriving after it changes nothing.
    calls[1].resolve({ options: [opt('Stale A Result')], total: 1 })
    await waitFor(() => expect(screen.queryByText('Stale A Result')).not.toBeInTheDocument())
    expect(screen.getByText('AB Industries')).toBeInTheDocument()
  })

  it('selects with ArrowDown + Enter and closes', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    const { onChange } = renderPicker({ loadOptions })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))
    const first = opt('First Client', 'c1')
    const second = opt('Second Client', 'c2')
    calls[0].resolve({ options: [first, second], total: 2 })
    await screen.findByText('First Client')

    await user.keyboard('{ArrowDown}{Enter}')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(second)
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
  })

  it('offers an explicit "Create" row for unmatched text, but not for an exact match', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    const { onChange } = renderPicker({ loadOptions, allowCreate: true })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].resolve({ options: [opt('Acme')], total: 1 })
    await screen.findByText('Acme')

    await user.click(searchInput())
    await user.paste('New Client Ltd')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].resolve({ options: [], total: 0 })

    const createRow = await screen.findByText(/Create/)
    expect(createRow).toBeInTheDocument()
    await user.click(screen.getByText('New Client Ltd', { selector: 'span' }))
    expect(onChange).toHaveBeenCalledWith({
      value: 'New Client Ltd',
      label: 'New Client Ltd',
      isNew: true,
    })

    // Reopen and type an EXACT existing label: no create row.
    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(3))
    calls[2].resolve({ options: [opt('Acme')], total: 1 })
    await screen.findByText('Acme')
    await user.click(searchInput())
    await user.paste('acme')
    await waitFor(() => expect(calls).toHaveLength(4))
    calls[3].resolve({ options: [opt('Acme')], total: 1 })
    await waitFor(() => expect(screen.queryByText(/^Create/)).not.toBeInTheDocument())
  })

  it('keeps a usable highlight when async results replace the rows, so Enter picks the create row', async () => {
    // Regression: cmdk drops its highlight when the highlighted row unmounts
    // with the async result swap; without re-pointing it, Enter did nothing.
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    const { onChange } = renderPicker({ loadOptions, allowCreate: true })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].resolve({ options: [opt('Apex'), opt('Bharat Traders')], total: 2 })
    await screen.findByText('Apex')

    await user.click(searchInput())
    await user.paste('Zenith Verification Co')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].resolve({ options: [], total: 0 })
    await screen.findByText(/Create/)

    await user.keyboard('{Enter}')
    expect(onChange).toHaveBeenCalledWith({
      value: 'Zenith Verification Co',
      label: 'Zenith Verification Co',
      isNew: true,
    })
  })

  it('distinguishes searching, no matches, and failure — and Retry recovers', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    renderPicker({ loadOptions })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))

    // Still searching: the pending state, not "no matches". (Scoped to the
    // listbox — the sr-only live region announces the same words.)
    expect(within(screen.getByRole('listbox')).getByText('Searching…')).toBeInTheDocument()
    expect(screen.queryByText(/No matches/)).not.toBeInTheDocument()

    // Empty result: "no matches", not an error.
    calls[0].resolve({ options: [], total: 0 })
    await screen.findByText('No matches.')
    expect(screen.queryByText('Could not load matches.')).not.toBeInTheDocument()

    // A failed search says so and offers a retry.
    await user.type(searchInput(), 'x')
    await waitFor(() => expect(calls).toHaveLength(2))
    calls[1].reject(new Error('boom'))
    await screen.findByText('Could not load matches.')

    await user.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(calls).toHaveLength(3))
    calls[2].resolve({ options: [opt('X Ray Corp')], total: 1 })
    await screen.findByText('X Ray Corp')
    expect(screen.queryByText('Could not load matches.')).not.toBeInTheDocument()
  })

  it('announces a capped result set instead of silently truncating', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    renderPicker({ loadOptions })

    await user.click(trigger())
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].resolve({ options: [opt('One'), opt('Two')], total: 41 })

    await screen.findByText('One')
    expect(screen.getByText(/Showing first 2 of 41/)).toBeInTheDocument()
    expect(screen.getByText(/keep typing to narrow/)).toBeInTheDocument()
  })

  it('inside a Dialog: opens above it, and Escape closes only the picker', async () => {
    const user = userEvent.setup()
    const { calls, loadOptions } = makeSource()
    const onDialogChange = vi.fn()

    render(
      <Dialog open onOpenChange={onDialogChange}>
        <DialogContent title="New task">
          <Combobox
        aria-label="Client"
        debounceMs={0}
        value={null}
        onChange={vi.fn()}
        loadOptions={loadOptions}
          />
        </DialogContent>
      </Dialog>
    )

    await user.click(screen.getByRole('combobox', { name: 'Client' }))
    await waitFor(() => expect(calls).toHaveLength(1))
    calls[0].resolve({ options: [opt('Acme')], total: 1 })
    await screen.findByRole('listbox')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
    // The dialog under it did NOT dismiss.
    expect(onDialogChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByRole('heading', { name: 'New task' })).toBeInTheDocument()
  })
})
