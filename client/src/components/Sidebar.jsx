import { NavLink } from 'react-router-dom'
import {
  Building2,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  History,
  Inbox,
  LayoutDashboard,
  ScrollText,
  User,
  Users,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from './AuthProvider'
import { Button } from './ui/Button'
import { Tooltip } from './ui/Tooltip'

/**
 * Primary navigation. 240px expanded / 56px collapsed, lucide icons, no emoji,
 * no gradient user card, no hover translate.
 *
 * @param {boolean} isOpen - mobile drawer state
 * @param {() => void} onClose
 * @param {boolean} [collapsed] - desktop rail state (persisted by ProtectedLayout)
 * @param {() => void} [onToggleCollapsed]
 */
const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, roles: ['Admin', 'Head', 'Employee'] },
  { to: '/inbox', label: 'Inbox', icon: Inbox, roles: ['Admin', 'Head'] },
  { to: '/tasks', label: 'Tasks', icon: CheckSquare, roles: ['Admin', 'Head', 'Employee'] },
  { to: '/clients', label: 'Clients', icon: Building2, roles: ['Admin', 'Head', 'Employee'] },
  { to: '/reports', label: 'Reports', icon: ScrollText, roles: ['Admin'] },
  { to: '/admin/users', label: 'Users & Approvals', icon: Users, roles: ['Admin'] },
  { to: '/admin/activities', label: 'Activity Log', icon: History, roles: ['Admin'] },
  { to: '/profile', label: 'My Profile', icon: User, roles: ['Admin', 'Head', 'Employee'] },
]

export function Sidebar({ isOpen, onClose, collapsed = false, onToggleCollapsed }) {
  const { role } = useAuth()
  const items = NAV_ITEMS.filter((i) => !role || i.roles.includes(role))

  return (
    <>
      {isOpen ? (
        <div
          onClick={onClose}
          aria-hidden="true"
          className="fixed inset-0 z-drawer bg-[rgb(15_23_42/0.45)] lg:hidden"
        />
      ) : null}

      <aside
        aria-label="Main navigation"
        className={cn(
          'fixed inset-y-0 left-0 z-drawer flex shrink-0 flex-col border-r border-line bg-canvas',
          'transition-[transform,width] duration-150',
          'lg:static lg:z-sidebar lg:translate-x-0',
          collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
          isOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        {/* Mobile header — on desktop the brand lives in the top bar. */}
        <div className="flex h-topbar shrink-0 items-center justify-between border-b border-line px-3 lg:hidden">
          <span className="text-sm font-semibold text-fg">K M KOTHARI</span>
          <Button variant="ghost" size="sm" iconOnly aria-label="Close navigation" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto p-2 custom-scrollbar">
          <ul className="space-y-0.5">
            {items.map(({ to, label, icon: Icon }) => (
              <li key={to}>
                <Tooltip content={collapsed ? label : null} side="right">
                  <NavLink
                    to={to}
                    onClick={onClose}
                    className={({ isActive }) =>
                      cn(
                        'flex h-8 items-center gap-2.5 rounded px-2 text-sm font-medium',
                        'transition-colors duration-100',
                        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-primary-subtle text-primary-text'
                          : 'text-fg-2 hover:bg-subtle hover:text-fg'
                      )
                    }
                  >
                    <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                    {collapsed ? (
                      <span className="sr-only">{label}</span>
                    ) : (
                      <span className="truncate">{label}</span>
                    )}
                  </NavLink>
                </Tooltip>
              </li>
            ))}
          </ul>
        </nav>

        {onToggleCollapsed ? (
          <div className="hidden shrink-0 border-t border-line p-2 lg:block">
            <Button
              variant="ghost"
              size="sm"
              fullWidth={!collapsed}
              iconOnly={collapsed}
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              onClick={onToggleCollapsed}
              className={collapsed ? '' : 'justify-start'}
            >
              {collapsed ? (
                <ChevronRight className="h-4 w-4" />
              ) : (
                <>
                  <ChevronLeft className="h-4 w-4" />
                  Collapse
                </>
              )}
            </Button>
          </div>
        ) : null}
      </aside>
    </>
  )
}

export default Sidebar
