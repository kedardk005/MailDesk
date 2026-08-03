import { forwardRef } from 'react'
import { cn } from '../../lib/utils'

/**
 * Form label — 12/16, weight 500, sentence case, `text-fg-2`.
 * NOT uppercase, NOT 10px, NOT `text-slate-400` (2.85:1 — fails AA).
 *
 * @param {string} htmlFor - REQUIRED. Must match the control's id.
 * @param {boolean} [required] - renders a danger asterisk
 * @param {string} [optionalText] - e.g. "(optional)" when most fields are required
 */
export const Label = forwardRef(function Label(
  { className, children, required = false, optionalText, ...props },
  ref
) {
  return (
    <label
      ref={ref}
      className={cn('block text-xs font-medium leading-4 text-fg-2', className)}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-0.5 text-danger" aria-hidden="true">
          *
        </span>
      ) : null}
      {optionalText ? (
        <span className="ml-1 font-normal text-fg-3">{optionalText}</span>
      ) : null}
    </label>
  )
})

export default Label
