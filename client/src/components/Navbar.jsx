import { useNavigate } from 'react-router-dom'
import { LogOut, Menu, Moon, PanelLeft, Search, Sun, User } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from './AuthProvider'
import { useTheme } from './ThemeProvider'
import NotificationBell from './NotificationBell'
import { Avatar } from './ui/Avatar'
import { Badge } from './ui/Badge'
import { Button } from './ui/Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from './ui/DropdownMenu'
import { Tooltip } from './ui/Tooltip'

/** Role badge tone. Danger is reserved for destructive states — never a role. */
const ROLE_VARIANT = { Admin: 'warning', Head: 'info', Employee: 'neutral' }

/**
 * Fixed 48px top bar. No scroll listener, no backdrop blur, no gradient avatar
 * ring — the shell is chrome, not a marketing header.
 *
 * @param {() => void} onToggleSidebar - mobile drawer
 * @param {() => void} [onToggleCollapsed] - desktop rail
 * @param {() => void} [onOpenCommandPalette]
 */
export function Navbar({ onToggleSidebar, onToggleCollapsed, onOpenCommandPalette }) {
  const navigate = useNavigate()
  const { user, displayName, role, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()

  const handleLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  return (
    <header className="flex h-topbar shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-3">
      <div className="flex min-w-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label="Open navigation"
          className="lg:hidden"
          onClick={onToggleSidebar}
        >
          <Menu className="h-4 w-4" />
        </Button>

        {onToggleCollapsed ? (
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label="Toggle navigation width"
            className="hidden lg:inline-flex"
            onClick={onToggleCollapsed}
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
        ) : null}

        <span className="truncate text-sm font-semibold tracking-tight text-fg">K M KOTHARI</span>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {onOpenCommandPalette ? (
          <Button
            variant="secondary"
            size="sm"
            className="hidden gap-2 text-fg-3 md:inline-flex"
            onClick={onOpenCommandPalette}
            leftIcon={<Search className="h-3.5 w-3.5" />}
          >
            Search
            <kbd className="ml-1 rounded border border-line bg-subtle px-1 text-2xs text-fg-3">
              ⌘K
            </kbd>
          </Button>
        ) : null}

        <Tooltip content={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </Tooltip>

        <NotificationBell />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Account menu"
              className={cn(
                'flex h-8 items-center gap-2 rounded px-1.5 text-left',
                'transition-colors duration-100 hover:bg-subtle',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-600'
              )}
            >
              <Avatar name={displayName} id={user?._id || user?.email} size="sm" />
              <span className="hidden max-w-[140px] truncate text-xs font-medium text-fg-2 sm:inline">
                {displayName}
              </span>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuLabel>Signed in</DropdownMenuLabel>
            <div className="px-2 pb-2">
              <p className="truncate text-sm font-medium text-fg">{displayName}</p>
              {user?.email ? (
                <p className="truncate text-xs text-fg-3">{user.email}</p>
              ) : null}
              {role ? (
                <Badge variant={ROLE_VARIANT[role] || 'neutral'} className="mt-1.5">
                  {role}
                </Badge>
              ) : null}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate('/profile')}>
              <User className="h-4 w-4" />
              My profile
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem destructive onSelect={handleLogout}>
              <LogOut className="h-4 w-4" />
              Sign out
              <DropdownMenuShortcut />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}

export default Navbar
