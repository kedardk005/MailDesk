/**
 * AUDIT L-3 (client half) — the show/hide eye was on *Current password* only.
 *
 * Which is precisely backwards. The current password is the one the user
 * already knows and can retype; the new password and its confirmation are the
 * two that cannot be checked against anything, and a silent typo in either is
 * how someone locks themselves out of an account they just changed. All three
 * now carry a toggle, and each toggle moves only its own field — a single
 * shared flag would reveal the current password as a side effect of squinting
 * at the new one.
 *
 * The password *minimum* is the server's rule (`server/middleware/schemas.js`);
 * the client only mirrors it, from the single constant in
 * `src/lib/passwordPolicy.js`. The test reads that constant rather than a
 * literal so raising the floor is a one-line change with the suite still green,
 * and so this file can never be the thing that pins a stale number in place.
 */
import { screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import Profile from './Profile'
import { PASSWORD_MIN_LENGTH } from '../lib/passwordPolicy'
import { renderWithProviders, seedSession } from '../test/utils'

const FIELDS = [
  { label: /^current password/i, toggle: 'current password' },
  { label: /^new password/i, toggle: 'new password' },
  { label: /^confirm new password/i, toggle: 'confirm new password' },
]

async function renderSecurityTab() {
  seedSession()
  const view = renderWithProviders(<Profile />, { route: '/profile?tab=security' })
  await screen.findByRole('heading', { name: 'Change password' })
  return view
}

const inputFor = (label) => screen.getByLabelText(label)

describe('Profile — change password', () => {
  it('gives every password field its own show/hide toggle', async () => {
    await renderSecurityTab()

    for (const { label, toggle } of FIELDS) {
      expect(inputFor(label)).toHaveAttribute('type', 'password')
      expect(screen.getByRole('button', { name: `Show ${toggle}` })).toBeInTheDocument()
    }
  })

  it('reveals only the field whose toggle was pressed', async () => {
    const { user } = await renderSecurityTab()

    await user.click(screen.getByRole('button', { name: 'Show new password' }))

    expect(inputFor(/^new password/i)).toHaveAttribute('type', 'text')
    expect(inputFor(/^current password/i)).toHaveAttribute('type', 'password')
    expect(inputFor(/^confirm new password/i)).toHaveAttribute('type', 'password')

    /* The control reports its own state, and pressing it again re-hides. */
    const pressed = screen.getByRole('button', { name: 'Hide new password' })
    expect(pressed).toHaveAttribute('aria-pressed', 'true')
    await user.click(pressed)
    expect(inputFor(/^new password/i)).toHaveAttribute('type', 'password')
  })

  it('states the minimum length it will enforce, from the shared constant', async () => {
    await renderSecurityTab()

    expect(
      screen.getByText(`At least ${PASSWORD_MIN_LENGTH} characters.`)
    ).toBeInTheDocument()
  })

  it('refuses a password under the minimum with that same number', async () => {
    const { user } = await renderSecurityTab()

    const tooShort = 'a'.repeat(PASSWORD_MIN_LENGTH - 1)
    /* All three fields are `required`, so every one has to be filled before the
     * form's own JS validation is the thing doing the rejecting. */
    await user.type(inputFor(/^current password/i), 'whatever-current')
    await user.type(inputFor(/^new password/i), tooShort)
    await user.type(inputFor(/^confirm new password/i), tooShort)
    await user.click(screen.getByRole('button', { name: 'Update password' }))

    const card = screen.getByRole('heading', { name: 'Change password' }).closest('div.rounded-lg')
    expect(
      within(card).getByText(`Use at least ${PASSWORD_MIN_LENGTH} characters.`)
    ).toBeInTheDocument()
  })
})
