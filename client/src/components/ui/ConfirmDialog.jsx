import { createContext, useCallback, useContext, useId, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Info, Trash2 } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogFooter } from './Dialog'
import { Button } from './Button'
import { Input } from './Input'
import { Label } from './Label'

/**
 * ConfirmDialog — the replacement for every `window.confirm()` / `alert()`.
 *
 * Two ways to use it:
 *
 * 1. Imperative (preferred, one line at the call site):
 *
 *      const confirm = useConfirm()
 *      const ok = await confirm({
 *        title: 'Delete task “Q3 GST filing”?',
 *        description: 'The task and its comments are removed permanently.',
 *        confirmLabel: 'Delete task',
 *        tone: 'danger',
 *      })
 *      if (!ok) return
 *
 *    Requires <ConfirmProvider> to be mounted (it is, in App.jsx).
 *
 *    For an irreversible bulk action, add a typed challenge instead of
 *    hand-rolling a second dialog:
 *
 *      const ok = await confirm({
 *        title: 'Clear the entire inbox?',
 *        description: 'All 1,284 stored emails are deleted permanently.',
 *        confirmLabel: 'Clear inbox',
 *        requireTyped: { value: 'DELETE' },
 *      })
 *
 * 2. Declarative:
 *
 *      <ConfirmDialog open={o} onOpenChange={setO} tone="danger"
 *                     title="…" onConfirm={handleDelete} />
 */

const toneConfig = {
  danger: {
    Icon: Trash2,
    iconClass: 'bg-danger-subtle text-danger',
    confirmVariant: 'danger',
  },
  warning: {
    Icon: AlertTriangle,
    iconClass: 'bg-warning-subtle text-warning',
    confirmVariant: 'primary',
  },
  info: {
    Icon: Info,
    iconClass: 'bg-info-subtle text-info',
    confirmVariant: 'primary',
  },
}

/**
 * @param {boolean} open
 * @param {(open:boolean)=>void} onOpenChange
 * @param {string} title - state the object: "Delete task “X”?"
 * @param {React.ReactNode} [description] - state the consequences
 * @param {string} [confirmLabel='Confirm']
 * @param {string} [cancelLabel='Cancel']
 * @param {'danger'|'warning'|'info'} [tone='danger']
 * @param {() => (void|Promise<void>)} onConfirm
 * @param {() => void} [onCancel]
 * @param {boolean} [loading] - external control; otherwise handled internally
 * @param {{value:string, label?:React.ReactNode, placeholder?:string, hint?:React.ReactNode}} [requireTyped]
 *        Typed confirmation for irreversible bulk actions ("clear ALL emails",
 *        "delete this user"). The confirm button stays disabled until the field
 *        contains `value` exactly (leading/trailing whitespace is forgiven,
 *        case is not). Omit it and the dialog is exactly the simple one.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
  loading: loadingProp,
  requireTyped,
}) {
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')
  const [wasOpen, setWasOpen] = useState(open)
  const fieldId = useId()
  const { Icon, iconClass, confirmVariant } = toneConfig[tone] || toneConfig.danger
  const loading = loadingProp ?? busy

  const expected = requireTyped?.value ?? ''
  const typedOk = !requireTyped || typed.trim() === expected

  /* Reset the challenge every time the dialog is opened. ConfirmProvider keeps
   * one instance mounted across confirms, so this cannot be left to unmount.
   * Adjusted during render (the documented alternative to an effect) so the
   * field is never briefly rendered with the previous answer still in it. */
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open && typed) setTyped('')
  }

  const handleConfirm = async () => {
    if (!typedOk) return
    if (!onConfirm) {
      onOpenChange?.(false)
      return
    }
    try {
      setBusy(true)
      await onConfirm()
      onOpenChange?.(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel?.()
        onOpenChange?.(next)
      }}
    >
      <DialogContent size="sm" title={title} showClose={false} bodyClassName="p-5">
        <div className="flex gap-3">
          <span
            aria-hidden="true"
            className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', iconClass)}
          >
            <Icon className="h-4 w-4" />
          </span>
          <div className="min-w-0 text-sm text-fg-2">
            {description || 'This action cannot be undone.'}
          </div>
        </div>

        {requireTyped ? (
          <div className="mt-4 space-y-1.5">
            <Label htmlFor={fieldId}>
              {requireTyped.label || (
                <>
                  Type <span className="font-mono font-medium text-fg">{expected}</span> to confirm
                </>
              )}
            </Label>
            <Input
              id={fieldId}
              value={typed}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={requireTyped.placeholder ?? expected}
              aria-describedby={requireTyped.hint ? `${fieldId}-hint` : undefined}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && typedOk && !loading) {
                  e.preventDefault()
                  handleConfirm()
                }
              }}
            />
            {requireTyped.hint ? (
              <p id={`${fieldId}-hint`} className="text-xs text-fg-3">
                {requireTyped.hint}
              </p>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="-mx-5 -mb-5 mt-5">
          <Button
            variant="secondary"
            onClick={() => {
              onCancel?.()
              onOpenChange?.(false)
            }}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            onClick={handleConfirm}
            loading={loading}
            disabled={!typedOk}
            /* With a typed challenge the field takes focus instead. */
            autoFocus={!requireTyped}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------------------------------------------------------
 * Imperative API
 * ------------------------------------------------------------------------ */

const ConfirmContext = createContext(null)

/** Mount once, near the router root. */
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolverRef = useRef(null)

  const confirm = useCallback((options) => {
    return new Promise((resolve) => {
      resolverRef.current = resolve
      setState({ tone: 'danger', confirmLabel: 'Confirm', ...options, open: true })
    })
  }, [])

  const settle = useCallback((result) => {
    resolverRef.current?.(result)
    resolverRef.current = null
    setState((s) => (s ? { ...s, open: false } : s))
  }, [])

  const value = useMemo(() => ({ confirm }), [confirm])

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state ? (
        <ConfirmDialog
          {...state}
          onOpenChange={(next) => {
            if (!next) settle(false)
          }}
          onConfirm={() => settle(true)}
          onCancel={() => settle(false)}
        />
      ) : null}
    </ConfirmContext.Provider>
  )
}

/**
 * @returns {(options: {
 *   title: string,
 *   description?: React.ReactNode,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   tone?: 'danger'|'warning'|'info',
 *   requireTyped?: { value: string, label?: React.ReactNode,
 *                    placeholder?: string, hint?: React.ReactNode }
 * }) => Promise<boolean>}
 */
export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) {
    throw new Error('useConfirm() must be used inside <ConfirmProvider>.')
  }
  return ctx.confirm
}

export default ConfirmDialog
