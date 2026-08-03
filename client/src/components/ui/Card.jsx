import { isValidElement } from 'react'

import { cn } from '../../lib/utils'

/**
 * True when `x` can be used as `<x />`.
 *
 * A `typeof x === 'function'` test is NOT sufficient: lucide-react v1 exports
 * its icons as `forwardRef` results, which are plain objects carrying a
 * `$$typeof` of `Symbol(react.forward_ref)`. Under the function-only test an
 * icon fell through to being rendered as a *child*, and React threw
 * "Objects are not valid as a React child" — which white-screened the
 * Dashboard. `memo()` results have the same shape.
 *
 * @param {*} x
 * @returns {Boolean}
 */
const isComponentType = (x) =>
  typeof x === 'function' || (typeof x === 'object' && x !== null && '$$typeof' in x)

/**
 * Panel primitive. Elevation comes from a 1px border on a surface fill —
 * NOT from a shadow, and never from a coloured glow.
 *
 *   <Card>
 *     <CardHeader title="Connections" actions={<Button size="sm">Add</Button>} />
 *     <CardBody>…</CardBody>
 *     <CardFooter>…</CardFooter>
 *   </Card>
 */
export function Card({ className, children, ...props }) {
  return (
    <div
      className={cn('rounded-lg border border-line bg-surface', className)}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * @param {React.ReactNode} title
 * @param {React.ReactNode} [description]
 * @param {React.ReactNode} [actions] - right-aligned controls
 */
export function CardHeader({ title, description, actions, className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex min-h-[44px] items-center justify-between gap-3 border-b border-line px-4 py-2.5',
        className
      )}
      {...props}
    >
      {children || (
        <>
          <div className="min-w-0">
            {title ? <h2 className="truncate text-base font-semibold text-fg">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-xs text-fg-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </>
      )}
    </div>
  )
}

export function CardBody({ className, children, ...props }) {
  return (
    <div className={cn('p-4', className)} {...props}>
      {children}
    </div>
  )
}

export function CardFooter({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex min-h-[48px] items-center justify-end gap-2 border-t border-line bg-canvas px-4 py-2',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

/**
 * KPI tile. Flat by design: no icon *tile*, no accent border, no hover lift,
 * no count-up animation. The number must be correct the instant it paints.
 *
 *   <StatTile label="Overdue" value={formatNumber(12)} tone="danger" />
 *
 *   // a tile that navigates — no <Link> wrapper needed, and the whole tile
 *   // becomes one focusable control instead of a div inside an anchor:
 *   <StatTile as={Link} to="/tasks?status=Late" icon={Clock}
 *             label="Overdue" value={formatNumber(12)} />
 *
 * @param {React.ReactNode} label - plain text; you no longer need to smuggle an
 *        icon in here as a node (use `icon`)
 * @param {React.ReactNode} value - already formatted (use formatNumber)
 * @param {{value:string, direction:'up'|'down'|'flat', tone?:'success'|'danger'|'neutral'}} [delta]
 * @param {string} [hint]
 * @param {'default'|'danger'} [tone] - `danger` renders the value in danger text
 * @param {React.ElementType|React.ReactNode} [icon] - a lucide COMPONENT
 *        (`icon={Inbox}`) or a ready-made element. Rendered inline beside the
 *        label at 14px, never in a coloured tile.
 * @param {React.ElementType} [as='div'] - e.g. `Link` or `'a'`. The ui layer
 *        stays router-free, so pass the component in exactly as <Button> does.
 * @param {string} [to] / @param {string} [href] - forwarded when set
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
  tone = 'default',
  icon,
  as: Comp = 'div',
  to,
  href,
  className,
  ...props
}) {
  const interactive = Comp !== 'div'
  // Accept BOTH documented forms: a component type (`icon={Inbox}`) and an
  // already-created element (`icon={<Inbox className="…" />}`). An element must
  // be checked first — it is an object, so isComponentType would match it too.
  const iconIsElement = isValidElement(icon)
  const Icon = !iconIsElement && isComponentType(icon) ? icon : null

  return (
    <Comp
      {...(to !== undefined ? { to } : null)}
      {...(href !== undefined ? { href } : null)}
      className={cn(
        'rounded-lg border border-line bg-surface px-4 py-3',
        interactive &&
          'block transition-colors hover:border-line-strong hover:bg-subtle/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600',
        className
      )}
      {...props}
    >
      {/* Without an icon this stays exactly the element it always was. */}
      <p
        className={cn(
          'text-2xs font-semibold uppercase tracking-wide text-fg-3',
          icon && 'flex items-center gap-1.5'
        )}
      >
        {Icon ? (
          <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        ) : iconIsElement ? (
          icon
        ) : null}
        {label}
      </p>
      <p
        className={cn(
          'mt-1 text-2xl font-semibold tabular',
          tone === 'danger' ? 'text-danger-text' : 'text-fg'
        )}
      >
        {value}
      </p>
      {delta ? (
        <p
          className={cn(
            'mt-1 text-xs font-medium tabular',
            delta.tone === 'danger'
              ? 'text-danger-text'
              : delta.tone === 'success'
                ? 'text-success-text'
                : 'text-fg-3'
          )}
        >
          {delta.direction === 'up' ? '▲ ' : delta.direction === 'down' ? '▼ ' : ''}
          {delta.value}
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-fg-3">{hint}</p> : null}
    </Comp>
  )
}

export default Card
