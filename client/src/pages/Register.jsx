import { useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
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

export default function Register() {
  const navigate = useNavigate()
  const { isAuthenticated, login } = useAuth()

  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '' })
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState({})
  const [formError, setFormError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  /** Set when the server accepts the account but withholds a token. */
  const [pending, setPending] = useState(null)

  if (isAuthenticated) return <Navigate to="/dashboard" replace />

  const setField = (key) => (event) => {
    const { value } = event.target
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const validate = () => {
    const found = {}
    if (!form.name.trim()) found.name = 'Enter your full name.'
    if (!form.email.trim()) found.email = 'Enter your work email address.'
    else if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) found.email = 'Enter a valid email address.'
    if (!form.password) found.password = 'Choose a password.'
    else if (!isLongEnough(form.password)) found.password = PASSWORD_TOO_SHORT
    if (form.confirmPassword !== form.password) found.confirmPassword = 'Passwords do not match.'
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
      const res = await api.post('/auth/register', {
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      })

      // Registration no longer mints a JWT for a non-approved account: the
      // server returns 201 with a message and the user object, and Admin
      // approval is a real gate rather than a decorative one. The old code
      // assumed a token was always present and signed the user straight in.
      if (res.data?.token) {
        login({ token: res.data.token, user: res.data.user })
        navigate('/dashboard', { replace: true })
        return
      }

      setPending({
        email: res.data?.user?.email || form.email.trim(),
        message:
          res.data?.message ||
          'Registration submitted. An administrator must approve your account before you can sign in.',
      })
      setSubmitting(false)
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      setErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) {
        setFormError(getErrorMessage(err, 'Could not create the account. Check your details.'))
      }
      setSubmitting(false)
    }
  }

  if (pending) {
    return (
      <AuthShell heading="Request submitted">
        <div className="mt-5 flex flex-col gap-4">
          <div className="flex items-start gap-2.5 rounded-lg border border-success-border bg-success-subtle px-3 py-2.5 text-sm text-success-text">
            <CheckCircle2 aria-hidden="true" className="mt-px h-4 w-4 shrink-0 text-success" />
            <p>{pending.message}</p>
          </div>

          <dl className="rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm">
            <dt className="text-xs text-fg-3">Account</dt>
            <dd className="mt-0.5 break-all font-mono text-fg">{pending.email}</dd>
            <dt className="mt-2.5 text-xs text-fg-3">Status</dt>
            <dd className="mt-0.5 text-fg">Awaiting administrator approval</dd>
          </dl>

          <p className="text-sm text-fg-2">
            You will not be able to sign in until an administrator approves the account. Contact
            your workspace administrator if it is urgent.
          </p>

          <Button as={Link} to="/login" variant="primary" size="lg" fullWidth>
            Back to sign in
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
      heading="Request access"
      description="Create an account request. An administrator approves it before you can sign in."
      footer={
        <>
          Already have an account?{' '}
          <Link
            to="/login"
            className="rounded font-medium text-primary-text underline underline-offset-2 hover:text-primary-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
          >
            Sign in
          </Link>
          .
        </>
      }
    >
      {formError ? (
        <Alert variant="danger" title="Could not submit the request" className="mt-5">
          {formError}
        </Alert>
      ) : null}

      <form className="mt-5 flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <FormField label="Full name" required error={errors.name}>
          {(field) => (
            <Input
              {...field}
              name="name"
              size="lg"
              autoComplete="name"
              placeholder="Asha Rao"
              value={form.name}
              onChange={setField('name')}
            />
          )}
        </FormField>

        <FormField label="Email address" required error={errors.email}>
          {(field) => (
            <Input
              {...field}
              type="email"
              name="email"
              size="lg"
              autoComplete="username"
              placeholder="you@company.com"
              value={form.email}
              onChange={setField('email')}
            />
          )}
        </FormField>

        <FormField
          label="Password"
          required
          error={errors.password}
          hint={PASSWORD_HINT}
        >
          {(field) => (
            <Input
              {...field}
              type={showPassword ? 'text' : 'password'}
              name="password"
              size="lg"
              autoComplete="new-password"
              value={form.password}
              onChange={setField('password')}
              trailingIcon={passwordToggle}
            />
          )}
        </FormField>

        <FormField label="Confirm password" required error={errors.confirmPassword}>
          {(field) => (
            <Input
              {...field}
              type={showPassword ? 'text' : 'password'}
              name="confirmPassword"
              size="lg"
              autoComplete="new-password"
              value={form.confirmPassword}
              onChange={setField('confirmPassword')}
            />
          )}
        </FormField>

        <Button type="submit" variant="primary" size="lg" fullWidth loading={submitting}>
          Submit request
        </Button>
      </form>
    </AuthShell>
  )
}
