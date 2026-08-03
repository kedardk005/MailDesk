import { Loader2 } from 'lucide-react'
import { cn } from '../../lib/utils'

const sizes = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4', lg: 'h-5 w-5', xl: 'h-6 w-6' }

/**
 * Indeterminate spinner.
 *
 * @param {'xs'|'sm'|'md'|'lg'|'xl'} [size='md']
 * @param {string} [label='Loading'] - screen-reader text; pass '' inside a
 *                                     button that already has an accessible name.
 */
export function Spinner({ size = 'md', className, label = 'Loading', ...props }) {
  return (
    <>
      <Loader2
        aria-hidden="true"
        className={cn('animate-spin text-current', sizes[size] || sizes.md, className)}
        {...props}
      />
      {label ? <span className="sr-only">{label}</span> : null}
    </>
  )
}

/** Centered spinner for a whole pane. Appears after 250ms to avoid flashing. */
export function SpinnerBlock({ label = 'Loading', className }) {
  return (
    <div
      role="status"
      className={cn('flex items-center justify-center gap-2 py-12 text-fg-3', className)}
    >
      <Spinner size="lg" label="" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export default Spinner
