import * as Radix from '@radix-ui/react-popover'
import { cn } from '../../lib/utils'

/**
 * Popover — filter panels, column-visibility menus, date pickers.
 * For a list of actions use DropdownMenu instead (correct roles + typeahead).
 *
 *   <Popover>
 *     <PopoverTrigger asChild><Button>Filters</Button></PopoverTrigger>
 *     <PopoverContent className="w-64">…</PopoverContent>
 *   </Popover>
 */
export const Popover = Radix.Root
export const PopoverTrigger = Radix.Trigger
export const PopoverAnchor = Radix.Anchor
export const PopoverClose = Radix.Close

export function PopoverContent({ className, align = 'start', sideOffset = 6, ...props }) {
  return (
    <Radix.Portal>
      <Radix.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'z-dropdown rounded-lg border border-line bg-surface p-3 shadow-md focus:outline-none',
          'data-[state=open]:animate-slide-in',
          className
        )}
        {...props}
      />
    </Radix.Portal>
  )
}

export default Popover
