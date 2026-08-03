import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * Status badge — height 20, radius 4, 11/16 weight 600, 1px border.
 *
 * ALWAYS text + colour (never colour alone) so it stays colourblind-safe.
 * An optional 12px leading icon adds a second non-colour channel.
 *
 * Role convention: Employee = neutral · Head = info · Admin = warning.
 * `danger` is reserved for destructive / error states — never for a role.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-sm border font-semibold whitespace-nowrap [&>svg]:h-3 [&>svg]:w-3 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        neutral: 'bg-neutral-subtle text-neutral-text border-neutral-border',
        info: 'bg-info-subtle text-info-text border-info-border',
        success: 'bg-success-subtle text-success-text border-success-border',
        warning: 'bg-warning-subtle text-warning-text border-warning-border',
        danger: 'bg-danger-subtle text-danger-text border-danger-border',
        primary: 'bg-primary-subtle text-primary-text border-primary-border',
        outline: 'bg-transparent text-fg-2 border-line-strong',
      },
      size: {
        sm: 'h-4 px-1 text-2xs',
        md: 'h-5 px-1.5 text-2xs',
        lg: 'h-6 px-2 text-xs',
      },
    },
    defaultVariants: { variant: 'neutral', size: 'md' },
  }
)

/**
 * @param {'neutral'|'info'|'success'|'warning'|'danger'|'primary'|'outline'} [variant='neutral']
 * @param {'sm'|'md'|'lg'} [size='md']
 * @param {React.ReactNode} [icon] - 12px lucide icon rendered before the label
 * @param {boolean} [dot] - small leading dot; only permitted alongside a text label
 */
export function Badge({ className, variant, size, icon, dot = false, children, ...props }) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot ? (
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      ) : null}
      {icon}
      {children}
    </span>
  )
}

/**
 * Numeric count chip (unread counts, tab counts).
 * min-width 18, height 18, tabular figures.
 */
export function CountBadge({ count, max = 99, className, variant = 'primary', ...props }) {
  const n = Number(count) || 0
  if (n <= 0) return null
  return (
    <span
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-2xs font-semibold tabular',
        variant === 'danger'
          ? 'bg-danger text-white'
          : variant === 'neutral'
            ? 'bg-muted text-fg-2'
            : 'bg-primary-600 text-primary-fg',
        className
      )}
      {...props}
    >
      {n > max ? `${max}+` : n}
    </span>
  )
}

export { badgeVariants }
export default Badge
