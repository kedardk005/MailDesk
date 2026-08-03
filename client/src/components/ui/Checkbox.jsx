import { forwardRef } from 'react'
import * as RadixCheckbox from '@radix-ui/react-checkbox'
import { Check, Minus } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Checkbox with a real indeterminate state (needed by table "select all").
 *
 * @param {boolean|'indeterminate'} checked
 * @param {(checked:boolean)=>void} onCheckedChange
 * @param {string} [label] - renders an associated <label>; omit only when the
 *                           checkbox has an aria-label (e.g. inside a table row)
 * @param {'sm'|'md'} [size='md'] - 14px / 16px box
 */
export const Checkbox = forwardRef(function Checkbox(
  { className, label, id, size = 'md', description, ...props },
  ref
) {
  const box = (
    <RadixCheckbox.Root
      ref={ref}
      id={id}
      className={cn(
        'peer inline-flex shrink-0 items-center justify-center rounded-xs border border-line-strong bg-surface',
        'transition-colors duration-100',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600',
        'data-[state=checked]:border-primary-600 data-[state=checked]:bg-primary-600',
        'data-[state=indeterminate]:border-primary-600 data-[state=indeterminate]:bg-primary-600',
        'disabled:cursor-not-allowed disabled:bg-subtle disabled:border-line',
        size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4',
        className
      )}
      {...props}
    >
      <RadixCheckbox.Indicator className="flex items-center justify-center text-white">
        {props.checked === 'indeterminate' ? (
          <Minus className="h-3 w-3" strokeWidth={3} />
        ) : (
          <Check className="h-3 w-3" strokeWidth={3} />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  )

  if (!label) return box

  return (
    <div className="flex items-start gap-2">
      {box}
      <div className="min-w-0">
        <label
          htmlFor={id}
          className="cursor-pointer select-none text-sm text-fg-2 peer-disabled:cursor-not-allowed peer-disabled:text-fg-off"
        >
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-fg-3">{description}</p> : null}
      </div>
    </div>
  )
})

export default Checkbox
