import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react'
import { cn } from '../../lib/utils'

const config = {
  info: { Icon: Info, box: 'bg-info-subtle border-info-border text-info-text', icon: 'text-info' },
  success: {
    Icon: CheckCircle2,
    box: 'bg-success-subtle border-success-border text-success-text',
    icon: 'text-success',
  },
  warning: {
    Icon: TriangleAlert,
    box: 'bg-warning-subtle border-warning-border text-warning-text',
    icon: 'text-warning',
  },
  danger: {
    Icon: AlertCircle,
    box: 'bg-danger-subtle border-danger-border text-danger-text',
    icon: 'text-danger',
  },
}

/**
 * Inline, persistent message. Use this — not a toast — when the message must
 * stay on screen (form-level auth failure, a data-load error with a retry).
 *
 * @param {'info'|'success'|'warning'|'danger'} [variant='info']
 * @param {string} [title]
 * @param {React.ReactNode} [children] - body
 * @param {React.ReactNode} [action] - e.g. a "Retry" button
 */
export function Alert({ variant = 'info', title, action, className, children, ...props }) {
  const { Icon, box, icon } = config[variant] || config.info
  return (
    <div
      role={variant === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', box, className)}
      {...props}
    >
      <Icon aria-hidden="true" className={cn('mt-px h-4 w-4 shrink-0', icon)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && 'mt-0.5', 'text-current/90')}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export default Alert
