import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './Button'
import { DialogOverlay } from './Dialog'

/**
 * Right-side drawer — email reading pane, task detail, activity-log detail.
 * Full height, radius 0, border-left. Same Radix a11y guarantees as Dialog.
 *
 *   <Drawer open={o} onOpenChange={setO}>
 *     <DrawerContent size="lg" title="Re: GST filing" description="from accounts@…">
 *       …
 *     </DrawerContent>
 *   </Drawer>
 */
export const Drawer = RadixDialog.Root
export const DrawerTrigger = RadixDialog.Trigger
export const DrawerClose = RadixDialog.Close

const sizes = {
  sm: 'w-[480px]',
  md: 'w-[640px]',
  lg: 'w-[880px]',
}

/**
 * @param {'sm'|'md'|'lg'} [size='md'] - 480 / 640 / 880px
 * @param {'right'|'left'} [side='right']
 * @param {React.ReactNode} title - REQUIRED
 * @param {React.ReactNode} [description]
 * @param {React.ReactNode} [headerActions]
 * @param {React.ReactNode} [footer]
 */
export function DrawerContent({
  size = 'md',
  side = 'right',
  title,
  description,
  headerActions,
  footer,
  className,
  bodyClassName,
  children,
  ...props
}) {
  return (
    <RadixDialog.Portal>
      <DialogOverlay />
      <RadixDialog.Content
        className={cn(
          'fixed inset-y-0 z-drawer flex max-w-[calc(100vw-48px)] flex-col bg-surface shadow-lg focus:outline-none',
          side === 'right' ? 'right-0 border-l border-line' : 'left-0 border-r border-line',
          'data-[state=open]:animate-slide-in-right',
          sizes[size] || sizes.md,
          className
        )}
        {...props}
      >
        <div className="flex min-h-[56px] shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-3">
          <div className="min-w-0">
            <RadixDialog.Title className="truncate text-md font-semibold text-fg">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-0.5 truncate text-xs text-fg-3">
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="sm" iconOnly aria-label="Close panel">
                <X className="h-4 w-4" />
              </Button>
            </RadixDialog.Close>
          </div>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto p-5', bodyClassName)}>{children}</div>

        {footer ? (
          <div className="flex min-h-[56px] shrink-0 items-center justify-end gap-2 border-t border-line bg-canvas px-5 py-3">
            {footer}
          </div>
        ) : null}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
}

export default Drawer
