import { useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { cn } from '../../lib/utils'
import { Checkbox } from './Checkbox'
import { EmptyState } from './EmptyState'
import { Pagination } from './Pagination'
import { SkeletonTable } from './Skeleton'
import { Table, TBody, TableContainer, TD, TH, THead, TR } from './Table'

/**
 * Anything inside a cell that handles its own activation. A click originating
 * here must not also fire the row's onClick — see the row onClick below.
 */
const INTERACTIVE_IN_CELL =
  'button, a[href], input, select, textarea, label, [role="button"], [role="menuitem"], [role="checkbox"], [contenteditable="true"]'

/**
 * DataTable — TanStack Table v8, headless, plain JSX.
 *
 * Dense by default: 36px sticky header, 40px rows, right-aligned numerics with
 * tabular figures, hover fill, selection tint, no zebra (borders are enough).
 *
 * @param {Array<object>} data
 * @param {Array<import('@tanstack/react-table').ColumnDef>} columns
 *        Column meta the table understands:
 *          meta.numeric  {boolean}  right-align + tabular
 *          meta.primary  {boolean}  weight 500 / text-fg (the identifying cell)
 *          meta.width    {string}   e.g. '160px'
 *          meta.truncate {boolean}  default true
 *          meta.rowOpener {boolean} with rowActivation="cell", this column's
 *                                   cell becomes the row's opener button
 * @param {boolean} [loading]
 * @param {boolean} [enableSelection] - adds a checkbox column with a real
 *        indeterminate header state
 * @param {object} [rowSelection] / @param {Function} [onRowSelectionChange]
 *        Controlled selection. Omit both to let the table own it.
 * @param {(row:object)=>string} [getRowId]
 * @param {(row:object)=>void} [onRowClick]
 * @param {'none'|'row'|'cell'} [rowActivation='none'] - how a row is opened from
 *        the KEYBOARD. `none` (the default) is the historical behaviour: the row
 *        is mouse-clickable only, which is correct when the page already renders
 *        its own focusable control inside a cell. `row` makes the `<tr>` itself
 *        focusable and Enter/Space activate it. `cell` wraps the opener column's
 *        cell in a real `<button data-row-open>` (the accessible default for new
 *        code). See the block comment on ROW ACTIVATION below.
 * @param {'compact'|'default'|'relaxed'} [density='default'] - 32 / 40 / 48px
 * @param {boolean|object} [pagination=false] - true for client-side paging, or
 *        `{ page, pageSize, total, onPageChange, onPageSizeChange }` for server-side
 * @param {object} [emptyState] - props forwarded to <EmptyState>
 * @param {string} [ariaLabel] - REQUIRED when there is no visible caption
 * @param {Array<{id:string,desc:boolean}>} [initialSorting] - UNcontrolled seed
 * @param {Array<{id:string,desc:boolean}>} [sorting] - CONTROLLED sorting. When
 *        supplied the table is server-sorted: `getSortedRowModel` is not
 *        installed, `manualSorting` is on, and header clicks are emitted through
 *        `onSortingChange` instead of mutating internal state. `aria-sort` is
 *        still driven off this state, so headers stay announced correctly.
 * @param {(sorting:Array)=>void} [onSortingChange] - receives the resolved next
 *        sorting array (never a TanStack updater function)
 * @param {boolean} [manualSorting] - explicit override; defaults to `true` when
 *        `sorting` is controlled and `false` otherwise
 * @param {boolean} [fill] - scroll containment: stretch to the remaining height
 *        of a flex column (`<PageBody fill>`) so the rows scroll inside the
 *        table while header and pagination stay put
 */
export function DataTable({
  data = [],
  columns = [],
  loading = false,
  enableSelection = false,
  rowSelection: rowSelectionProp,
  onRowSelectionChange,
  getRowId,
  onRowClick,
  rowActivation = 'none',
  density = 'default',
  pagination = false,
  emptyState,
  ariaLabel,
  fill = false,
  className,
  containerClassName,
  initialSorting = [],
  sorting: sortingProp,
  onSortingChange,
  manualSorting: manualSortingProp,
}) {
  const [internalSorting, setInternalSorting] = useState(initialSorting)
  const [internalSelection, setInternalSelection] = useState({})

  /* Controlled sorting: `sorting` present => the caller owns it and the data is
   * already ordered by the server. Without it nothing changes. */
  const sortingControlled = sortingProp !== undefined
  const sorting = sortingControlled ? sortingProp : internalSorting
  const manualSorting = manualSortingProp ?? sortingControlled

  const handleSortingChange = (updater) => {
    const next = typeof updater === 'function' ? updater(sorting) : updater
    if (!sortingControlled) setInternalSorting(next)
    onSortingChange?.(next)
  }

  const selection = rowSelectionProp ?? internalSelection
  const setSelection = onRowSelectionChange ?? setInternalSelection

  const serverPagination = pagination && typeof pagination === 'object'
  const clientPagination = pagination === true

  const allColumns = useMemo(() => {
    if (!enableSelection) return columns
    return [
      {
        id: '__select',
        size: 36,
        meta: { width: '36px', truncate: false },
        header: ({ table }) => (
          <Checkbox
            size="sm"
            aria-label="Select all rows on this page"
            checked={
              table.getIsAllPageRowsSelected()
                ? true
                : table.getIsSomePageRowsSelected()
                  ? 'indeterminate'
                  : false
            }
            onCheckedChange={(v) => table.toggleAllPageRowsSelected(Boolean(v))}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            size="sm"
            aria-label={`Select row ${row.index + 1}`}
            checked={row.getIsSelected()}
            onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
          />
        ),
        enableSorting: false,
      },
      ...columns,
    ]
  }, [columns, enableSelection])

  /* ROW ACTIVATION
   * ---------------------------------------------------------------------
   * `onRowClick` alone gives a mouse-only affordance. `rowActivation` adds the
   * keyboard path, and it is opt-in precisely because two pages (EmailInbox,
   * TaskList) already render their own `<button data-row-open>` inside a cell
   * and drive j/k by moving DOM focus to it. Turning row-level activation on by
   * default would have produced a focusable <tr> wrapping a focusable cell —
   * two tab stops per row and a double activation on Enter. */
  const rowInteractive = Boolean(onRowClick)
  const keyboardRow = rowInteractive && rowActivation === 'row'
  const keyboardCell = rowInteractive && rowActivation === 'cell'

  /* The column whose cell becomes the opener button in `cell` mode:
   * `meta.rowOpener` wins, otherwise the first `meta.primary` column. */
  const openerColumnId = useMemo(() => {
    if (!keyboardCell) return null
    const pick =
      allColumns.find((c) => c.meta?.rowOpener) || allColumns.find((c) => c.meta?.primary)
    return pick ? (pick.id ?? pick.accessorKey ?? null) : null
  }, [allColumns, keyboardCell])

  /*
   * React Compiler reports that it skips memoizing this component because
   * `useReactTable()` returns functions it cannot safely memoize. That is
   * informational and expected for TanStack Table — not a defect here, and not
   * something this codebase can fix without dropping the library.
   *
   * Suppressed at the single call site rather than by loosening CI's
   * `--max-warnings=0`, so the gate keeps catching every OTHER warning. If
   * TanStack ever becomes compiler-compatible, deleting this line is the test.
   */
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns: allColumns,
    state: { sorting, rowSelection: selection },
    onSortingChange: handleSortingChange,
    onRowSelectionChange: setSelection,
    enableRowSelection: enableSelection,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    /* Server-sorted tables must NOT re-sort the visible page locally. */
    ...(manualSorting ? {} : { getSortedRowModel: getSortedRowModel() }),
    getFilteredRowModel: getFilteredRowModel(),
    ...(clientPagination ? { getPaginationRowModel: getPaginationRowModel() } : {}),
    manualSorting,
    manualPagination: serverPagination,
  })

  const rows = table.getRowModel().rows
  const colCount = allColumns.length

  /* An empty table has nothing to scroll, and containing it actively hurts:
   * the empty state is taller than a row, so `flex-1` + `overflow-auto` clipped
   * it against the remaining height. Measured on /inbox at 1280x720 with a
   * filter that matches nothing: the "Clear filters" CTA sat at y 596-628
   * inside a scroller whose visible area ended at exactly 596 — zero pixels of
   * the button on screen, reachable only by scrolling the inner box that
   * appeared to hold no content. So when there are no rows the table opts out
   * of containment entirely and the empty state sits in normal page flow, where
   * <main> scrolls it if the window is short. Scroll containment exists to keep
   * a sticky header and pinned pagination over a long row list; with zero rows
   * there is no row list, no sticky header to preserve and no pagination. */
  const isEmpty = !loading && rows.length === 0

  return (
    /* `fill` — scroll containment: inside a flex column (`<PageBody fill>`)
     * the table takes the remaining height, the rows scroll inside
     * <TableContainer>, and the <Pagination> below stays pinned in view. */
    <div
      className={cn(
        'flex flex-col',
        /* `min-h-0` lets a flex item shrink below its content. That is what
         * makes the rows scroll — and exactly what must NOT happen to an empty
         * state, which has no scroller of its own to fall back on. */
        !isEmpty && 'min-h-0',
        fill && !isEmpty && 'flex-1',
        className
      )}
      data-empty={isEmpty ? 'true' : undefined}
    >
      <TableContainer className={cn(!isEmpty && 'min-h-0 flex-1', containerClassName)}>
        {loading ? (
          <SkeletonTable rows={6} columns={Math.min(colCount, 6)} />
        ) : (
          <Table aria-label={ariaLabel}>
            <THead>
              {table.getHeaderGroups().map((hg) => (
                <TR key={hg.id} className="hover:bg-canvas">
                  {hg.headers.map((header) => {
                    const meta = header.column.columnDef.meta || {}
                    const canSort = header.column.getCanSort()
                    return (
                      <TH
                        key={header.id}
                        numeric={meta.numeric}
                        width={meta.width}
                        sorted={header.column.getIsSorted()}
                        onSort={canSort ? header.column.getToggleSortingHandler() : undefined}
                      >
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </TH>
                    )
                  })}
                </TR>
              ))}
            </THead>

            <TBody>
              {isEmpty ? null : (
                rows.map((row) => (
                  <TR
                    key={row.id}
                    density={density}
                    selected={row.getIsSelected()}
                    interactive={rowInteractive}
                    onClick={
                      rowInteractive
                        ? (e) => {
                            /*
                             * Ignore clicks that originated on an interactive
                             * descendant. The keydown guard above only sees
                             * `keydown`, but activating a nested <button> with
                             * Enter or Space synthesises a CLICK that bubbles to
                             * the row — so a row-action menu or the opener
                             * button fired twice. Pages were compensating with
                             * their own stopPropagation calls; this makes the
                             * primitive honour its own contract instead.
                             */
                            if (e.target !== e.currentTarget && e.target.closest?.(INTERACTIVE_IN_CELL)) return
                            onRowClick(row.original, row)
                          }
                        : undefined
                    }
                    tabIndex={keyboardRow ? 0 : undefined}
                    data-row-open={keyboardRow ? row.id : undefined}
                    onKeyDown={
                      keyboardRow
                        ? (e) => {
                            /* Only when the row itself has focus — an Enter on a
                             * button inside a cell must not activate twice. */
                            if (e.target !== e.currentTarget) return
                            if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                              e.preventDefault()
                              onRowClick(row.original, row)
                            }
                          }
                        : undefined
                    }
                  >
                    {row.getVisibleCells().map((cell) => {
                      const meta = cell.column.columnDef.meta || {}
                      const isOpener = keyboardCell && cell.column.id === openerColumnId
                      const content = flexRender(cell.column.columnDef.cell, cell.getContext())
                      return (
                        <TD
                          key={cell.id}
                          numeric={meta.numeric}
                          primary={meta.primary}
                          truncate={meta.truncate !== false}
                          style={meta.width ? { width: meta.width } : undefined}
                          onClick={
                            cell.column.id === '__select' ? (e) => e.stopPropagation() : undefined
                          }
                        >
                          {isOpener ? (
                            <button
                              type="button"
                              data-row-open={row.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                onRowClick(row.original, row)
                              }}
                              className="block w-full truncate rounded-sm text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary-600"
                            >
                              {content}
                            </button>
                          ) : (
                            content
                          )}
                        </TD>
                      )
                    })}
                  </TR>
                ))
              )}
            </TBody>
          </Table>
        )}

        {/* Sibling of <table>, not a `<td colSpan>` inside it. As a message row
          * the state carried the cell's own `py-12` on top of EmptyState's, so
          * a 230px block occupied 326px of a 240px scroller. Here it is laid
          * out by the container, keeps the column headers above it for context,
          * and its CTA is always on screen. */}
        {isEmpty ? (
          <EmptyState
            title="Nothing to show"
            description="No records match the current view."
            {...emptyState}
          />
        ) : null}
      </TableContainer>

      {serverPagination ? (
        <Pagination {...pagination} className="rounded-b-lg border-x border-b border-line" />
      ) : clientPagination ? (
        <Pagination
          className="rounded-b-lg border-x border-b border-line"
          page={table.getState().pagination.pageIndex + 1}
          pageSize={table.getState().pagination.pageSize}
          total={data.length}
          onPageChange={(p) => table.setPageIndex(p - 1)}
          onPageSizeChange={(s) => table.setPageSize(s)}
        />
      ) : null}
    </div>
  )
}

export default DataTable
