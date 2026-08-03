import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

/**
 * Multi-line text control. min-height 72px, vertical resize only.
 *
 * @param {boolean} [invalid]
 * @param {number} [rows=4]
 */
export const Textarea = forwardRef(function Textarea(
  { className, invalid = false, rows = 4, ...props },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full min-h-[72px] resize-y rounded border bg-surface px-2.5 py-2 text-sm text-fg',
        'placeholder:text-fg-off transition-colors duration-100',
        'focus:outline-none focus-visible:outline-none',
        'disabled:bg-subtle disabled:text-fg-off disabled:cursor-not-allowed',
        invalid
          ? 'border-danger focus:border-danger focus:shadow-[0_0_0_3px_rgb(220_38_38/0.12)]'
          : 'border-line-strong hover:border-fg-off focus:border-primary-600 focus:shadow-[0_0_0_3px_rgb(37_99_235/0.12)]',
        className
      )}
      {...props}
    />
  )
})

export default Textarea
