import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { CheckCircle2, Eye, EyeOff, Mail } from 'lucide-react'

import api, { getErrorMessage } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import { Alert, Button, FormField, Input } from '../components/ui'
import { PASSWORD_HINT, PASSWORD_TOO_SHORT, isLongEnough } from '../lib/passwordPolicy'

/** Map the server's 400 `{ errors: [{ path, message }] }` onto field messages. */
function fieldErrorsFrom(error) {
  const issues = error?.response?.data?.errors
  if (!Array.isArray(issues)) return {}
  const out = {}
  for (const issue of issues) {
    const key = Array.isArray(issue?.path) ? issue.path.join('.') : issue?.path
    if (key && !out[key]) out[key] = issue.message
  }
  return out
}

/** Shared chrome for the three unauthenticated screens. */
function AuthShell({ heading, description, children, footer }) {
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
            <h1 className="text-xl font-semibold text-fg">{heading}</h1>
            {description ? <p className="mt-1.5 text-sm text-fg-2">{description}</p> : null}
            {children}
          </div>

          {footer ? <div className="mt-4 text-sm text-fg-3">{footer}</div> : null}
        </div>
      </main>
    </div>
  )
}

function backToSignIn(label = 'Back to sign in') {
  return (
    <Link
      to="/login"
      className="rounded font-medium text-primary-text underline underline-offset-2 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
    >
      {label}
    </Link>
  )
}

/* -------------------------------------------------------------------------- */
/* Step 1 — request a reset link                                              */
/* -------------------------------------------------------------------------- */

function RequestLink() {
  const [email, setEmail] = useState('')
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [sentTo, setSentTo] = useState(null)
  const [sentMessage, setSentMessage] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setFormError('')

    const trimmed = email.trim()
    if (!trimmed) {
      setErrors({ email: 'Enter your work email address.' })
      return
    }
    if (!/^\S+@\S+\.\S+$/.test(trimmed)) {
      setErrors({ email: 'Enter a valid email address.' })
      return
    }
    setErrors({})

    setSubmitting(true)
    try {
      const res = await api.post('/auth/forgot-password', { email: trimmed })
      // The response is deliberately identical whether or not the account
      // exists, so it cannot be used to enumerate staff addresses.
      setSentMessage(
        res.data?.message ||
          'If an account with this email exists, a password reset link has been sent to it.'
      )
      setSentTo(trimmed)
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      setErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) {
        setFormError(getErrorMessage(err, 'Could not send the reset link. Please try again.'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (sentTo) {
    return (
      <AuthShell heading="Check your email">
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3 py-2.5 text-sm text-success-text">
            <CheckCircle2 aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-success" />
            <p>{sentMessage}</p>
          </div>

          <dl className="rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm">
            <dt className="text-xs text-fg-3">Sent to</dt>
            <dd className="mt-0.5 break-all font-mono text-fg">{sentTo}</dd>
          </dl>

          <p className="text-sm text-fg-2">
            The link can be used once and expires 30 minutes after it was requested. Your current
            password still works until you set a new one.
          </p>

          <Button as={Link} to="/login" variant="primary" size="lg" fullWidth>
            Back to sign in
          </Button>
        </div>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      heading="Reset your password"
      description="Enter your work email and we will send you a single-use link to choose a new password."
      footer={<>Remembered it? {backToSignIn('Sign in')}.</>}
    >
      {formError ? (
        <Alert variant="danger" title="Could not send the reset link" className="mt-5">
          {formError}
        </Alert>
      ) : null}

      <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <FormField label="Email address" required error={errors.email}>
          {(field) => (
            <Input
              {...field}
              type="email"
              name="email"
              size="lg"
              autoComplete="username"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
          Send reset link
        </Button>
      </form>
    </AuthShell>
  )
}

/* -------------------------------------------------------------------------- */
/* Step 2 — redeem the token                                                  */
/* -------------------------------------------------------------------------- */

function ResetPassword({ token }) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState('')

  const handleSubmit = async (event) => {
    event.preventDefault()
    setFormError('')

    const found = {}
    if (!password) found.password = 'Choose a new password.'
    else if (!isLongEnough(password)) found.password = PASSWORD_TOO_SHORT
    if (confirmPassword !== password) found.confirmPassword = 'Passwords do not match.'
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      const res = await api.post('/auth/reset-password', { token, password })
      setDone(
        res.data?.message || 'Password reset successfully. You can now sign in with your new password.'
      )
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      // There is no visible input for `token`, so a token issue is a
      // form-level failure: the link is expired, already used or malformed.
      const { token: tokenError, ...visible } = fieldErrors
      setErrors(visible)
      if (Object.keys(visible).length === 0) {
        setFormError(
          tokenError ||
            getErrorMessage(err, 'This password reset link is invalid or has expired.')
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <AuthShell heading="Password updated">
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3 py-2.5 text-sm text-success-text">
            <CheckCircle2 aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-success" />
            <p>{done}</p>
          </div>
          <p className="text-sm text-fg-2">
            Every other session for this account has been signed out. Sign in again with the new
            password.
          </p>
          <Button as={Link} to="/login" variant="primary" size="lg" fullWidth>
            Go to sign in
          </Button>
        </div>
      </AuthShell>
    )
  }

  const passwordToggle = (
    <button
      type="button"
      aria-label={showPassword ? 'Hide password' : 'Show password'}
      aria-pressed={showPassword}
      onClick={() => setShowPassword((v) => !v)}
      className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600"
    >
      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  )

  return (
    <AuthShell
      heading="Choose a new password"
      description="This link can be used once. Setting a new password signs out every other session."
      footer={<>{backToSignIn('Back to sign in')}.</>}
    >
      {formError ? (
        <Alert
          variant="danger"
          title="Could not reset the password"
          className="mt-5"
          action={
            <Button as={Link} to="/forgot-password" size="sm" variant="secondary">
              New link
            </Button>
          }
        >
          {formError}
        </Alert>
      ) : null}

      <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <FormField label="New password" required error={errors.password} hint={PASSWORD_HINT}>
          {(field) => (
            <Input
              {...field}
              type={showPassword ? 'text' : 'password'}
              name="password"
              size="lg"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              trailingIcon={passwordToggle}
            />
          )}
        </FormField>

        <FormField label="Confirm new password" required error={errors.confirmPassword}>
          {(field) => (
            <Input
              {...field}
              type={showPassword ? 'text' : 'password'}
              name="confirmPassword"
              size="lg"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
          Set new password
        </Button>
      </form>
    </AuthShell>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Password recovery.
 *
 * Forgot-password is no longer an instant password overwrite (which let anyone
 * who knew a colleague's address lock them out). It now issues a hashed,
 * single-use, 30-minute token emailed as
 * `${FRONTEND_URL}/reset-password?token=…`, redeemed by the new
 * `POST /api/auth/reset-password`.
 *
 * This screen therefore has two steps and renders whichever one the URL asks
 * for: with `?token=` it is the reset form, without it the request form. It
 * answers on `/forgot-password` and is intended to be mounted on
 * `/reset-password` as well — see the routing note in the handoff.
 */
export default function ForgotPassword() {
  const [searchParams] = useSearchParams()
  const { isAuthenticated } = useAuth()
  const token = searchParams.get('token')

  // An authenticated visitor has no business on the recovery screens, but a
  // reset link must still work while a stale session is open.
  if (isAuthenticated && !token) return <Navigate to="/dashboard" replace />

  return token ? <ResetPassword token={token} /> : <RequestLink />
}
