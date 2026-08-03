/* eslint-disable react-refresh/only-export-components --
 * This is a test helper module, not part of the app bundle: it deliberately
 * exports both a provider component and the helper functions that go with it,
 * and Fast Refresh never sees it. */
/**
 * Shared render helpers.
 *
 * Everything here exists so a test says what it is asserting and nothing else.
 * The provider stack is the REAL one from `App.jsx` (ThemeProvider →
 * AuthProvider → TooltipProvider → ConfirmProvider → Router) rather than a
 * hand-rolled stand-in, because the bug class these tests exist to catch —
 * a page that throws the moment a provider-supplied value is touched — is
 * invisible under a fake provider.
 *
 * Not a test file: the vitest `include` glob is `*.{test,spec}.{js,jsx}`.
 */
import { render } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import AuthProvider from '../components/AuthProvider'
import ErrorBoundary from '../components/ErrorBoundary'
import ThemeProvider from '../components/ThemeProvider'
import { ConfirmProvider } from '../components/ui/ConfirmDialog'
import { Toaster } from '../components/ui/Toaster'
import { TooltipProvider } from '../components/ui/Tooltip'
import { TEST_TOKEN, TEST_USER } from './handlers'

export { TEST_TOKEN, TEST_USER }

/**
 * Write a session into localStorage BEFORE rendering.
 *
 * `AuthProvider` seeds its state in a `useState` initialiser, so a session
 * written after mount is not seen until something emits an auth event. Call
 * this first, then render.
 */
export function seedSession({ user = TEST_USER, token = TEST_TOKEN } = {}) {
  if (token) window.localStorage.setItem('token', token)
  if (user) window.localStorage.setItem('user', JSON.stringify(user))
  return { user, token }
}

/** The App.jsx provider stack, with a MemoryRouter in place of BrowserRouter. */
export function AppProviders({ children, route = '/' }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <TooltipProvider>
          <ConfirmProvider>
            <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
            <Toaster />
          </ConfirmProvider>
        </TooltipProvider>
      </AuthProvider>
    </ThemeProvider>
  )
}

/**
 * @param {React.ReactElement} ui
 * @param {object} [options]
 * @param {string} [options.route='/'] initial MemoryRouter entry
 * @param {boolean} [options.errorBoundary=false] wrap `ui` in the real
 *        <ErrorBoundary> so a throw is observable instead of failing the render
 * @returns {import('@testing-library/react').RenderResult & { user: object }}
 */
export function renderWithProviders(ui, { route = '/', errorBoundary = false, ...options } = {}) {
  const wrapper = ({ children }) => (
    <AppProviders route={route}>
      {errorBoundary ? <ErrorBoundary compact>{children}</ErrorBoundary> : children}
    </AppProviders>
  )
  return { user: userEvent.setup(), ...render(ui, { wrapper, ...options }) }
}

/**
 * Capture console.error without letting it reach the terminal.
 *
 * React reports a caught render error, a bad prop type and an unkeyed list all
 * through console.error, so "the page logged nothing" is a genuine smoke
 * signal — the shipped TaskList crash logged before it blanked the screen.
 *
 * `restoreMocks: true` in vitest.config.js restores the spy after each test.
 */
export function captureConsoleErrors() {
  const calls = []
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    calls.push(args)
  })
  return {
    calls,
    /** Flattened, human-readable lines — what an assertion failure prints. */
    messages: () =>
      calls.map((args) =>
        args
          .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : String(a)))
          .join(' ')
      ),
  }
}

/**
 * The <ErrorBoundary> fallback heading, or null.
 *
 * Scope it to the render container, not `document.body`: when one `it.each`
 * case fails mid-assertion its DOM can outlive cleanup, and a body-wide query
 * then reports the previous case's failure against the next one.
 *
 * @param {HTMLElement} [root=document.body]
 */
export function errorFallback(root = document.body) {
  return root.querySelector('[role="alert"] h2')?.textContent ?? null
}
