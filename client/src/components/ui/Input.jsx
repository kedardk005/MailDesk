import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'

export const controlVariants = cva(
  [
    'w-full rounded border bg-surface text-fg',
    'placeholder:text-fg-off',
    'transition-colors duration-100',
    'focus:outline-none focus-visible:outline-none',
    'disabled:bg-subtle disabled:text-fg-off disabled:cursor-not-allowed',
    'read-only:bg-subtle',
  ].join(' '),
  {
    variants: {
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-8 px-2.5 text-sm',
        lg: 'h-9 px-3 text-base',
      },
      invalid: {
        true: 'border-danger focus:border-danger focus:shadow-[0_0_0_3px_rgb(220_38_38/0.12)]',
        false:
          'border-line-strong hover:border-fg-off focus:border-primary-600 focus:shadow-[0_0_0_3px_rgb(37_99_235/0.12)]',
      },
    },
    defaultVariants: { size: 'md', invalid: false },
  }
)

/**
 * Text input.
 *
 * @param {'sm'|'md'|'lg'} [size='md']  heights 28 / 32 / 36
 * @param {boolean} [invalid] - red border + shadow; also set aria-invalid
 * @param {React.ReactNode} [leadingIcon]  - 16px lucide icon, adds left padding
 * @param {React.ReactNode} [trailingIcon] - e.g. a password eye toggle button
 *
 * Always pair with <Label htmlFor> or wrap in <FormField>.
 */
export const Input = forwardRef(function Input(
  { className, size = 'md', invalid = false, leadingIcon, trailingIcon, type = 'text', ...props },
  ref
) {
  const control = (
    <input
      ref={ref}
      type={type}
      aria-invalid={invalid || undefined}
      className={cn(
        controlVariants({ size, invalid }),
        leadingIcon && (size === 'sm' ? 'pl-7' : 'pl-8'),
        trailingIcon && (size === 'sm' ? 'pr-7' : 'pr-8'),
        className
      )}
      {...props}
    />
  )

  if (!leadingIcon && !trailingIcon) return control

  return (
    <div className="relative w-full">
      {leadingIcon ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-3 [&>svg]:h-4 [&>svg]:w-4"
        >
          {leadingIcon}
        </span>
      ) : null}
      {control}
      {trailingIcon ? (
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-3 [&>svg]:h-4 [&>svg]:w-4">
          {trailingIcon}
        </span>
      ) : null}
    </div>
  )
})

export default Input
