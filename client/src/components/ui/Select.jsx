import { forwardRef } from 'react'
import * as RadixSelect from '@radix-ui/react-select'
import { Check, ChevronDown, ChevronUp } from 'lucide-react'
import { cn } from '../../lib/utils'
import { controlVariants } from './Input'

/**
 * Native <select>. Use this for <= 10 flat options — it is faster, works on
 * mobile, and needs no portal.
 *
 * `className` sizes the WRAPPER, not the <select>. The chevron is absolutely
 * positioned against the wrapper, so if a width lands on the <select> while the
 * wrapper stays full-width, the chevron detaches and floats to the right of the
 * control — which is exactly what every `className="w-[140px]"` caller used to
 * render. The <select> now always fills its wrapper, so one width class styles
 * both and they can no longer disagree.
 *
 * Use `selectClassName` for the rare case of styling the <select> itself.
 *
 * @param {Array<{value:string,label:string,disabled?:boolean}>} [options]
 * @param {string} [placeholder] - rendered as a disabled empty-value option
 * @param {'sm'|'md'|'lg'} [size='md']
 * @param {boolean} [invalid]
 * @param {string} [className] - wrapper classes (width/layout)
 * @param {string} [selectClassName] - classes for the <select> element
 */
export const Select = forwardRef(function Select(
  { className, selectClassName, size = 'md', invalid = false, options, placeholder, children, ...props },
  ref
) {
  return (
    // tailwind-merge lets a caller's `w-[140px]` override this `w-full`.
    <div className={cn('relative w-full', className)}>
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          controlVariants({ size, invalid }),
          'w-full appearance-none bg-none pr-8',
          selectClassName
        )}
        {...props}
      >
        {placeholder ? (
          <option value="">{placeholder}</option>
        ) : null}
        {options
          ? options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-3"
      />
    </div>
  )
})

/* ---------------------------------------------------------------------------
 * SelectMenu — Radix version, for grouped / long / richly-rendered option sets.
 * ------------------------------------------------------------------------ */

/**
 * @param {string} value
 * @param {(value:string)=>void} onValueChange
 * @param {Array<{value:string,label:string,disabled?:boolean,group?:string}>} options
 * @param {string} [placeholder='Select…']
 * @param {'sm'|'md'|'lg'} [size='md']
 * @param {string} [ariaLabel] - required when there is no associated <Label>
 */
export function SelectMenu({
  value,
  onValueChange,
  options = [],
  placeholder = 'Select…',
  size = 'md',
  invalid = false,
  disabled = false,
  className,
  contentClassName,
  ariaLabel,
  id,
  ...props
}) {
  const groups = options.reduce((acc, o) => {
    const key = o.group || ''
    if (!acc[key]) acc[key] = []
    acc[key].push(o)
    return acc
  }, {})

  return (
    <RadixSelect.Root value={value} onValueChange={onValueChange} disabled={disabled} {...props}>
      <RadixSelect.Trigger
        id={id}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(
          controlVariants({ size, invalid }),
          'flex items-center justify-between gap-2 text-left',
          'data-[placeholder]:text-fg-off',
          className
        )}
      >
        <RadixSelect.Value placeholder={placeholder} />
        <RadixSelect.Icon asChild>
          <ChevronDown className="h-4 w-4 shrink-0 text-fg-3" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>

      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className={cn(
            'z-dropdown max-h-72 min-w-[--radix-select-trigger-width] overflow-hidden',
            'rounded-lg border border-line-overlay bg-elevated shadow-md',
            'data-[state=open]:animate-fade-in',
            contentClassName
          )}
        >
          <RadixSelect.ScrollUpButton className="flex h-6 items-center justify-center text-fg-3">
            <ChevronUp className="h-4 w-4" />
          </RadixSelect.ScrollUpButton>
          <RadixSelect.Viewport className="p-1">
            {Object.entries(groups).map(([group, items]) => (
              <RadixSelect.Group key={group || '_'}>
                {group ? (
                  <RadixSelect.Label className="px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-fg-3">
                    {group}
                  </RadixSelect.Label>
                ) : null}
                {items.map((o) => (
                  <RadixSelect.Item
                    key={o.value}
                    value={o.value}
                    disabled={o.disabled}
                    className={cn(
                      'relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 pr-7 text-sm text-fg-2 outline-none',
                      'data-[highlighted]:bg-elevated-subtle data-[highlighted]:text-fg',
                      'data-[state=checked]:text-fg data-[state=checked]:font-medium',
                      'data-[disabled]:text-fg-off data-[disabled]:pointer-events-none'
                    )}
                  >
                    <RadixSelect.ItemText>{o.label}</RadixSelect.ItemText>
                    <RadixSelect.ItemIndicator className="absolute right-2">
                      <Check className="h-3.5 w-3.5 text-primary-600" />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Group>
            ))}
          </RadixSelect.Viewport>
          <RadixSelect.ScrollDownButton className="flex h-6 items-center justify-center text-fg-3">
            <ChevronDown className="h-4 w-4" />
          </RadixSelect.ScrollDownButton>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}

export default Select
