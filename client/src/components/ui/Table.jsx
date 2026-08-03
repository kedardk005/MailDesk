import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Low-level table primitives. For anything with sorting, selection or
 * pagination use <DataTable> instead — it composes these.
 *
 *   <TableContainer>
 *     <Table>
 *       <THead><TR><TH>Client</TH><TH numeric>Open</TH></TR></THead>
 *       <TBody><TR><TD>Acme</TD><TD numeric>12</TD></TR></TBody>
 *     </Table>
 *   </TableContainer>
 */

/** Rounded, bordered, clipping wrapper. No shadow. Provides the scroll context. */
export function TableContainer({ className, children, ...props }) {
  return (
    <div
      className={cn('overflow-auto rounded-lg border border-line bg-surface custom-scrollbar', className)}
      {...props}
    >
      {children}
    </div>
  )
}

export function Table({ className, ...props }) {
  return (
    <table
      className={cn('w-full border-collapse text-left text-sm', className)}
      {...props}
    />
  )
}

/** Sticky by default — `sticky top-0 z-[2]`. */
export function THead({ className, ...props }) {
  return (
    <thead
      className={cn('sticky top-0 z-[2] bg-canvas [&_tr]:border-b [&_tr]:border-line', className)}
      {...props}
    />
  )
}

export function TBody({ className, ...props }) {
  return <tbody className={cn('divide-y divide-line', className)} {...props} />
}

export function TFoot({ className, ...props }) {
  return (
    <tfoot className={cn('border-t border-line bg-canvas font-medium', className)} {...props} />
  )
}

/**
 * @param {boolean} [selected] - primary tint + left inset bar
 * @param {boolean} [interactive] - pointer cursor + hover fill
 * @param {'default'|'compact'|'relaxed'} [density='default'] - 40 / 32 / 48px
 */
export function TR({ className, selected = false, interactive = false, density = 'default', ...props }) {
  return (
    <tr
      data-selected={selected || undefined}
      aria-selected={selected || undefined}
      className={cn(
        density === 'compact' ? 'h-8' : density === 'relaxed' ? 'h-12' : 'h-10',
        'transition-colors duration-100',
        interactive && 'cursor-pointer',
        selected
          ? 'bg-primary-subtle shadow-[inset_2px_0_0_0_rgb(var(--primary-600))]'
          : 'hover:bg-canvas',
        'focus-within:outline focus-within:outline-2 focus-within:-outline-offset-2 focus-within:outline-primary-600',
        className
      )}
      {...props}
    />
  )
}

/**
 * Header cell.
 * @param {boolean} [numeric] - right-align
 * @param {'asc'|'desc'|false} [sorted] - drives aria-sort and the chevron. Works
 *        the same whether the sort state is local or server-owned: <DataTable>
 *        feeds this from its `sorting` state, so a controlled/server-sorted
 *        table announces `aria-sort` correctly with no extra sr-only text.
 * @param {Function} [onSort] - makes the header a button
 * @param {number|string} [width]
 */
export function TH({
  className,
  children,
  numeric = false,
  sorted,
  onSort,
  width,
  style,
  ...props
}) {
  const ariaSort = sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : onSort ? 'none' : undefined

  const label = (
    <span className={cn('inline-flex items-center gap-1', numeric && 'flex-row-reverse')}>
      {children}
      {onSort ? (
        sorted === 'asc' ? (
          <ChevronUp aria-hidden="true" className="h-3.5 w-3.5 text-fg-2" />
        ) : sorted === 'desc' ? (
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-fg-2" />
        ) : (
          <ChevronsUpDown aria-hidden="true" className="h-3.5 w-3.5 text-fg-off" />
        )
      ) : null}
    </span>
  )

  return (
    <th
      scope="col"
      aria-sort={ariaSort}
      style={{ width, ...style }}
      className={cn(
        'h-9 whitespace-nowrap px-3 text-2xs font-semibold uppercase tracking-[0.04em] text-fg-2',
        numeric ? 'text-right' : 'text-left',
        className
      )}
      {...props}
    >
      {onSort ? (
        <button
          type="button"
          onClick={onSort}
          className="inline-flex items-center gap-1 rounded-sm hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600"
        >
          {label}
        </button>
      ) : (
        label
      )}
    </th>
  )
}

/**
 * Body cell.
 * @param {boolean} [numeric] - right-aligned + tabular figures
 * @param {boolean} [truncate=true]
 * @param {boolean} [primary] - weight 500, text-fg (the row's identifying cell)
 */
export function TD({ className, numeric = false, truncate = true, primary = false, ...props }) {
  return (
    <td
      className={cn(
        'px-3 align-middle text-sm',
        numeric ? 'text-right tabular' : 'text-left',
        primary ? 'font-medium text-fg' : 'text-fg-2',
        truncate && 'max-w-0 truncate',
        className
      )}
      {...props}
    />
  )
}

/** Sticky right-hand actions column (width 88 by default). */
export function TDActions({ className, children, ...props }) {
  return (
    <td
      className={cn(
        'sticky right-0 w-[88px] bg-inherit px-2 text-right align-middle',
        className
      )}
      {...props}
    >
      <div className="flex items-center justify-end gap-1">{children}</div>
    </td>
  )
}

/** Full-width message row (empty / error states inside a table). */
export function TableMessageRow({ colSpan, children }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-12 text-center">
        {children}
      </td>
    </tr>
  )
}

export default Table
