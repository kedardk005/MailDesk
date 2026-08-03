import { cn } from '../../lib/utils'

/**
 * Sticky page header — 56px, holds the single <h1> for the screen, an optional
 * breadcrumb, and the primary action.
 *
 *   <PageHeader
 *     title="Tasks"
 *     description="Everything assigned across the office"
 *     actions={<Button variant="primary" leftIcon={<Plus />}>New task</Button>}
 *   />
 *
 * @param {string} title - one per screen, 20/28 weight 600
 * @param {React.ReactNode} [description]
 * @param {React.ReactNode} [breadcrumb]
 * @param {React.ReactNode} [actions] - right-aligned
 * @param {boolean} [sticky=true]
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  sticky = true,
  className,
  children,
  ...props
}) {
  return (
    <header
      className={cn(
        'flex min-h-[56px] flex-wrap items-center justify-between gap-3 border-b border-line bg-canvas px-6 py-3',
        sticky && 'sticky top-0 z-sticky',
        className
      )}
      {...props}
    >
      <div className="min-w-0">
        {breadcrumb ? <div className="mb-0.5 text-xs text-fg-3">{breadcrumb}</div> : null}
        <h1 className="truncate text-xl font-semibold text-fg">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-fg-3">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      {children}
    </header>
  )
}

/**
 * Sticky toolbar strip that sits directly below a PageHeader.
 * Height 44, filters left, search/actions right.
 */
export function Toolbar({ left, right, className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex min-h-[44px] flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-6 py-2',
        className
      )}
      {...props}
    >
      {children || (
        <>
          <div className="flex flex-wrap items-center gap-2">{left}</div>
          <div className="flex flex-wrap items-center gap-2">{right}</div>
        </>
      )}
    </div>
  )
}

/** Standard content wrapper — 24px horizontal, 20px top padding. */
export function PageBody({ className, children, ...props }) {
  return (
    <div className={cn('px-6 py-5', className)} {...props}>
      {children}
    </div>
  )
}

export default PageHeader
