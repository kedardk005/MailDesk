/**
 * The three unauthenticated screens, driven through MSW.
 *
 * Each block guards a behaviour that was wrong before the hardening pass:
 *
 *  - Login: `middleware/validate.js` used to answer every validation failure
 *    with a 500, so the form had nothing per-field to render. It now returns
 *    400 `{ errors: [{ path, message }] }` and the page must show them inline.
 *  - Register: registration used to mint a JWT for a non-approved account and
 *    sign the user straight in, which made Admin approval decorative. A 201
 *    WITHOUT a token must land on "awaiting approval" and store no session.
 *  - ForgotPassword: it used to overwrite the password immediately, so anyone
 *    who knew a colleague's address could lock them out. It is now a two-step
 *    token flow, and `?token=` must render the redeem form.
 *
 * Queries are by role and label only, so a page refactor that keeps the
 * behaviour keeps these passing.
 */
import { screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { API, TEST_TOKEN, TEST_USER } from '../test/handlers'
import { server } from '../test/server'
import { renderWithProviders } from '../test/utils'

import ForgotPassword from './ForgotPassword'
import Login from './Login'
import Register from './Register'

/** A router with a landing target, so a redirect is observable. */
function withRoutes(path, element) {
  return (
    <Routes>
      <Route path={path} element={element} />
      <Route path="/dashboard" element={<h1>Dashboard screen</h1>} />
      <Route path="/tasks" element={<h1>Tasks screen</h1>} />
      <Route path="/login" element={<h1>Sign-in screen</h1>} />
    </Routes>
  )
}

const validationError = (errors) =>
  HttpResponse.json({ message: 'Validation failed', errors }, { status: 400 })

/* -------------------------------------------------------------------------- */
/* Login                                                                       */
/* -------------------------------------------------------------------------- */

describe('Login', () => {
  const renderLogin = (route = '/login') =>
    renderWithProviders(withRoutes('/login', <Login />), { route })

  it('signs in, stores the session and lands on the dashboard', async () => {
    const { user } = renderLogin()

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Dashboard screen' })).toBeInTheDocument()
    expect(window.localStorage.getItem('token')).toBe(TEST_TOKEN)
    expect(JSON.parse(window.localStorage.getItem('user'))).toMatchObject({ email: TEST_USER.email })
  })

  it('sends the trimmed email and the raw password', async () => {
    let body = null
    server.use(
      http.post(`${API}/auth/login`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ token: TEST_TOKEN, user: TEST_USER })
      })
    )
    const { user } = renderLogin()

    await user.type(screen.getByLabelText(/^Email address/), '  asha@example.com  ')
    await user.type(screen.getByLabelText(/^Password/), ' spaces matter ')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    await waitFor(() => expect(body).not.toBeNull())
    expect(body).toEqual({ email: 'asha@example.com', password: ' spaces matter ' })
  })

  it('turns a 400 { errors: [{ path, message }] } into inline field messages', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        validationError([
          { path: 'email', message: 'That is not a valid work address.' },
          { path: 'password', message: 'Password must be at least 8 characters.' },
        ])
      )
    )
    const { user } = renderLogin()

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'short')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('That is not a valid work address.')).toBeInTheDocument()
    expect(screen.getByText('Password must be at least 8 characters.')).toBeInTheDocument()

    // Field-specific messages are announced, and the summary banner stays away.
    expect(screen.getByLabelText(/^Email address/)).toHaveAttribute('aria-invalid', 'true')
    expect(screen.queryByText('Sign-in failed')).toBeNull()
  })

  it('falls back to a summary banner when the failure is not field-specific', async () => {
    server.use(
      http.post(`${API}/auth/login`, () =>
        HttpResponse.json({ message: 'Your account is awaiting approval.' }, { status: 403 })
      )
    )
    const { user } = renderLogin()

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    /* Scoped to the in-form banner: the axios 403 handler ALSO raises a toast,
     * so the same sentence is on screen twice and a bare findByText is
     * ambiguous. (That duplication is noted in docs/audits/IMPL-client-tests.md.) */
    const banner = await screen.findByText('Sign-in failed')
    expect(banner.parentElement).toHaveTextContent('Your account is awaiting approval.')
    expect(window.localStorage.getItem('token')).toBeNull()
  })

  it('validates locally before sending anything', async () => {
    let called = false
    server.use(
      http.post(`${API}/auth/login`, () => {
        called = true
        return HttpResponse.json({ token: TEST_TOKEN, user: TEST_USER })
      })
    )
    const { user } = renderLogin()

    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('Enter your work email address.')).toBeInTheDocument()
    expect(screen.getByText('Enter your password.')).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('returns the user to ?next= after signing in', async () => {
    const { user } = renderLogin('/login?next=%2Ftasks')

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Tasks screen' })).toBeInTheDocument()
  })

  it('refuses a protocol-relative ?next= — that is an open redirect', async () => {
    const { user } = renderLogin('/login?next=%2F%2Fevil.example.com')

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.type(screen.getByLabelText(/^Password/), 'correct-horse')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Dashboard screen' })).toBeInTheDocument()
  })

  it('toggles password visibility without losing the value', async () => {
    const { user } = renderLogin()
    const password = screen.getByLabelText(/^Password/)

    await user.type(password, 'correct-horse')
    expect(password).toHaveAttribute('type', 'password')

    await user.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(password).toHaveValue('correct-horse')

    await user.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
  })
})

/* -------------------------------------------------------------------------- */
/* Register                                                                    */
/* -------------------------------------------------------------------------- */

describe('Register', () => {
  const renderRegister = () => renderWithProviders(withRoutes('/register', <Register />), { route: '/register' })

  const fillForm = async (user, overrides = {}) => {
    const values = {
      name: 'Asha Rao',
      email: 'asha@example.com',
      password: 'correct-horse',
      confirm: 'correct-horse',
      ...overrides,
    }
    await user.type(screen.getByLabelText(/^Full name/), values.name)
    await user.type(screen.getByLabelText(/^Email address/), values.email)
    await user.type(screen.getByLabelText(/^Password/), values.password)
    await user.type(screen.getByLabelText(/^Confirm password/), values.confirm)
  }

  it('a 201 WITHOUT a token lands on "awaiting approval" and stores no session', async () => {
    const { user } = renderRegister()

    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit request' }))

    expect(await screen.findByRole('heading', { name: 'Request submitted' })).toBeInTheDocument()
    expect(screen.getByText('Awaiting administrator approval')).toBeInTheDocument()
    expect(screen.getByText('asha@example.com')).toBeInTheDocument()

    // The whole point: approval is a real gate.
    expect(window.localStorage.getItem('token')).toBeNull()
    expect(window.localStorage.getItem('user')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Dashboard screen' })).toBeNull()
  })

  it('shows the approval message the server sent, when it sends one', async () => {
    server.use(
      http.post(`${API}/auth/register`, () =>
        HttpResponse.json(
          { message: 'Thanks — the office manager will approve you.', user: TEST_USER },
          { status: 201 }
        )
      )
    )
    const { user } = renderRegister()

    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit request' }))

    expect(
      await screen.findByText('Thanks — the office manager will approve you.')
    ).toBeInTheDocument()
  })

  it('signs in immediately only when the server does return a token', async () => {
    server.use(
      http.post(`${API}/auth/register`, () =>
        HttpResponse.json({ token: TEST_TOKEN, user: TEST_USER }, { status: 201 })
      )
    )
    const { user } = renderRegister()

    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit request' }))

    expect(await screen.findByRole('heading', { name: 'Dashboard screen' })).toBeInTheDocument()
    expect(window.localStorage.getItem('token')).toBe(TEST_TOKEN)
  })

  it('blocks a mismatched confirmation before sending anything', async () => {
    let called = false
    server.use(
      http.post(`${API}/auth/register`, () => {
        called = true
        return HttpResponse.json({}, { status: 201 })
      })
    )
    const { user } = renderRegister()

    await fillForm(user, { confirm: 'something-else' })
    await user.click(screen.getByRole('button', { name: 'Submit request' }))

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('renders server field errors inline', async () => {
    server.use(
      http.post(`${API}/auth/register`, () =>
        validationError([{ path: 'email', message: 'That address is already registered.' }])
      )
    )
    const { user } = renderRegister()

    await fillForm(user)
    await user.click(screen.getByRole('button', { name: 'Submit request' }))

    expect(await screen.findByText('That address is already registered.')).toBeInTheDocument()
    expect(screen.getByLabelText(/^Email address/)).toHaveAttribute('aria-invalid', 'true')
  })
})

/* -------------------------------------------------------------------------- */
/* ForgotPassword / reset                                                      */
/* -------------------------------------------------------------------------- */

describe('ForgotPassword — request step', () => {
  const renderRequest = () =>
    renderWithProviders(withRoutes('/forgot-password', <ForgotPassword />), {
      route: '/forgot-password',
    })

  it('sends the address and confirms without confirming the account exists', async () => {
    let body = null
    server.use(
      http.post(`${API}/auth/forgot-password`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          message: 'If an account with this email exists, a link has been sent.',
        })
      })
    )
    const { user } = renderRequest()

    await user.type(screen.getByLabelText(/^Email address/), 'asha@example.com')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByRole('heading', { name: 'Check your email' })).toBeInTheDocument()
    expect(body).toEqual({ email: 'asha@example.com' })
    // Enumeration-safe wording: no "we found your account".
    expect(screen.getByText(/if an account with this email exists/i)).toBeInTheDocument()
  })

  it('rejects a malformed address locally', async () => {
    const { user } = renderRequest()

    await user.type(screen.getByLabelText(/^Email address/), 'not-an-email')
    await user.click(screen.getByRole('button', { name: 'Send reset link' }))

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument()
  })
})

describe('ForgotPassword — reset step (?token=)', () => {
  const renderReset = (token = 'reset-token-123') =>
    renderWithProviders(withRoutes('/reset-password', <ForgotPassword />), {
      route: `/reset-password?token=${token}`,
    })

  it('renders the redeem form, not the request form, when a token is present', async () => {
    renderReset()
    expect(
      await screen.findByRole('heading', { name: 'Choose a new password' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send reset link' })).toBeNull()
  })

  it('posts the token and the new password to /auth/reset-password', async () => {
    let body = null
    server.use(
      http.post(`${API}/auth/reset-password`, async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ message: 'Password reset successfully.' })
      })
    )
    const { user } = renderReset('token-abc')

    await user.type(screen.getByLabelText(/^New password/), 'a-brand-new-one')
    await user.type(screen.getByLabelText(/^Confirm new password/), 'a-brand-new-one')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByRole('heading', { name: 'Password updated' })).toBeInTheDocument()
    expect(body).toEqual({ token: 'token-abc', password: 'a-brand-new-one' })
  })

  it('reports an expired link at form level — there is no visible token field', async () => {
    server.use(
      http.post(`${API}/auth/reset-password`, () =>
        validationError([{ path: 'token', message: 'This link has expired.' }])
      )
    )
    const { user } = renderReset()

    await user.type(screen.getByLabelText(/^New password/), 'a-brand-new-one')
    await user.type(screen.getByLabelText(/^Confirm new password/), 'a-brand-new-one')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('This link has expired.')).toBeInTheDocument()
    // …and offers a way out.
    expect(screen.getByRole('link', { name: 'New link' })).toBeInTheDocument()
  })

  it('blocks a mismatched confirmation before sending anything', async () => {
    let called = false
    server.use(
      http.post(`${API}/auth/reset-password`, () => {
        called = true
        return HttpResponse.json({})
      })
    )
    const { user } = renderReset()

    await user.type(screen.getByLabelText(/^New password/), 'a-brand-new-one')
    await user.type(screen.getByLabelText(/^Confirm new password/), 'different')
    await user.click(screen.getByRole('button', { name: 'Set new password' }))

    expect(await screen.findByText('Passwords do not match.')).toBeInTheDocument()
    expect(called).toBe(false)
  })
})
