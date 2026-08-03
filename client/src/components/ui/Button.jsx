import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import { cn } from '../../lib/utils'
import { Spinner } from './Spinner'

/**
 * Button — the single control primitive for the whole app.
 *
 * Sizes (height / padding-x / font):  sm 28/8/12  ·  md 32/12/13  ·  lg 36/16/14
 * Loading swaps the leading icon for a spinner and KEEPS the label, so the
 * button never changes width mid-request.
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium',
    'transition-colors duration-100 select-none',
    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2',
    'focus-visible:outline-primary-600',
    'disabled:pointer-events-none disabled:cursor-not-allowed',
  ].join(' '),
  {
    variants: {
      variant: {
        primary:
          'bg-primary-600 text-primary-fg hover:bg-primary-700 active:bg-primary-800 disabled:bg-primary-200 disabled:text-primary-fg',
        secondary:
          'bg-surface text-fg-2 border border-line-strong hover:bg-canvas active:bg-subtle disabled:text-fg-off disabled:border-line',
        ghost:
          'bg-transparent text-fg-2 hover:bg-subtle active:bg-muted disabled:text-fg-off',
        danger:
          'bg-danger text-white hover:bg-danger-text active:bg-danger-text disabled:opacity-50',
        'danger-ghost':
          'bg-transparent text-danger-text hover:bg-danger-subtle active:bg-danger-subtle disabled:text-fg-off',
        link: 'bg-transparent text-primary-600 underline-offset-4 hover:underline hover:text-primary-700 disabled:text-fg-off px-0 h-auto',
      },
      size: {
        sm: 'h-7 px-2 text-xs',
        md: 'h-8 px-3 text-sm',
        lg: 'h-9 px-4 text-base',
      },
      iconOnly: {
        true: 'p-0',
        false: '',
      },
      fullWidth: {
        true: 'w-full',
        false: '',
      },
    },
    compoundVariants: [
      { iconOnly: true, size: 'sm', class: 'w-7 h-7' },
      { iconOnly: true, size: 'md', class: 'w-8 h-8' },
      { iconOnly: true, size: 'lg', class: 'w-9 h-9' },
    ],
    defaultVariants: { variant: 'secondary', size: 'md', iconOnly: false, fullWidth: false },
  }
)

/**
 * @param {'primary'|'secondary'|'ghost'|'danger'|'danger-ghost'|'link'} [variant='secondary']
 * @param {'sm'|'md'|'lg'} [size='md']
 * @param {boolean} [loading] - shows a spinner, disables the button, sets aria-busy
 * @param {React.ReactNode} [leftIcon]  - 14/16px lucide icon, before the label
 * @param {React.ReactNode} [rightIcon]
 * @param {boolean} [iconOnly] - square button. Pass the icon as `children` and
 *        omit the label; `aria-label` becomes REQUIRED.
 * @param {boolean} [fullWidth]
 * @param {React.ElementType} [as='button'] - render as another element (e.g. Link)
 */
export const Button = forwardRef(function Button(
  {
    className,
    variant,
    size,
    loading = false,
    disabled = false,
    leftIcon,
    rightIcon,
    iconOnly = false,
    fullWidth = false,
    children,
    type = 'button',
    as: Component = 'button',
    ...props
  },
  ref
) {
  const isDisabled = disabled || loading

  if (import.meta.env?.DEV && iconOnly && !props['aria-label']) {
    console.warn('[Button] iconOnly buttons must have an aria-label.')
  }

  return (
    <Component
      ref={ref}
      type={Component === 'button' ? type : undefined}
      disabled={Component === 'button' ? isDisabled : undefined}
      aria-disabled={Component === 'button' ? undefined : isDisabled || undefined}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, iconOnly, fullWidth }), className)}
      {...props}
    >
      {loading ? <Spinner size={size === 'lg' ? 'md' : 'sm'} label="" /> : leftIcon || null}
      {children}
      {!loading && rightIcon}
    </Component>
  )
})

export { buttonVariants }
export default Button
