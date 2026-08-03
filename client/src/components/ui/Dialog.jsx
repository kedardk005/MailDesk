import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './Button'

/**
 * Modal dialog built on Radix — real focus trap, ESC to close, body scroll lock
 * and focus restore to the trigger.
 *
 * Modality is announced by `aria-hidden` on the portal's siblings, which is how
 * Radix 1.1.x implements it; this component does NOT emit an `aria-modal`
 * attribute. (An earlier version of this comment claimed it did — assertions
 * should target the focus trap and the sibling `aria-hidden`, not `aria-modal`.)
 *
 *   <Dialog open={open} onOpenChange={setOpen}>
 *     <DialogContent size="md" title="New task" description="…">
 *       …body…
 *       <DialogFooter>
 *         <DialogClose asChild><Button>Cancel</Button></DialogClose>
 *         <Button variant="primary">Create</Button>
 *       </DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 */
export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close
export const DialogPortal = RadixDialog.Portal

const sizes = {
  sm: 'max-w-[400px]',
  md: 'max-w-[520px]',
  lg: 'max-w-[720px]',
  xl: 'max-w-[960px]',
}

export function DialogOverlay({ className, ...props }) {
  return (
    <RadixDialog.Overlay
      className={cn(
        'fixed inset-0 z-overlay overlay-scrim',
        'data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out',
        className
      )}
      {...props}
    />
  )
}

/**
 * @param {'sm'|'md'|'lg'|'xl'} [size='md'] - 400 / 520 / 720 / 960px
 * @param {React.ReactNode} title - REQUIRED, becomes aria-labelledby
 * @param {React.ReactNode} [description] - becomes aria-describedby
 * @param {boolean} [showClose=true]
 * @param {React.ReactNode} [headerActions]
 * @param {boolean} [dismissable=true] - false blocks ESC + scrim click (dirty forms)
 * @param {string} [bodyClassName]
 */
export function DialogContent({
  size = 'md',
  title,
  description,
  showClose = true,
  headerActions,
  dismissable = true,
  className,
  bodyClassName,
  children,
  footer,
  ...props
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <RadixDialog.Content
        onEscapeKeyDown={dismissable ? undefined : (e) => e.preventDefault()}
        onPointerDownOutside={dismissable ? undefined : (e) => e.preventDefault()}
        onInteractOutside={dismissable ? undefined : (e) => e.preventDefault()}
        className={cn(
          'fixed left-1/2 top-1/2 z-modal flex w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col',
          'max-h-[calc(100vh-96px)] overflow-hidden rounded-xl border border-line-overlay bg-elevated shadow-lg',
          'focus:outline-none',
          'data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out',
          sizes[size] || sizes.md,
          className
        )}
        {...props}
      >
        <div className="flex min-h-[56px] shrink-0 items-center justify-between gap-3 border-b border-line-overlay px-5 py-3">
          <div className="min-w-0">
            <RadixDialog.Title className="truncate text-md font-semibold text-fg">
              {title}
            </RadixDialog.Title>
            {description ? (
              <RadixDialog.Description className="mt-0.5 text-xs text-fg-3">
                {description}
              </RadixDialog.Description>
            ) : (
              <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
            {showClose ? (
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="sm" iconOnly aria-label="Close dialog">
                  <X className="h-4 w-4" />
                </Button>
              </RadixDialog.Close>
            ) : null}
          </div>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto p-5', bodyClassName)}>{children}</div>

        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </RadixDialog.Content>
    </DialogPortal>
  )
}

/** Right-aligned action bar. `[Cancel: secondary] [Confirm: primary]`, auto-width. */
export function DialogFooter({ className, children, ...props }) {
  return (
    <div
      className={cn(
        'flex min-h-[64px] shrink-0 items-center justify-end gap-2 border-t border-line-overlay bg-elevated-subtle px-5 py-3',
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export const DialogTitle = RadixDialog.Title
export const DialogDescription = RadixDialog.Description

export default Dialog
