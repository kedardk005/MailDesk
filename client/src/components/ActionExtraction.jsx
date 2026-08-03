/**
 * F-3 — AI action-item extraction, review side.
 *
 * `POST /api/ai/extract-actions` takes `{ emailId }` OR `{ threadId }` and
 * NOTHING else (the server schema is `.strict()`, so smuggling a body in is a
 * 400 that names the key). It answers either:
 *
 *   200 { actions, suggestedClient, model, cached }
 *   202 { message, status, jobId }   -> poll GET /ai/extract-actions/:jobId
 *
 * The 202 path is not optional: a model that overruns `AI_INLINE_WAIT_MS`
 * (20 s) always lands there, and a client that ignores it looks like a button
 * that silently does nothing.
 *
 * The server deliberately creates NOTHING from the model output — it is
 * suggestion data, and the prompt input is a hostile-by-default email. So this
 * panel is a review form: every field is editable, every row is opt-in, and the
 * only path to a task is the ordinary, separately authorized `POST /api/tasks`
 * behind an explicit "Create selected".
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ListChecks, Sparkles } from 'lucide-react'

import api, { getErrorMessage, isCanceled } from '../api/axios'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Combobox,
  FormField,
  Input,
  Select,
  Textarea,
  toast,
} from './ui'
import { searchAssignees, searchClients } from '../lib/pickers'

/** Poll cadence for the 202 path. The job usually finishes on the first tick. */
const POLL_INTERVAL_MS = 2500
/** Give up rather than poll a dead job forever. */
const POLL_TIMEOUT_MS = 3 * 60 * 1000

/** Matches `Task.priority` exactly; '' means "the model did not say". */
const PRIORITY_CHOICES = [
  { value: '', label: 'No priority' },
  { value: 'Low', label: 'Low' },
  { value: 'Medium', label: 'Medium' },
  { value: 'High', label: 'High' },
  { value: 'Urgent', label: 'Urgent' },
]

/** ISO (or null) -> the value a `datetime-local` input accepts. */
function toLocalInput(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

function formatRetry(ms) {
  const seconds = Math.ceil((Number(ms) || 0) / 1000)
  if (seconds <= 0) return 'a moment'
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`
  const minutes = Math.ceil(seconds / 60)
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}

/**
 * Every degraded outcome on this endpoint is a CODED error, never a 500, and
 * the three codes mean genuinely different things to the person looking at the
 * screen. Branch on `code`, never on `message`.
 */
function toCodedError(err) {
  const status = err?.response?.status
  const data = err?.response?.data
  const code = data?.code

  if (code === 'AI_NOT_CONFIGURED') return { code }
  if (code === 'AI_UNAVAILABLE') return { code, retryInMs: Number(data?.retryInMs) || 0 }
  if (code === 'AI_FAILED') return { code }
  if (status === 404) return { code: 'JOB_GONE' }
  return {
    code: 'GENERIC',
    message: getErrorMessage(err, 'Could not extract action items from this message.'),
  }
}

/**
 * Run one extraction, including the 202 -> poll path.
 *
 * Cancellation is total: an AbortController for the in-flight request and a
 * monotonic run id that makes a late resolution from a superseded run a no-op.
 * Both the pending timeout and the controller are torn down on unmount and
 * whenever the source message changes, so nothing polls a job for a pane the
 * user already closed.
 */
function useActionExtraction(emailId, threadId) {
  const [state, setState] = useState({ phase: 'idle', data: null, error: null })
  const abortRef = useRef(null)
  const timerRef = useRef(0)
  const runIdRef = useRef(0)

  const stop = useCallback(() => {
    runIdRef.current += 1
    if (abortRef.current) {
      abortRef.current.abort()
      abortRef.current = null
    }
    if (timerRef.current) {
      window.clearTimeout(timerRef.current)
      timerRef.current = 0
    }
  }, [])

  /* Unmount — and a change of source — abort the in-flight request and kill
   * the poll timer, so nothing keeps polling a job for a pane that is gone. */
  const sourceKey = `${emailId || ''}|${threadId || ''}`
  useEffect(() => stop, [stop, sourceKey])

  /* A different message is a different question: drop the previous answer.
   * Adjusting state during render (rather than in an effect) is the documented
   * React pattern and is what the rest of this page already does. */
  const [prevSource, setPrevSource] = useState(sourceKey)
  if (sourceKey !== prevSource) {
    setPrevSource(sourceKey)
    setState({ phase: 'idle', data: null, error: null })
  }

  const reset = useCallback(() => {
    stop()
    setState({ phase: 'idle', data: null, error: null })
  }, [stop])

  const run = useCallback(() => {
    if (!emailId && !threadId) return
    stop()

    const runId = runIdRef.current
    const controller = new AbortController()
    abortRef.current = controller
    const current = () => runId === runIdRef.current

    setState({ phase: 'running', data: null, error: null })

    const succeed = (payload) => {
      if (!current()) return
      setState({
        phase: 'ready',
        data: {
          actions: Array.isArray(payload?.actions) ? payload.actions : [],
          suggestedClient: payload?.suggestedClient ?? null,
          model: payload?.model || '',
          cached: Boolean(payload?.cached),
        },
        error: null,
      })
    }

    const fail = (error) => {
      if (!current()) return
      setState({ phase: 'error', data: null, error })
    }

    const schedulePoll = (jobId, deadline) => {
      timerRef.current = window.setTimeout(async () => {
        if (!current()) return
        try {
          const res = await api.get(`/ai/extract-actions/${encodeURIComponent(jobId)}`, {
            signal: controller.signal,
          })
          if (!current()) return

          const body = res.data || {}
          if (body.status === 'completed' && Array.isArray(body.actions)) {
            succeed(body)
            return
          }
          if (body.status === 'failed') {
            // The job carries its own reason; a circuit trip is the one worth
            // separating, because "try again shortly" is true and actionable.
            fail({ code: /circuit/i.test(String(body.error || '')) ? 'AI_UNAVAILABLE' : 'AI_FAILED' })
            return
          }
          if (Date.now() > deadline) {
            fail({ code: 'TIMED_OUT' })
            return
          }
          schedulePoll(jobId, deadline)
        } catch (err) {
          if (isCanceled(err)) return
          fail(toCodedError(err))
        }
      }, POLL_INTERVAL_MS)
    }

    api
      .post(
        '/ai/extract-actions',
        // Exactly one id and nothing else. The body never travels: the server
        // reads the message itself, so a client cannot choose the prompt input
        // for a message it may not read.
        threadId ? { threadId } : { emailId },
        { signal: controller.signal }
      )
      .then((res) => {
        if (!current()) return
        if (res.status === 202 && res.data?.jobId) {
          schedulePoll(res.data.jobId, Date.now() + POLL_TIMEOUT_MS)
          return
        }
        succeed(res.data)
      })
      .catch((err) => {
        if (isCanceled(err)) return
        fail(toCodedError(err))
      })
  }, [emailId, threadId, stop])

  return { ...state, run, reset }
}

function ExtractionError({ error, onRetry }) {
  if (error.code === 'AI_NOT_CONFIGURED') {
    return (
      <Alert variant="warning" title="AI isn’t configured">
        Action extraction needs a model key on the server. Ask an administrator to configure it —
        retrying will not help.
      </Alert>
    )
  }

  if (error.code === 'AI_UNAVAILABLE') {
    return (
      <Alert
        variant="warning"
        title="AI is temporarily unavailable"
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        The model is not answering right now. Try again in {formatRetry(error.retryInMs)}.
      </Alert>
    )
  }

  if (error.code === 'AI_FAILED') {
    return (
      <Alert
        variant="danger"
        title="Couldn’t read this email"
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        The model could not turn this message into action items. Nothing was created.
      </Alert>
    )
  }

  if (error.code === 'JOB_GONE' || error.code === 'TIMED_OUT') {
    return (
      <Alert
        variant="warning"
        title="The extraction did not finish"
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Try again
          </Button>
        }
      >
        It ran for too long and the result is no longer available.
      </Alert>
    )
  }

  return (
    <Alert
      variant="danger"
      title="Could not extract action items"
      action={
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {error.message}
    </Alert>
  )
}

/** `confidence` is 0 — not 1 — when the model omitted it. Say so plainly. */
function ConfidenceBadge({ value }) {
  const pct = Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100)
  const variant = pct >= 70 ? 'success' : pct >= 40 ? 'warning' : 'neutral'
  return (
    <Badge variant={variant} size="sm">
      Confidence {pct}%
    </Badge>
  )
}

function SuggestionRow({ draft, index, onChange }) {
  const set = (key) => (value) => onChange(draft.key, { [key]: value })

  return (
    <li className="rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start gap-2.5">
        <div className="pt-0.5">
          <Checkbox
            checked={draft.selected}
            onCheckedChange={(next) => onChange(draft.key, { selected: next === true })}
            aria-label={`Create a task for suggestion ${index + 1}${
              draft.title ? `: ${draft.title}` : ''
            }`}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs font-semibold uppercase tracking-wide text-fg-3">
              Suggestion {index + 1}
            </span>
            <ConfidenceBadge value={draft.confidence} />
          </div>

          <FormField label="Title" required>
            {(field) => (
              <Input
                {...field}
                size="sm"
                value={draft.title}
                onChange={(e) => set('title')(e.target.value)}
                placeholder="What needs doing"
              />
            )}
          </FormField>

          <FormField label="Description">
            {(field) => (
              <Textarea
                {...field}
                rows={2}
                value={draft.description}
                onChange={(e) => set('description')(e.target.value)}
                placeholder="Context for whoever picks this up"
              />
            )}
          </FormField>

          <div className="grid gap-3 sm:grid-cols-2">
            <FormField
              label="Deadline"
              required
              hint={draft.dueDate ? undefined : 'The model did not suggest one'}
            >
              {(field) => (
                <Input
                  {...field}
                  size="sm"
                  type="datetime-local"
                  value={draft.dueDate}
                  onChange={(e) => set('dueDate')(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Priority">
              {(field) => (
                <Select
                  {...field}
                  size="sm"
                  value={draft.priority}
                  onChange={(e) => set('priority')(e.target.value)}
                  options={PRIORITY_CHOICES}
                />
              )}
            </FormField>
          </div>
        </div>
      </div>
    </li>
  )
}

/**
 * The whole F-3 surface: one action, one review panel.
 *
 * @param {string}   [emailId]      extract from a single message
 * @param {string}   [threadId]     …or across a conversation (exactly one)
 * @param {string}   [linkedEmail]  email id to link every created task back to
 * @param {Function} [onCreated]    called after at least one task was created
 */
export function ExtractActionsPanel({ emailId, threadId, linkedEmail, onCreated }) {
  const { phase, data, error, run, reset } = useActionExtraction(emailId, threadId)

  const [drafts, setDrafts] = useState([])
  const [clientName, setClientName] = useState('')
  /* The picker submits `assigneeOption.value`; the option carries the label. */
  const [assigneeOption, setAssigneeOption] = useState(null)
  const assignee = assigneeOption?.value || ''
  const [creating, setCreating] = useState(false)
  const aliveRef = useRef(true)
  /* Two panels can be mounted at once (a drawer plus a dialog), so the
   * select-all id has to be per-instance or both labels point at the first. */
  const selectAllId = useId()

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  /* Seed the review form from a fresh extraction. Nothing is ticked: the model
   * proposes, the person decides. Same render-time adjustment pattern as
   * above — an effect here would be a cascading render. */
  const [prevData, setPrevData] = useState(data)
  if (data !== prevData) {
    setPrevData(data)
    setDrafts(
      data
        ? data.actions.map((action, i) => ({
            key: `${i}`,
            selected: false,
            title: action?.title || '',
            description: action?.description || '',
            dueDate: toLocalInput(action?.dueDate),
            priority: action?.priority || '',
            confidence: action?.confidence,
          }))
        : []
    )
    setClientName(data?.suggestedClient || '')
  }

  const updateDraft = useCallback((key, patch) => {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)))
  }, [])

  const selected = drafts.filter((d) => d.selected)
  const allSelected = drafts.length > 0 && selected.length === drafts.length

  const blocker = (() => {
    if (selected.length === 0) return 'Tick at least one suggestion to create a task from it.'
    if (selected.some((d) => !d.title.trim())) return 'Every ticked suggestion needs a title.'
    if (selected.some((d) => !d.dueDate)) return 'Every ticked suggestion needs a deadline.'
    if (!clientName.trim()) return 'Add the client these tasks belong to.'
    if (!assignee) return 'Choose who these tasks are assigned to.'
    return ''
  })()

  const createSelected = async () => {
    if (blocker || creating) return
    setCreating(true)

    const created = []
    const failures = []
    // Sequential on purpose: `POST /api/tasks` is rate limited and a partial
    // result must be reportable, so a Promise.all that rejects on the first
    // failure would be worse, not faster.
    for (const draft of selected) {
      try {
        await api.post('/tasks', {
          title: draft.title.trim(),
          clientName: clientName.trim(),
          assignedTo: assignee,
          deadline: new Date(draft.dueDate).toISOString(),
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          ...(draft.priority ? { priority: draft.priority } : {}),
          ...(linkedEmail ? { linkedEmail } : {}),
        })
        created.push(draft.key)
      } catch (err) {
        failures.push(getErrorMessage(err, `Could not create “${draft.title.trim()}”.`))
      }
    }

    if (!aliveRef.current) return
    setCreating(false)

    if (created.length > 0) {
      const done = new Set(created)
      setDrafts((prev) => prev.filter((d) => !done.has(d.key)))
      toast.success(`Created ${created.length} ${created.length === 1 ? 'task' : 'tasks'}`)
      onCreated?.()
    }
    if (failures.length > 0) {
      toast.error(
        `Could not create ${failures.length} ${failures.length === 1 ? 'task' : 'tasks'}`,
        { description: failures[0] }
      )
    }
  }

  const disabled = !emailId && !threadId

  return (
    <section className="rounded-lg border border-line bg-canvas p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-semibold text-fg-2">
          <ListChecks aria-hidden="true" className="h-3.5 w-3.5" />
          Suggested action items
        </h3>
        <div className="flex items-center gap-2">
          {phase === 'ready' && data?.cached ? (
            <span className="text-xs text-fg-3">From an earlier run</span>
          ) : null}
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            loading={phase === 'running'}
            leftIcon={<Sparkles className="h-3.5 w-3.5" />}
            onClick={run}
          >
            {phase === 'ready' ? 'Extract again' : 'Extract action items'}
          </Button>
        </div>
      </div>

      {phase === 'running' ? (
        <p className="mt-2 text-xs text-fg-3">
          Reading the message. A slow model keeps running in the background — this pane keeps
          checking until it answers.
        </p>
      ) : null}

      {phase === 'error' && error ? (
        <div className="mt-3">
          <ExtractionError error={error} onRetry={run} />
        </div>
      ) : null}

      {phase === 'ready' && data ? (
        <div className="mt-3 space-y-3">
          <Alert variant="info" title="Machine-generated suggestions">
            A language model wrote the text below from the email, and it can be wrong or
            manipulated by the sender. Nothing is created until you tick a row and choose{' '}
            <strong className="font-medium">Create selected</strong>.
            {data.model ? (
              <span className="mt-0.5 block text-xs text-current/80">Model: {data.model}</span>
            ) : null}
          </Alert>

          {drafts.length === 0 ? (
            <p className="text-sm text-fg-3">
              No action items were found in this message. Nothing was created.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={selectAllId}
                  size="sm"
                  label={`Select all ${drafts.length} suggestions`}
                  checked={allSelected ? true : selected.length > 0 ? 'indeterminate' : false}
                  onCheckedChange={(next) =>
                    setDrafts((prev) => prev.map((d) => ({ ...d, selected: next === true })))
                  }
                />
              </div>

              <ul className="space-y-2">
                {drafts.map((draft, index) => (
                  <SuggestionRow
                    key={draft.key}
                    draft={draft}
                    index={index}
                    onChange={updateDraft}
                  />
                ))}
              </ul>

              <div className="grid gap-3 sm:grid-cols-2">
                <FormField
                  label="Client"
                  required
                  hint={
                    data.suggestedClient
                      ? 'Suggested by the model — check it before creating'
                      : undefined
                  }
                >
                  {(field) => (
                    <Combobox
                      {...field}
                      size="sm"
                      value={clientName ? { value: clientName, label: clientName } : null}
                      onChange={(opt) => setClientName(opt ? opt.value : '')}
                      loadOptions={searchClients}
                      allowCreate
                      placeholder="Client these tasks belong to"
                      searchPlaceholder="Search clients…"
                      emptyMessage="No matching clients."
                      errorMessage="Could not search clients."
                    />
                  )}
                </FormField>

                <FormField label="Assignee" required>
                  {(field) => (
                    <Combobox
                      {...field}
                      size="sm"
                      aria-label="Assignee for the created tasks"
                      value={assigneeOption}
                      onChange={setAssigneeOption}
                      loadOptions={searchAssignees}
                      placeholder="Choose a team member"
                      searchPlaceholder="Search people…"
                      emptyMessage="No matching people."
                      errorMessage="Could not search people."
                    />
                  )}
                </FormField>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2">
                {blocker ? <p className="mr-auto text-xs text-fg-3">{blocker}</p> : null}
                <Button variant="secondary" size="sm" onClick={reset}>
                  Discard suggestions
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  loading={creating}
                  disabled={Boolean(blocker)}
                  onClick={createSelected}
                >
                  Create selected ({selected.length})
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

export default ExtractActionsPanel
