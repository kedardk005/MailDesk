/**
 * ROUTE SMOKE TEST — the one that would have caught the shipped TaskList crash.
 *
 * What shipped: `TaskList.jsx` referenced `setSelectedTaskIds` / `setSelectAll`,
 * which no longer existed. ESLint reported six `no-undef` errors, nothing ran
 * them, there was no error boundary, and the page blanked on every filter click.
 * Initial render was FINE — the ReferenceError only fired on interaction. So
 * this file does two things for every route:
 *
 *   1. mounts the page inside the real provider stack with MSW answering the
 *      documented `{ data, pagination }` envelope, and
 *   2. INTERACTS with it — every tab, every segmented-control option, every
 *      native select, every sortable column header, and a safe allowlist of
 *      toolbar buttons — asserting after each step that nothing threw, the
 *      <ErrorBoundary> fallback never appeared, and console.error stayed silent.
 *
 * Adding a route is one line in ROUTES below.
 */
import { act, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { captureConsoleErrors, errorFallback, renderWithProviders, seedSession } from '../test/utils'

import ClientList from './ClientList'
import Dashboard from './Dashboard'
import EmailInbox from './EmailInbox'
import ForgotPassword from './ForgotPassword'
import Landing from './Landing'
import Login from './Login'
import Profile from './Profile'
import Register from './Register'
import TaskList from './TaskList'
import ActivityLog from './admin/ActivityLog'
import ManageUsers from './admin/ManageUsers'
import Reports from './admin/Reports'

/**
 * Every route App.jsx can render.
 *
 * `authed: false` marks the three screens that bounce a signed-in visitor with
 * <Navigate>, so they must be exercised signed OUT or they render nothing.
 */
const ROUTES = [
  { name: 'Landing', path: '/', Page: Landing, authed: false },
  { name: 'Login', path: '/login', Page: Login, authed: false },
  { name: 'Register', path: '/register', Page: Register, authed: false },
  { name: 'ForgotPassword', path: '/forgot-password', Page: ForgotPassword, authed: false },
  { name: 'ResetPassword', path: '/reset-password?token=abc123', Page: ForgotPassword, authed: false },
  { name: 'Dashboard', path: '/dashboard', Page: Dashboard, authed: true },
  { name: 'EmailInbox', path: '/inbox', Page: EmailInbox, authed: true },
  { name: 'TaskList', path: '/tasks', Page: TaskList, authed: true },
  { name: 'ClientList', path: '/clients', Page: ClientList, authed: true },
  { name: 'Profile', path: '/profile', Page: Profile, authed: true },
  { name: 'Reports', path: '/reports', Page: Reports, authed: true },
  { name: 'ManageUsers', path: '/admin/users', Page: ManageUsers, authed: true },
  { name: 'ActivityLog', path: '/admin/activities', Page: ActivityLog, authed: true },
]

/**
 * Buttons that are safe to press blind. Anything that mutates or navigates away
 * (Delete, Disconnect, Sign out, Save…) is deliberately excluded: this test is
 * looking for crashes in view state, not exercising destructive endpoints.
 */
const SAFE_BUTTON = /^(refresh|clear|reset|expand|collapse|previous|next|first|last|show|hide|sort|today|this)\b/i

/** Let effects, MSW responses and re-renders settle. */
async function settle(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}

function assertHealthy(label, console_, container) {
  /* console.error first: <ErrorBoundary> logs the thrown error through it, so
   * this assertion is the one that prints a usable stack. */
  expect(console_.messages(), `${label}: console.error was called`).toEqual([])
  expect(errorFallback(container), `${label}: <ErrorBoundary> fallback rendered`).toBeNull()
}

const nameOf = (el) => (el?.getAttribute('aria-label') || el?.textContent || '').trim()

/**
 * Click / change every non-destructive control on screen.
 *
 * Two rules make this useful rather than decorative:
 *   - the DOM is re-read before every step, because a click re-renders it;
 *   - each group RESTORES the control it started on. Cycling TaskList's view
 *     switcher and stopping on "Calendar" would unmount the table and silently
 *     skip every sort and pagination control below.
 */
async function exercise(user, console_, label, container) {
  const scope = within(container)
  const ok = (step) => assertHealthy(`${label}: ${step}`, console_, container)

  /** Click one element, let it settle, assert. */
  const press = async (el, step) => {
    await user.click(el)
    await settle(1)
    ok(step)
  }

  /**
   * Visit every option of a roving control, then return to the one that was
   * active on arrival.
   * @param {'tab'|'radio'} role
   * @param {string} activeAttr
   */
  const cycle = async (role, activeAttr, verb) => {
    const all = scope.queryAllByRole(role)
    const startIndex = all.findIndex((el) => el.getAttribute(activeAttr) === 'true')
    for (let i = 0; i < all.length; i += 1) {
      const el = scope.queryAllByRole(role)[i]
      if (!el || el.disabled || el.getAttribute(activeAttr) === 'true') continue
      await press(el, `after ${verb} "${nameOf(el)}"`)
    }
    if (startIndex >= 0) {
      const back = scope.queryAllByRole(role)[startIndex]
      if (back && back.getAttribute(activeAttr) !== 'true') {
        await press(back, `after returning to "${nameOf(back)}"`)
      }
    }
  }

  await cycle('tab', 'aria-selected', 'clicking tab')
  await cycle('radio', 'aria-checked', 'switching view to')

  /* Native <select> filters — the exact control class the TaskList crash fired
   * on. Restore the original value so the rows come back for the steps below. */
  for (const select of Array.from(container.querySelectorAll('select:not([disabled])'))) {
    const original = select.value
    const other = Array.from(select.options).find((o) => !o.disabled && o.value !== original)
    if (!other) continue
    await user.selectOptions(select, other.value)
    await settle(1)
    ok(`after filtering "${select.getAttribute('aria-label') || select.id}"`)
    if (container.contains(select) && select.value !== original) {
      await user.selectOptions(select, original)
      await settle(1)
    }
  }

  /* Radix <SelectMenu> triggers (role=combobox but not a <select>): open the
   * portal, then close it. Rendering the menu is the part that can throw. */
  for (let i = 0; i < scope.queryAllByRole('combobox').length; i += 1) {
    const trigger = scope.queryAllByRole('combobox')[i]
    if (!trigger || trigger.tagName === 'SELECT' || trigger.disabled) continue
    await press(trigger, `after opening the "${nameOf(trigger)}" menu`)
    await user.keyboard('{Escape}')
    await settle(1)
    ok(`after closing the "${nameOf(trigger)}" menu`)
  }

  /* Sortable column headers. */
  for (let i = 0; i < scope.queryAllByRole('columnheader').length; i += 1) {
    const header = scope.queryAllByRole('columnheader')[i]
    const button = header ? within(header).queryByRole('button') : null
    if (!button) continue
    await press(button, `after sorting by "${nameOf(header)}"`)
  }

  /* Non-destructive toolbar buttons, each pressed at most once. */
  const seen = new Set()
  for (let round = 0; round < 16; round += 1) {
    const button = scope
      .queryAllByRole('button')
      .find((b) => !b.disabled && SAFE_BUTTON.test(nameOf(b)) && !seen.has(nameOf(b)))
    if (!button) break
    const name = nameOf(button)
    seen.add(name)
    await press(button, `after pressing "${name}"`)
  }
}

describe('every route mounts and survives interaction', () => {
  beforeEach(() => {
    /* Not a real JWT — nothing in the client decodes it, the server is MSW. */
    seedSession()
  })

  it.each(ROUTES)('$name renders without throwing', async ({ name, path, Page, authed }) => {
    if (!authed) window.localStorage.clear()
    const console_ = captureConsoleErrors()

    const { container } = renderWithProviders(<Page />, { route: path, errorBoundary: true })
    await settle()

    assertHealthy(`${name}: initial render`, console_, container)
    /* A blank page passes "did not throw" — require real content. */
    expect(container.textContent.trim().length, `${name} rendered nothing`).toBeGreaterThan(0)
  })

  it.each(ROUTES)('$name survives clicking its filters, tabs and view switchers', async ({
    name,
    path,
    Page,
    authed,
  }) => {
    if (!authed) window.localStorage.clear()
    const console_ = captureConsoleErrors()

    const { user, container } = renderWithProviders(<Page />, { route: path, errorBoundary: true })
    await settle()
    assertHealthy(`${name}: initial render`, console_, container)

    await exercise(user, console_, name, container)

    assertHealthy(`${name}: after interaction`, console_, container)
  })
})
