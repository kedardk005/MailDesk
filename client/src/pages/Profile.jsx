import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Eye,
  EyeOff,
  Link2,
  Mail,
  MoonStar,
  ShieldCheck,
  Unlink,
} from 'lucide-react'

import api, { getErrorMessage, isCanceled } from '../api/axios'
import { useAuth } from '../components/AuthProvider'
import {
  PASSWORD_HINT,
  PASSWORD_MIN_LENGTH,
  PASSWORD_TOO_SHORT,
  isLongEnough,
} from '../lib/passwordPolicy'
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  FormField,
  Input,
  PageBody,
  PageHeader,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
  useConfirm,
} from '../components/ui'

const TABS = ['profile', 'security', 'gmail', 'notifications']

const ROLE_VARIANT = { Admin: 'warning', Head: 'info', Employee: 'neutral' }
const STATUS_VARIANT = { Approved: 'success', Pending: 'warning', Rejected: 'danger' }

/**
 * Human copy for `User.NOTIFICATION_EVENTS`. The canonical list comes from the
 * server (`GET /api/users/notification-preferences` returns `events`), so a new
 * event type appears here automatically with a humanised fallback label rather
 * than silently disappearing from the form.
 */
const EVENT_COPY = {
  task_assigned: {
    label: 'Task assigned to me',
    description: 'Work is delegated to you, or an existing task is reassigned.',
  },
  task_completed: {
    label: 'Task completed',
    description: 'Someone finishes a task you created.',
  },
  task_overdue: {
    label: 'Task overdue',
    description: 'A task passes its deadline.',
  },
  task_comment: {
    label: 'New comment',
    description: 'Someone comments on a task you created or were assigned.',
  },
  email_assigned: {
    label: 'Email assigned to me',
    description: 'A message from the shared inbox is routed to you.',
  },
  email_approval: {
    label: 'Assignment needs approval',
    description: 'A keyword rule suggests an assignment that needs a decision.',
  },
  system: {
    label: 'System and account notices',
    description: 'Anything that does not fall into the categories above.',
  },
}

/** Fallback label for an event type the server knows about and this build does not. */
function eventCopy(event) {
  return (
    EVENT_COPY[event] || {
      label: String(event).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
      description: 'Added to the workspace after this page was built. On by default.',
    }
  )
}

/** The browser's IANA zone, or '' when the environment cannot report one. */
function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ''
  } catch {
    return ''
  }
}

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

function formatDate(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function formatDateTime(value) {
  if (!value) return '—'
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** `YYYY-MM-DD` for a date input, without dragging in a date library. */
function toDateInput(value) {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/** Session expiry read from the JWT's own `exp` claim — no extra request. */
function tokenExpiry(token) {
  if (!token || typeof token !== 'string') return null
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json)
    return claims?.exp ? new Date(claims.exp * 1000) : null
  } catch {
    return null
  }
}

/** Cheap, honest strength hint. Not a security control — the server sets the floor. */
function passwordStrength(value) {
  if (!value) return null
  let score = 0
  if (value.length >= 8) score += 1
  if (value.length >= 12) score += 1
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1
  if (/\d/.test(value)) score += 1
  if (/[^\w\s]/.test(value)) score += 1
  if (!isLongEnough(value)) {
    return {
      label: `Too short — at least ${PASSWORD_MIN_LENGTH} characters`,
      tone: 'text-danger-text',
    }
  }
  if (score <= 1) return { label: 'Weak — add length, a capital or a digit', tone: 'text-danger-text' }
  if (score <= 3) return { label: 'Fair — longer is better than complex', tone: 'text-warning-text' }
  return { label: 'Strong', tone: 'text-success-text' }
}

/**
 * Show/hide control for one password input.
 *
 * One toggle per field, not one for the form. The audit found the eye on
 * *Current password* only, so the two fields where a typo actually costs
 * something — the new password and its confirmation, neither of which can be
 * checked against anything the user already knows — were the ones you could not
 * read back. `field` names the input in the accessible label so three toggles
 * in one form are still distinguishable in a screen reader's control list.
 *
 * @param {string} field - e.g. "new password"
 * @param {boolean} shown
 * @param {Function} onToggle
 */
function PasswordToggle({ field, shown, onToggle }) {
  return (
    <button
      type="button"
      aria-label={`${shown ? 'Hide' : 'Show'} ${field}`}
      aria-pressed={shown}
      onClick={onToggle}
      className="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:text-fg-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600"
    >
      {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  )
}

function DetailRow({ label, children }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-2 last:border-0">
      <dt className="text-xs text-fg-3">{label}</dt>
      <dd className="text-sm text-fg">{children}</dd>
    </div>
  )
}

/**
 * Account settings.
 *
 * Two defects are fixed structurally rather than patched:
 *
 * 1. "Inbox Address" was always blank because the client read
 *    `gmailStatus.email` while `GET /api/gmail/status` returned `gmailEmail`.
 *    The server now returns both; this reads `gmailEmail` first.
 * 2. Saving the profile refreshed the Sidebar but not the Navbar, because the
 *    user object was written to `localStorage` and a synthetic `storage` event
 *    was dispatched, which only some listeners honoured. Everything now goes
 *    through `useAuth().setUser`, so every consumer of the context updates at
 *    once and no page touches `localStorage`.
 */
export default function Profile() {
  const { user, setUser, token, login, logout, displayName, isAdmin } = useAuth()
  const confirm = useConfirm()
  const [searchParams, setSearchParams] = useSearchParams()

  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const canUseGmail = profile?.role === 'Admin' || profile?.role === 'Head'
  const requestedTab = searchParams.get('tab')
  const tab = TABS.includes(requestedTab) ? requestedTab : 'profile'
  const activeTab = tab === 'gmail' && !canUseGmail ? 'profile' : tab

  const setTab = (value) => {
    const params = new URLSearchParams(searchParams)
    if (value === 'profile') params.delete('tab')
    else params.set('tab', value)
    setSearchParams(params, { replace: true })
  }

  /* -- profile form ------------------------------------------------------ */
  const [form, setForm] = useState({ name: '', email: '', phoneNumber: '', birthdate: '' })
  const [formErrors, setFormErrors] = useState({})
  const [savingProfile, setSavingProfile] = useState(false)

  /* -- password form ----------------------------------------------------- */
  const [passwords, setPasswords] = useState({ current: '', next: '', confirm: '' })
  const [passwordErrors, setPasswordErrors] = useState({})
  /* One flag per field — see <PasswordToggle>. */
  const [showPasswords, setShowPasswords] = useState({
    current: false,
    next: false,
    confirm: false,
  })
  const togglePassword = (key) => setShowPasswords((s) => ({ ...s, [key]: !s[key] }))
  const [savingPassword, setSavingPassword] = useState(false)

  /* -- gmail ------------------------------------------------------------- */
  const [gmail, setGmail] = useState({ connected: false, gmailEmail: '', linkedAccounts: [] })
  const [gmailError, setGmailError] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState('')

  /* -- notification preferences (S-12) ----------------------------------- */
  const [prefs, setPrefs] = useState(null)
  const [savedPrefs, setSavedPrefs] = useState(null)
  const [prefEvents, setPrefEvents] = useState([])
  const [prefsLoading, setPrefsLoading] = useState(true)
  const [prefsError, setPrefsError] = useState('')
  const [prefsFieldErrors, setPrefsFieldErrors] = useState([])
  const [savingPrefs, setSavingPrefs] = useState(false)

  const applyProfile = useCallback(
    (data) => {
      // `PUT /api/users/profile` returns the `GET /auth/me` shape since S-7, so
      // the response replaces the record rather than being merged into it — a
      // merge would have kept a field the server had just cleared.
      setProfile(data)
      setForm({
        name: data?.name || '',
        email: data?.email || '',
        phoneNumber: data?.phoneNumber || '',
        birthdate: toDateInput(data?.birthdate),
      })
      // Single source of truth: the Navbar, Sidebar and command palette all
      // read this, so they update together.
      setUser(data)
    },
    [setUser]
  )

  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/auth/me', { signal: controller.signal })
      .then((res) => {
        applyProfile(res.data)
        setLoadError('')
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setLoadError(getErrorMessage(err, 'Could not load your profile.'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [applyProfile])

  const loadGmail = useCallback((signal) => {
    return api
      .get('/gmail/status', { signal })
      .then((res) => {
        setGmail({
          connected: Boolean(res.data?.connected),
          // The server returns `gmailEmail` (and `email` as an alias). Reading
          // only `email` is what left this field blank for every user.
          gmailEmail: res.data?.gmailEmail || res.data?.email || '',
          linkedAccounts: Array.isArray(res.data?.linkedAccounts) ? res.data.linkedAccounts : [],
        })
        setGmailError('')
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setGmailError(getErrorMessage(err, 'Could not read the Gmail connection status.'))
      })
  }, [])

  useEffect(() => {
    if (!canUseGmail) return undefined
    const controller = new AbortController()
    loadGmail(controller.signal)
    return () => controller.abort()
  }, [canUseGmail, loadGmail])

  useEffect(() => {
    const controller = new AbortController()
    api
      .get('/users/notification-preferences', { signal: controller.signal })
      .then((res) => {
        const loaded = res.data?.notificationPreferences || null
        setPrefs(loaded)
        setSavedPrefs(loaded)
        setPrefEvents(
          Array.isArray(res.data?.events) && res.data.events.length > 0
            ? res.data.events
            : Object.keys(EVENT_COPY)
        )
        setPrefsError('')
      })
      .catch((err) => {
        if (isCanceled(err)) return
        setPrefsError(getErrorMessage(err, 'Could not load your notification preferences.'))
      })
      .finally(() => {
        if (!controller.signal.aborted) setPrefsLoading(false)
      })
    return () => controller.abort()
  }, [])

  const expiresAt = useMemo(() => tokenExpiry(token), [token])
  const strength = passwordStrength(passwords.next)
  const prefsDirty = useMemo(
    () => Boolean(prefs) && JSON.stringify(prefs) !== JSON.stringify(savedPrefs),
    [prefs, savedPrefs]
  )

  /* -- handlers ---------------------------------------------------------- */

  const saveProfile = async (event) => {
    event.preventDefault()

    const found = {}
    if (!form.name.trim()) found.name = 'Enter your name.'
    if (!form.email.trim()) found.email = 'Enter your email address.'
    else if (!/^\S+@\S+\.\S+$/.test(form.email.trim())) found.email = 'Enter a valid email address.'
    setFormErrors(found)
    if (Object.keys(found).length > 0) return

    setSavingProfile(true)
    try {
      const res = await api.put('/users/profile', {
        name: form.name.trim(),
        email: form.email.trim(),
        phoneNumber: form.phoneNumber.trim(),
        birthdate: form.birthdate || null,
      })
      applyProfile(res.data)
      setFormErrors({})
      toast.success('Profile updated')
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      setFormErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) {
        toast.error('Could not save your profile', { description: getErrorMessage(err) })
      }
    } finally {
      setSavingProfile(false)
    }
  }

  const savePassword = async (event) => {
    event.preventDefault()

    const found = {}
    if (!passwords.current) found.currentPassword = 'Enter your current password.'
    if (!passwords.next) found.newPassword = 'Choose a new password.'
    else if (!isLongEnough(passwords.next)) found.newPassword = PASSWORD_TOO_SHORT
    else if (passwords.next === passwords.current)
      found.newPassword = 'The new password must be different.'
    if (passwords.confirm !== passwords.next) found.confirm = 'Passwords do not match.'
    setPasswordErrors(found)
    if (Object.keys(found).length > 0) return

    setSavingPassword(true)
    try {
      const res = await api.put('/users/change-password', {
        currentPassword: passwords.current,
        newPassword: passwords.next,
      })
      setPasswords({ current: '', next: '', confirm: '' })
      setPasswordErrors({})
      /* Cleared fields must not stay revealed for the next visitor to this tab. */
      setShowPasswords({ current: false, next: false, confirm: false })
      // S-6: the server still bumps `tokenVersion` — which is the point, every
      // session holding the old credential is revoked — but it now hands back a
      // replacement token signed with the new version. Storing it keeps THIS
      // session alive; the forced sign-out is gone.
      if (res.data?.token) {
        login({ token: res.data.token, user: res.data.user || user })
        if (res.data.user) setProfile(res.data.user)
        toast.success('Password updated', {
          description: 'You stayed signed in here. Every other session was signed out.',
        })
      } else {
        // Older server build: no replacement token, so this session is already
        // dead. Sign out cleanly rather than 401-ing into a redirect.
        toast.success('Password updated', { description: 'Sign in again with your new password.' })
        logout()
      }
    } catch (err) {
      const fieldErrors = fieldErrorsFrom(err)
      setPasswordErrors(fieldErrors)
      if (Object.keys(fieldErrors).length === 0) {
        toast.error('Could not update your password', { description: getErrorMessage(err) })
      }
    } finally {
      setSavingPassword(false)
    }
  }

  const connectGmail = async () => {
    setConnecting(true)
    try {
      const res = await api.get('/gmail/auth-url')
      if (res.data?.authUrl) {
        window.location.assign(res.data.authUrl)
        return
      }
      setGmailError('The server did not return a Google authorization link.')
    } catch (err) {
      setGmailError(getErrorMessage(err, 'Could not start the Google authorization flow.'))
    } finally {
      setConnecting(false)
    }
  }

  const disconnectPrimary = async () => {
    const ok = await confirm({
      title: `Disconnect ${gmail.gmailEmail || 'this Gmail account'}?`,
      description:
        'Syncing stops immediately and the emails fetched from this mailbox are removed from the workspace. Tasks created from them keep their own details.',
      confirmLabel: 'Disconnect account',
      cancelLabel: 'Keep connected',
      tone: 'danger',
    })
    if (!ok) return

    setDisconnecting('primary')
    try {
      await api.delete('/gmail/disconnect')
      await loadGmail()
      toast.success('Gmail account disconnected')
    } catch (err) {
      toast.error('Could not disconnect the account', { description: getErrorMessage(err) })
    } finally {
      setDisconnecting('')
    }
  }

  const disconnectLinked = async (account) => {
    const ok = await confirm({
      title: `Disconnect ${account.gmailEmail}?`,
      description: account.isOtherUser
        ? `This mailbox belongs to ${account.ownerName}. Disconnecting it stops their sync as well.`
        : 'Syncing stops immediately for this additional mailbox.',
      confirmLabel: 'Disconnect account',
      cancelLabel: 'Keep connected',
      tone: 'danger',
    })
    if (!ok) return

    setDisconnecting(account.gmailEmail)
    try {
      await api.delete('/gmail/linked-account', {
        data: { gmailEmail: account.gmailEmail, userId: account.userId },
      })
      await loadGmail()
      toast.success('Gmail account disconnected')
    } catch (err) {
      toast.error('Could not disconnect the account', { description: getErrorMessage(err) })
    } finally {
      setDisconnecting('')
    }
  }

  /* -- notification preferences ------------------------------------------ */

  const setChannel = (channel, key, value) =>
    setPrefs((prev) => (prev ? { ...prev, [channel]: { ...prev[channel], [key]: value } } : prev))

  const setChannelEvent = (channel, event, value) =>
    setPrefs((prev) =>
      prev
        ? {
            ...prev,
            [channel]: {
              ...prev[channel],
              events: { ...prev[channel]?.events, [event]: value },
            },
          }
        : prev
    )

  const setQuiet = (key, value) =>
    setPrefs((prev) => (prev ? { ...prev, quietHours: { ...prev.quietHours, [key]: value } } : prev))

  const savePreferences = async (event) => {
    event.preventDefault()
    if (!prefs) return

    setSavingPrefs(true)
    setPrefsFieldErrors([])
    try {
      // The endpoint is a PUT that deep-merges, so sending the whole object is
      // valid and keeps this page free of change tracking per toggle.
      const res = await api.put('/users/notification-preferences', {
        notificationPreferences: prefs,
      })
      const next = res.data?.notificationPreferences || prefs
      setPrefs(next)
      setSavedPrefs(next)
      if (Array.isArray(res.data?.events) && res.data.events.length > 0) {
        setPrefEvents(res.data.events)
      }
      setPrefsError('')
      toast.success('Notification preferences saved')
    } catch (err) {
      const issues = err?.response?.data?.errors
      if (Array.isArray(issues) && issues.length > 0) {
        setPrefsFieldErrors(issues.map((issue) => issue?.message).filter(Boolean))
      } else {
        toast.error('Could not save your notification preferences', {
          description: getErrorMessage(err),
        })
      }
    } finally {
      setSavingPrefs(false)
    }
  }

  /* -- render ------------------------------------------------------------ */

  if (loading) {
    return (
      <>
        <PageHeader title="Profile" description="Your account, security and connected mailboxes." />
        <PageBody className="max-w-[720px]">
          <Skeleton className="h-[76px] w-full rounded-lg" />
          <Skeleton className="mt-4 h-9 w-72" />
          <Skeleton className="mt-4 h-72 w-full rounded-lg" />
        </PageBody>
      </>
    )
  }

  return (
    <>
      <PageHeader title="Profile" description="Your account, security and connected mailboxes." />

      <PageBody className="max-w-[720px]">
        {loadError ? (
          <Alert variant="danger" title="Could not load your profile" className="mb-4">
            {loadError}
          </Alert>
        ) : null}

        <div className="mb-5 flex items-center gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <Avatar name={profile?.name || displayName} id={profile?._id} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-md font-semibold text-fg">{profile?.name || displayName}</p>
            <p className="truncate text-sm text-fg-3">{profile?.email || user?.email}</p>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Badge variant={ROLE_VARIANT[profile?.role] || 'neutral'}>
              {profile?.role || 'Unknown'}
            </Badge>
            {profile?.status ? (
              <Badge variant={STATUS_VARIANT[profile.status] || 'neutral'}>{profile.status}</Badge>
            ) : null}
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="security">Security</TabsTrigger>
            {canUseGmail ? <TabsTrigger value="gmail">Connected Gmail</TabsTrigger> : null}
            <TabsTrigger value="notifications">Notifications</TabsTrigger>
          </TabsList>

          {/* ---------------------------------------------------------- */}
          <TabsContent value="profile" className="pt-5">
            <Card>
              <CardHeader
                title="Account information"
                description="Your name and contact details as they appear across the workspace."
              />
              <form onSubmit={saveProfile}>
                <CardBody className="flex flex-col gap-4">
                  <FormField label="Full name" required error={formErrors.name}>
                    {(field) => (
                      <Input
                        {...field}
                        autoComplete="name"
                        value={form.name}
                        onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                      />
                    )}
                  </FormField>

                  <FormField label="Email address" required error={formErrors.email}>
                    {(field) => (
                      <Input
                        {...field}
                        type="email"
                        autoComplete="email"
                        value={form.email}
                        onChange={(e) => setForm((p) => ({ ...p, email: e.target.value }))}
                      />
                    )}
                  </FormField>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField
                      label="Phone number"
                      optionalText="(optional)"
                      error={formErrors.phoneNumber}
                    >
                      {(field) => (
                        <Input
                          {...field}
                          type="tel"
                          autoComplete="tel"
                          placeholder="+91 98765 43210"
                          value={form.phoneNumber}
                          onChange={(e) => setForm((p) => ({ ...p, phoneNumber: e.target.value }))}
                        />
                      )}
                    </FormField>

                    <FormField
                      label="Date of birth"
                      optionalText="(optional)"
                      error={formErrors.birthdate}
                    >
                      {(field) => (
                        <Input
                          {...field}
                          type="date"
                          value={form.birthdate}
                          onChange={(e) => setForm((p) => ({ ...p, birthdate: e.target.value }))}
                        />
                      )}
                    </FormField>
                  </div>

                  <FormField label="Role" hint="Roles are assigned by an administrator.">
                    {(field) => <Input {...field} readOnly value={profile?.role || ''} />}
                  </FormField>
                </CardBody>
                <CardFooter>
                  <Button type="submit" variant="primary" loading={savingProfile}>
                    Save changes
                  </Button>
                </CardFooter>
              </form>
            </Card>
          </TabsContent>

          {/* ---------------------------------------------------------- */}
          <TabsContent value="security" className="pt-5">
            <div className="flex flex-col gap-5">
              <Card>
                <CardHeader
                  title="Change password"
                  description="You need your current password. Every other session is signed out; this one stays open."
                />
                <form onSubmit={savePassword}>
                  <CardBody className="flex flex-col gap-4">
                    <FormField
                      label="Current password"
                      required
                      error={passwordErrors.currentPassword}
                    >
                      {(field) => (
                        <Input
                          {...field}
                          type={showPasswords.current ? 'text' : 'password'}
                          autoComplete="current-password"
                          value={passwords.current}
                          onChange={(e) => setPasswords((p) => ({ ...p, current: e.target.value }))}
                          trailingIcon={
                            <PasswordToggle
                              field="current password"
                              shown={showPasswords.current}
                              onToggle={() => togglePassword('current')}
                            />
                          }
                        />
                      )}
                    </FormField>

                    <FormField
                      label="New password"
                      required
                      error={passwordErrors.newPassword}
                      hint={strength ? undefined : PASSWORD_HINT}
                    >
                      {(field) => (
                        <Input
                          {...field}
                          type={showPasswords.next ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={passwords.next}
                          onChange={(e) => setPasswords((p) => ({ ...p, next: e.target.value }))}
                          trailingIcon={
                            <PasswordToggle
                              field="new password"
                              shown={showPasswords.next}
                              onToggle={() => togglePassword('next')}
                            />
                          }
                        />
                      )}
                    </FormField>

                    {strength && !passwordErrors.newPassword ? (
                      <p className={`-mt-2 text-xs ${strength.tone}`}>{strength.label}</p>
                    ) : null}

                    <FormField label="Confirm new password" required error={passwordErrors.confirm}>
                      {(field) => (
                        <Input
                          {...field}
                          type={showPasswords.confirm ? 'text' : 'password'}
                          autoComplete="new-password"
                          value={passwords.confirm}
                          onChange={(e) => setPasswords((p) => ({ ...p, confirm: e.target.value }))}
                          trailingIcon={
                            <PasswordToggle
                              field="confirm new password"
                              shown={showPasswords.confirm}
                              onToggle={() => togglePassword('confirm')}
                            />
                          }
                        />
                      )}
                    </FormField>
                  </CardBody>
                  <CardFooter>
                    <Button type="submit" variant="primary" loading={savingPassword}>
                      Update password
                    </Button>
                  </CardFooter>
                </form>
              </Card>

              <Card>
                <CardHeader
                  title="This session"
                  description="Signing out clears the token and every cached list on this device."
                />
                <CardBody>
                  <dl>
                    <DetailRow label="Role">{profile?.role || '—'}</DetailRow>
                    <DetailRow label="Account status">{profile?.status || '—'}</DetailRow>
                    <DetailRow label="Account created">{formatDate(profile?.createdAt)}</DetailRow>
                    <DetailRow label="Session expires">
                      {expiresAt ? formatDateTime(expiresAt) : 'Unknown'}
                    </DetailRow>
                  </dl>
                </CardBody>
                <CardFooter>
                  <Button variant="secondary" onClick={logout}>
                    Sign out
                  </Button>
                </CardFooter>
              </Card>
            </div>
          </TabsContent>

          {/* ---------------------------------------------------------- */}
          {canUseGmail ? (
            <TabsContent value="gmail" className="pt-5">
              <div className="flex flex-col gap-5">
                {gmailError ? (
                  <Alert variant="danger" title="Gmail status unavailable">
                    {gmailError}
                  </Alert>
                ) : null}

                <Card>
                  <CardHeader
                    title="Primary mailbox"
                    description="The Gmail account this workspace syncs on your behalf."
                    actions={
                      gmail.connected ? (
                        <Badge variant="success">Connected</Badge>
                      ) : (
                        <Badge variant="neutral">Not connected</Badge>
                      )
                    }
                  />
                  <CardBody>
                    {gmail.connected ? (
                      <dl>
                        <DetailRow label="Inbox address">
                          <span className="break-all font-mono">{gmail.gmailEmail || '—'}</span>
                        </DetailRow>
                        <DetailRow label="Sync">Automatic, plus manual sync from the inbox</DetailRow>
                      </dl>
                    ) : (
                      <p className="text-sm text-fg-2">
                        Connect a Gmail mailbox to pull messages into the shared inbox and turn them
                        into tasks. You will be sent to Google to authorize access.
                      </p>
                    )}
                  </CardBody>
                  <CardFooter>
                    {gmail.connected ? (
                      <Button
                        variant="danger-ghost"
                        leftIcon={<Unlink className="h-4 w-4" />}
                        loading={disconnecting === 'primary'}
                        onClick={disconnectPrimary}
                      >
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        variant="primary"
                        leftIcon={<Link2 className="h-4 w-4" />}
                        loading={connecting}
                        onClick={connectGmail}
                      >
                        Connect Gmail
                      </Button>
                    )}
                  </CardFooter>
                </Card>

                <Card>
                  <CardHeader
                    title="Additional mailboxes"
                    description="Other Gmail accounts linked to this workspace."
                  />
                  <CardBody>
                    {gmail.linkedAccounts.length === 0 ? (
                      <p className="text-sm text-fg-3">No additional mailboxes are linked.</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {gmail.linkedAccounts.map((account) => (
                          <li
                            key={`${account.userId}-${account.gmailEmail}`}
                            className="flex flex-wrap items-center gap-3 rounded-lg border border-line px-3 py-2.5"
                          >
                            <Mail aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-mono text-sm text-fg">
                                {account.gmailEmail || 'Unknown address'}
                              </p>
                              <p className="truncate text-xs text-fg-3">
                                {account.isOtherUser ? `Owned by ${account.ownerName}` : 'Owned by you'}
                              </p>
                            </div>
                            <Badge variant={account.connected ? 'success' : 'neutral'}>
                              {account.connected ? 'Connected' : 'Token missing'}
                            </Badge>
                            {/* S-11: DELETE /api/gmail/linked-account now
                                serves Head as well, but the server only ever
                                lets a non-Admin target their own mailboxes —
                                so the control appears exactly where it can
                                succeed, and never where it would 403. */}
                            {isAdmin || !account.isOtherUser ? (
                              <Button
                                variant="danger-ghost"
                                size="sm"
                                leftIcon={<Unlink className="h-4 w-4" />}
                                loading={disconnecting === account.gmailEmail}
                                onClick={() => disconnectLinked(account)}
                              >
                                Disconnect
                              </Button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </CardBody>
                </Card>
              </div>
            </TabsContent>
          ) : null}

          {/* ---------------------------------------------------------- */}
          <TabsContent value="notifications" className="pt-5">
            {prefsLoading ? (
              <div className="flex flex-col gap-4">
                <Skeleton className="h-64 w-full rounded-lg" />
                <Skeleton className="h-64 w-full rounded-lg" />
              </div>
            ) : !prefs ? (
              <Alert variant="danger" title="Notification preferences unavailable">
                {prefsError || 'The server did not return your notification preferences.'}
              </Alert>
            ) : (
              <form onSubmit={savePreferences} className="flex flex-col gap-5">
                {prefsError ? (
                  <Alert variant="warning" title="Preferences may be out of date">
                    {prefsError}
                  </Alert>
                ) : null}

                {prefsFieldErrors.length > 0 ? (
                  <Alert variant="danger" title="These preferences were rejected">
                    <ul className="list-disc pl-4">
                      {prefsFieldErrors.map((message) => (
                        <li key={message}>{message}</li>
                      ))}
                    </ul>
                  </Alert>
                ) : null}

                <Card>
                  <CardHeader
                    title="In the app"
                    description="Items in the notification centre."
                    actions={
                      <Badge variant={prefs.inApp?.enabled ? 'success' : 'neutral'}>
                        {prefs.inApp?.enabled ? 'On' : 'Off'}
                      </Badge>
                    }
                  />
                  <CardBody className="flex flex-col gap-4">
                    <Checkbox
                      id="notif-inapp-enabled"
                      label="Show in-app notifications"
                      description="Turning this off silences every in-app notification, whatever the per-type settings below say."
                      checked={Boolean(prefs.inApp?.enabled)}
                      onCheckedChange={(v) => setChannel('inApp', 'enabled', Boolean(v))}
                    />
                    <fieldset
                      disabled={!prefs.inApp?.enabled}
                      className="flex flex-col gap-3 border-t border-line pt-4 disabled:opacity-60"
                    >
                      <legend className="sr-only">In-app notification types</legend>
                      {prefEvents.map((event) => {
                        const copy = eventCopy(event)
                        return (
                          <Checkbox
                            key={event}
                            id={`notif-inapp-${event}`}
                            label={copy.label}
                            description={copy.description}
                            checked={prefs.inApp?.events?.[event] !== false}
                            onCheckedChange={(v) => setChannelEvent('inApp', event, Boolean(v))}
                          />
                        )
                      })}
                    </fieldset>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title="By email"
                    description={`Sent to ${profile?.email || 'your account address'}.`}
                    actions={
                      <Badge variant={prefs.email?.enabled ? 'success' : 'neutral'}>
                        {prefs.email?.enabled ? 'On' : 'Off'}
                      </Badge>
                    }
                  />
                  <CardBody className="flex flex-col gap-4">
                    <Alert variant="info" title="Account mail is always delivered">
                      Password resets and account-approval messages ignore these settings — losing
                      one would lock you out of the workspace.
                    </Alert>
                    <Checkbox
                      id="notif-email-enabled"
                      label="Send notification emails"
                      description="Turning this off silences every notification email, whatever the per-type settings below say."
                      checked={Boolean(prefs.email?.enabled)}
                      onCheckedChange={(v) => setChannel('email', 'enabled', Boolean(v))}
                    />
                    <fieldset
                      disabled={!prefs.email?.enabled}
                      className="flex flex-col gap-3 border-t border-line pt-4 disabled:opacity-60"
                    >
                      <legend className="sr-only">Email notification types</legend>
                      {prefEvents.map((event) => {
                        const copy = eventCopy(event)
                        return (
                          <Checkbox
                            key={event}
                            id={`notif-email-${event}`}
                            label={copy.label}
                            description={copy.description}
                            checked={prefs.email?.events?.[event] !== false}
                            onCheckedChange={(v) => setChannelEvent('email', event, Boolean(v))}
                          />
                        )
                      })}
                    </fieldset>
                  </CardBody>
                </Card>

                <Card>
                  <CardHeader
                    title="Quiet hours"
                    description="A window where notification email is held back."
                    actions={
                      <Badge variant={prefs.quietHours?.enabled ? 'info' : 'neutral'}>
                        {prefs.quietHours?.enabled ? 'On' : 'Off'}
                      </Badge>
                    }
                  />
                  <CardBody className="flex flex-col gap-4">
                    <Alert variant="info" title="Quiet hours suppress email only">
                      In-app notifications are still recorded during quiet hours. They are a passive
                      list you read later, so dropping one would destroy the record rather than
                      defer a ping.
                    </Alert>

                    <Checkbox
                      id="notif-quiet-enabled"
                      label="Hold notification email during quiet hours"
                      checked={Boolean(prefs.quietHours?.enabled)}
                      onCheckedChange={(v) => setQuiet('enabled', Boolean(v))}
                    />

                    <fieldset
                      disabled={!prefs.quietHours?.enabled}
                      className="flex flex-col gap-4 border-t border-line pt-4 disabled:opacity-60"
                    >
                      <legend className="sr-only">Quiet hours window</legend>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <FormField label="Start" hint="24-hour time.">
                          {(field) => (
                            <Input
                              {...field}
                              type="time"
                              value={prefs.quietHours?.start || '22:00'}
                              onChange={(e) => setQuiet('start', e.target.value)}
                            />
                          )}
                        </FormField>
                        <FormField label="End" hint="A window may run past midnight.">
                          {(field) => (
                            <Input
                              {...field}
                              type="time"
                              value={prefs.quietHours?.end || '07:00'}
                              onChange={(e) => setQuiet('end', e.target.value)}
                            />
                          )}
                        </FormField>
                      </div>

                      <FormField
                        label="Time zone"
                        hint="An IANA zone name, for example Asia/Kolkata. The window is evaluated in this zone, not the server's."
                      >
                        {(field) => (
                          <div className="flex flex-wrap items-center gap-2">
                            <Input
                              {...field}
                              className="min-w-0 flex-1"
                              value={prefs.quietHours?.timezone || ''}
                              onChange={(e) => setQuiet('timezone', e.target.value)}
                            />
                            <Button
                              type="button"
                              variant="secondary"
                              leftIcon={<MoonStar className="h-4 w-4" />}
                              onClick={() => setQuiet('timezone', deviceTimeZone())}
                              disabled={!deviceTimeZone()}
                            >
                              Use this device
                            </Button>
                          </div>
                        )}
                      </FormField>
                    </fieldset>
                  </CardBody>
                </Card>

                <Card>
                  <CardBody className="flex items-center gap-2 py-3">
                    <ShieldCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
                    <p className="text-xs text-fg-3">
                      A notification type added to the workspace after these settings were saved is
                      delivered by default, so a new alert can never be silently swallowed.
                    </p>
                  </CardBody>
                  <CardFooter>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={!prefsDirty || savingPrefs}
                      onClick={() => {
                        setPrefs(savedPrefs)
                        setPrefsFieldErrors([])
                      }}
                    >
                      Discard changes
                    </Button>
                    <Button
                      type="submit"
                      variant="primary"
                      loading={savingPrefs}
                      disabled={!prefsDirty}
                    >
                      Save preferences
                    </Button>
                  </CardFooter>
                </Card>
              </form>
            )}
          </TabsContent>
        </Tabs>
      </PageBody>
    </>
  )
}
