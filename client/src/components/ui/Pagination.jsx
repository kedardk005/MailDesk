import { useId } from 'react'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'
import { cn, formatNumber } from '../../lib/utils'
import { Button } from './Button'
import { Select } from './Select'

const PAGE_SIZES = [25, 50, 100]

/**
 * Pagination bar — height 44, sits at the bottom of a table container.
 * Page state SHOULD be mirrored into the URL query string.
 *
 * @param {number} page - 1-based
 * @param {number} pageSize
 * @param {number} total - total rows across all pages
 * @param {(page:number)=>void} onPageChange
 * @param {(size:number)=>void} [onPageSizeChange] - omit to hide the selector
 * @param {number[]} [pageSizeOptions=[25,50,100]]
 * @param {string} [itemLabel='items']
 * @param {string} [rowsPerPageId] - override for the rows-per-page select id.
 *        Generated with useId() by default: the id used to be the literal
 *        "rows-per-page", which duplicated the moment two tables shared a
 *        screen and broke the <label for> association for both.
 */
export function Pagination({
  page = 1,
  pageSize = 25,
  total = 0,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = PAGE_SIZES,
  itemLabel = 'items',
  rowsPerPageId,
  className,
}) {
  const generatedId = useId()
  const selectId = rowsPerPageId ?? `rows-per-page-${generatedId}`
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const current = Math.min(Math.max(1, page), pageCount)
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1
  const last = Math.min(current * pageSize, total)

  return (
    <div
      className={cn(
        'flex min-h-[44px] flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas px-3 py-2',
        className
      )}
    >
      <p className="text-xs tabular text-fg-3">
        {total === 0
          ? `No ${itemLabel}`
          : `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)} ${itemLabel}`}
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange ? (
          <div className="flex items-center gap-1.5">
            <label htmlFor={selectId} className="text-xs text-fg-3">
              Rows per page
            </label>
            <Select
              id={selectId}
              size="sm"
              className="w-[72px]"
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              options={pageSizeOptions.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        ) : null}

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="secondary"
            iconOnly
            aria-label="First page"
            disabled={current <= 1}
            onClick={() => onPageChange?.(1)}
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            iconOnly
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => onPageChange?.(current - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <span className="px-2 text-xs tabular text-fg-2" aria-live="polite">
            Page {formatNumber(current)} of {formatNumber(pageCount)}
          </span>

          <Button
            size="sm"
            variant="secondary"
            iconOnly
            aria-label="Next page"
            disabled={current >= pageCount}
            onClick={() => onPageChange?.(current + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            iconOnly
            aria-label="Last page"
            disabled={current >= pageCount}
            onClick={() => onPageChange?.(pageCount)}
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export default Pagination
