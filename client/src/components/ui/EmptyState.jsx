import { Inbox } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './Button'

/**
 * Empty state. Use DISTINCT copy for "no data yet" versus "no results for this
 * filter" — the latter must offer "Clear filters".
 *
 * @param {React.ComponentType} [icon=Inbox] - a lucide icon COMPONENT (not an
 *        element, not an emoji). Rendered at 32px in `text-fg-off`, no tile.
 * @param {string} title
 * @param {React.ReactNode} [description]
 * @param {{label:string, onClick:Function, icon?:React.ReactNode}} [action] - primary CTA
 * @param {{label:string, onClick:Function}} [secondaryAction] - e.g. Clear filters
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  secondaryAction,
  className,
  ...props
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}
      {...props}
    >
      <Icon aria-hidden="true" className="h-8 w-8 text-fg-off" strokeWidth={1.5} />
      <p className="mt-3 max-w-[380px] text-base font-semibold text-fg">{title}</p>
      {description ? (
        <p className="mt-1 max-w-[380px] text-sm text-fg-3">{description}</p>
      ) : null}
      {action || secondaryAction ? (
        <div className="mt-4 flex items-center gap-2">
          {action ? (
            <Button variant="primary" onClick={action.onClick} leftIcon={action.icon}>
              {action.label}
            </Button>
          ) : null}
          {secondaryAction ? (
            <Button variant="secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export default EmptyState
