import { cn } from '../../lib/utils'

/**
 * Loading placeholder. Skeletons must MIRROR the real layout — a table
 * skeleton is rows, not one grey block.
 *
 * @param {string} [className] - set the height/width to match the real element
 */
export function Skeleton({ className, ...props }) {
  return (
    <div
      aria-hidden="true"
      className={cn('skeleton h-4 w-full rounded-sm', className)}
      {...props}
    />
  )
}

/** One line of text. `w` accepts any Tailwind width class. */
export function SkeletonText({ lines = 3, className }) {
  return (
    <div className={cn('space-y-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={i === lines - 1 ? 'w-2/3' : 'w-full'} />
      ))}
    </div>
  )
}

/**
 * Table loading state — 5 rows at the real row height. Never a spinner.
 * @param {number} [rows=5]
 * @param {number} [columns=5]
 */
export function SkeletonTable({ rows = 5, columns = 5, className }) {
  return (
    <div role="status" aria-label="Loading rows" className={cn('divide-y divide-line', className)}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex h-10 items-center gap-4 px-3">
          {Array.from({ length: columns }).map((_, c) => (
            <Skeleton
              key={c}
              className={cn('h-3', c === 1 ? 'flex-[2]' : 'flex-1')}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** KPI strip placeholder. */
export function SkeletonTiles({ count = 4, className }) {
  return (
    <div className={cn('grid gap-4', className)} role="status" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-lg border border-line bg-surface px-4 py-3">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-2 h-6 w-16" />
        </div>
      ))}
    </div>
  )
}

export default Skeleton
