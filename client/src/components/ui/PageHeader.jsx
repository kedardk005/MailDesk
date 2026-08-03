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
        /* shrink-0: <main> is a flex column; without it the wrapped header
         * would be flex-shrunk to its min-height and overlap the content. */
        'flex min-h-[56px] shrink-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-canvas px-6 py-3',
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
        /* shrink-0 for the same reason as PageHeader: a toolbar whose filters
         * wrap to two rows must keep its wrapped height inside <main>'s column. */
        'flex min-h-[44px] shrink-0 flex-wrap items-center justify-between gap-2 border-b border-line bg-canvas px-6 py-2',
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

/**
 * Standard content wrapper — 24px horizontal, 20px top padding.
 *
 * @param {boolean} [fill=false] - scroll containment. The layout's <main> is a
 *        flex column; `fill` makes this body take exactly the remaining height
 *        (`flex-1 min-h-0`, itself a flex column) so a `<DataTable fill>` /
 *        `<TableContainer fill>` inside it becomes the page's only scroller.
 *        The page header, toolbar and pagination then never scroll away.
 *        `min-h-0` is load-bearing: without it a flex child refuses to shrink
 *        below its content height and the constraint silently does nothing.
 *        Containment is md-and-up on purpose: below `md` the stacked header,
 *        tabs and filters can eat the whole viewport and would squeeze the row
 *        area to nothing, so phones keep the plain scrolling page instead.
 */
export function PageBody({ fill = false, className, children, ...props }) {
  return (
    <div
      className={cn('px-6 py-5', fill && 'md:flex md:min-h-0 md:flex-1 md:flex-col', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export default PageHeader
