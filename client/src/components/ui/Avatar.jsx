import * as Radix from '@radix-ui/react-avatar'
import { cn, initials as toInitials, hashIndex } from '../../lib/utils'

/* Muted, deterministic tints. No gradients, no gradient rings. */
const TINTS = [
  'bg-[#E2E8F0] text-[#475569]',
  'bg-[#DBEAFE] text-[#1D4ED8]',
  'bg-[#DCFCE7] text-[#15803D]',
  'bg-[#FEF3C7] text-[#B45309]',
  'bg-[#FCE7F3] text-[#9D174D]',
  'bg-[#E0E7FF] text-[#3730A3]',
]

const sizes = {
  xs: 'h-5 w-5 text-[10px]',
  sm: 'h-6 w-6 text-2xs',
  md: 'h-8 w-8 text-xs',
  lg: 'h-10 w-10 text-base',
}

/**
 * @param {string} [name] - used for initials and for the deterministic tint
 * @param {string} [src]
 * @param {string} [id] - tint key; falls back to `name`
 * @param {'xs'|'sm'|'md'|'lg'} [size='md'] - 20 / 24 / 32 / 40px
 */
export function Avatar({ name, src, id, size = 'md', className, ...props }) {
  const tint = TINTS[hashIndex(id || name || '', TINTS.length)]
  return (
    <Radix.Root
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium',
        sizes[size] || sizes.md,
        tint,
        className
      )}
      {...props}
    >
      {src ? (
        <Radix.Image src={src} alt={name || ''} className="h-full w-full object-cover" />
      ) : null}
      <Radix.Fallback delayMs={src ? 300 : 0} className="leading-none">
        {toInitials(name)}
      </Radix.Fallback>
    </Radix.Root>
  )
}

/**
 * Overlapping avatar stack with a +N overflow chip.
 * @param {Array<{name?:string, src?:string, id?:string}>} users
 * @param {number} [max=4]
 */
export function AvatarGroup({ users = [], max = 4, size = 'sm', className }) {
  const shown = users.slice(0, max)
  const rest = users.length - shown.length
  return (
    <div className={cn('flex items-center', className)}>
      {shown.map((u, i) => (
        <Avatar
          key={u.id || u.name || i}
          {...u}
          size={size}
          className="-ml-2 ring-2 ring-surface first:ml-0"
        />
      ))}
      {rest > 0 ? (
        <span
          className={cn(
            '-ml-2 inline-flex items-center justify-center rounded-full bg-muted font-medium text-fg-2 ring-2 ring-surface',
            sizes[size] || sizes.sm
          )}
        >
          +{rest}
        </span>
      ) : null}
    </div>
  )
}

export default Avatar
