import * as Radix from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils'

/**
 * Underline tabs. Roving tabindex and arrow-key navigation come from Radix.
 * The active tab SHOULD live in the URL (`?tab=sent`) so a view is shareable.
 *
 *   <Tabs value={tab} onValueChange={setTab}>
 *     <TabsList>
 *       <TabsTrigger value="inbox" count={128}>Inbox</TabsTrigger>
 *       <TabsTrigger value="sent">Sent</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="inbox">…</TabsContent>
 *   </Tabs>
 */
export const Tabs = Radix.Root

export function TabsList({ className, ...props }) {
  return (
    <Radix.List
      className={cn('flex items-center gap-1 border-b border-line', className)}
      {...props}
    />
  )
}

/**
 * @param {string} value
 * @param {number|string} [count] - rendered as a trailing count chip
 * @param {React.ReactNode} [icon]
 */
export function TabsTrigger({ className, children, count, icon, ...props }) {
  return (
    <Radix.Trigger
      className={cn(
        'group relative -mb-px inline-flex h-[38px] items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-fg-3',
        'transition-colors duration-100 hover:text-fg-2',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary-600',
        'data-[state=active]:border-primary-600 data-[state=active]:font-semibold data-[state=active]:text-fg',
        'disabled:pointer-events-none disabled:text-fg-off',
        '[&>svg]:h-4 [&>svg]:w-4',
        className
      )}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined && count !== null ? (
        <span className="ml-0.5 rounded-sm bg-subtle px-1 text-2xs font-semibold tabular text-fg-3 group-data-[state=active]:bg-primary-subtle group-data-[state=active]:text-primary-text">
          {count}
        </span>
      ) : null}
    </Radix.Trigger>
  )
}

export function TabsContent({ className, ...props }) {
  return (
    <Radix.Content
      className={cn('focus-visible:outline-none', className)}
      {...props}
    />
  )
}

/**
 * Segmented control — for view switching (Table / Board / Calendar), NOT for
 * page-level navigation.
 *
 * @param {Array<{value:string,label:string,icon?:React.ReactNode}>} options
 */
export function SegmentedControl({ value, onValueChange, options = [], className, ariaLabel }) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn('inline-flex items-center gap-0.5 rounded border border-line bg-subtle p-0.5', className)}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onValueChange?.(o.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-sm px-2.5 text-xs font-medium transition-colors duration-100',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary-600',
              '[&>svg]:h-3.5 [&>svg]:w-3.5',
              active
                ? 'bg-surface text-fg shadow-xs'
                : 'text-fg-3 hover:text-fg-2'
            )}
          >
            {o.icon}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export default Tabs
