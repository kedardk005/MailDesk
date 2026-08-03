import * as Radix from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * Overflow / action menu.
 *
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild>
 *       <Button iconOnly aria-label="More actions"><MoreHorizontal /></Button>
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent align="end">
 *       <DropdownMenuItem onSelect={sync}>Sync now</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem destructive onSelect={remove}>Disconnect</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */
export const DropdownMenu = Radix.Root
export const DropdownMenuTrigger = Radix.Trigger
export const DropdownMenuGroup = Radix.Group
export const DropdownMenuSub = Radix.Sub
export const DropdownMenuRadioGroup = Radix.RadioGroup

export function DropdownMenuContent({ className, sideOffset = 4, align = 'end', ...props }) {
  return (
    <Radix.Portal>
      <Radix.Content
        sideOffset={sideOffset}
        align={align}
        className={cn(
          'z-dropdown min-w-[180px] overflow-hidden rounded-lg border border-line-overlay bg-elevated p-1 shadow-md',
          'data-[state=open]:animate-slide-in',
          className
        )}
        {...props}
      />
    </Radix.Portal>
  )
}

const itemClass = (destructive) =>
  cn(
    'relative flex cursor-default select-none items-center gap-2 rounded px-2 py-1.5 text-sm outline-none',
    '[&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0',
    'data-[disabled]:pointer-events-none data-[disabled]:text-fg-off',
    destructive
      ? 'text-danger-text data-[highlighted]:bg-danger-subtle'
      : 'text-fg-2 data-[highlighted]:bg-elevated-subtle data-[highlighted]:text-fg'
  )

/** @param {boolean} [destructive] - renders in danger colours */
export function DropdownMenuItem({ className, destructive = false, ...props }) {
  return <Radix.Item className={cn(itemClass(destructive), className)} {...props} />
}

export function DropdownMenuCheckboxItem({ className, children, ...props }) {
  return (
    <Radix.CheckboxItem className={cn(itemClass(false), 'pl-7', className)} {...props}>
      <Radix.ItemIndicator className="absolute left-2">
        <Check className="h-3.5 w-3.5 text-primary-600" />
      </Radix.ItemIndicator>
      {children}
    </Radix.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({ className, children, ...props }) {
  return (
    <Radix.RadioItem className={cn(itemClass(false), 'pl-7', className)} {...props}>
      <Radix.ItemIndicator className="absolute left-2">
        <span className="h-1.5 w-1.5 rounded-full bg-primary-600" />
      </Radix.ItemIndicator>
      {children}
    </Radix.RadioItem>
  )
}

export function DropdownMenuLabel({ className, ...props }) {
  return (
    <Radix.Label
      className={cn('px-2 py-1 text-2xs font-semibold uppercase tracking-wide text-fg-3', className)}
      {...props}
    />
  )
}

export function DropdownMenuSeparator({ className, ...props }) {
  return <Radix.Separator className={cn('-mx-1 my-1 h-px bg-line-overlay', className)} {...props} />
}

export function DropdownMenuShortcut({ className, ...props }) {
  return (
    <span className={cn('ml-auto text-2xs tracking-wide text-fg-3', className)} {...props} />
  )
}

export function DropdownMenuSubTrigger({ className, children, ...props }) {
  return (
    <Radix.SubTrigger className={cn(itemClass(false), className)} {...props}>
      {children}
      <ChevronRight className="ml-auto h-3.5 w-3.5" />
    </Radix.SubTrigger>
  )
}

export function DropdownMenuSubContent({ className, ...props }) {
  return (
    <Radix.Portal>
      <Radix.SubContent
        className={cn(
          'z-dropdown min-w-[180px] overflow-hidden rounded-lg border border-line-overlay bg-elevated p-1 shadow-md',
          className
        )}
        {...props}
      />
    </Radix.Portal>
  )
}

export default DropdownMenu
