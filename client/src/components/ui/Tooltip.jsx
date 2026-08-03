import * as Radix from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

/**
 * Tooltip. NEVER carry essential information in one — it is invisible to
 * touch users and to anyone reading with a screen magnifier.
 *
 * <TooltipProvider> is mounted once in App.jsx.
 *
 *   <Tooltip content="Sync now">
 *     <Button iconOnly aria-label="Sync now"><RefreshCw /></Button>
 *   </Tooltip>
 */
export function TooltipProvider({ children, delayDuration = 400, ...props }) {
  return (
    <Radix.Provider delayDuration={delayDuration} skipDelayDuration={200} {...props}>
      {children}
    </Radix.Provider>
  )
}

/**
 * @param {React.ReactNode} content - short label
 * @param {'top'|'right'|'bottom'|'left'} [side='top']
 * @param {React.ReactNode} children - the trigger (must accept a ref)
 */
export function Tooltip({ content, children, side = 'top', align = 'center', className, ...props }) {
  if (!content) return children
  return (
    <Radix.Root {...props}>
      <Radix.Trigger asChild>{children}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          side={side}
          align={align}
          sideOffset={6}
          className={cn(
            'z-tooltip max-w-[280px] rounded-sm bg-fg px-2 py-1 text-xs text-fg-inverse shadow-md',
            'data-[state=delayed-open]:animate-fade-in',
            className
          )}
        >
          {content}
          <Radix.Arrow className="fill-fg" width={10} height={5} />
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  )
}

export default Tooltip
