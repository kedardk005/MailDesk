import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { Eye, EyeOff, Mail } from 'lucide-react'

import api, { getErrorMessage } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import { Alert, Button, FormField, Input } from '../components/ui'

/**
 * Map the server's 400 validation payload onto per-field messages.
 *
 * `middleware/validate.js` now returns
 *   { message, errors: [{ path: 'email', message: '…' }] }
 * instead of the 500 that every validation failure used to produce.
 */
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

/**
 * Only ever redirect to a path inside this app. `//evil.com` is a valid
 * pathname to the browser but an open redirect to us.
 */
function safeNext(value) {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  return value
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

export default function Login() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isAuthenticated, login } = useAuth()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const next = safeNext(searchParams.get('next')) || '/dashboard'

  if (isAuthenticated) return <Navigate to={next} replace />

  const validate = () => {
    const found = {}
    if (!email.trim()) found.email = 'Enter your work email address.'
    else if (!/^\S+@\S+\.\S+$/.test(email.trim())) found.email = 'Enter a valid email address.'
    if (!password) found.password = 'Enter your password.'
    return found
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setFormError('')

    const found = validate()
    setErrors(found)
    if (Object.keys(found).length > 0) return

    setSubmitting(true)
    try {
      const res = await api.post('/auth/login', { email: email.trim(), password })
      login({ token: res.data.token, user: res.data.user })
      navigate(next, { replace: true })
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      setErrors(fieldErrors)
      // A 400 with per-field errors is already shown inline; only surface the
      // summary when there is nothing field-specific to point at.
      //
      // B-4: a 403 is currently shown twice — once here, once as a toast raised
      // by the axios response interceptor. The banner is the right affordance
      // for a sign-in failure (it persists next to the form), so the fix
      // belongs in `api/axios.js`: its 403 branch should exempt `/auth/*`
      // exactly as its 401 branch already does. Suppressing the banner here
      // instead would leave a sign-in failure reported only by a 4-second toast.
      if (Object.keys(fieldErrors).length === 0) {
        setFormError(getErrorMessage(err, 'Could not sign you in. Check your details and retry.'))
      }
      setSubmitting(false)
    }
  }

  return (
    <AuthShell
      heading="Sign in"
      description="Use the work account your administrator set up for you."
      footer={
        <>
          No account yet?{' '}
          <Link
            to="/register"
            className="rounded font-medium text-primary-text underline underline-offset-2 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
          >
            Request access
          </Link>
          .
        </>
      }
    >
      {formError ? (
        <Alert variant="danger" title="Sign-in failed" className="mt-5">
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

        <FormField label="Password" required error={errors.password}>
          {(field) => (
            <Input
              {...field}
              type={showPassword ? 'text' : 'password'}
              name="password"
              size="lg"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              trailingIcon={
                <button
                  type="button"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((v) => !v)}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
            />
          )}
        </FormField>

        <div className="flex justify-end">
          <Link
            to="/forgot-password"
            className="rounded text-sm font-medium text-primary-text underline underline-offset-2 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
          >
            Forgot your password?
          </Link>
        </div>

        <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  )
}
