import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Command } from 'cmdk'
import {
  Building2,
  CheckSquare,
  Inbox,
  LayoutDashboard,
  LogOut,
  Moon,
  ScrollText,
  Search,
  Sun,
  User,
  Users,
} from 'lucide-react'
import { useAuth } from './AuthProvider'
import { useRegisteredCommands } from './CommandRegistry'
import { useTheme } from './ThemeProvider'
import { cn } from '../lib/utils'
import { DialogOverlay, DialogPortal } from './ui/Dialog'
import * as RadixDialog from '@radix-ui/react-dialog'

/**
 * Command palette (Cmd/Ctrl+K). The app previously had exactly one keyboard
 * shortcut in 10k lines.
 *
 * There is exactly ONE palette in the app, mounted by `ProtectedLayout` —
 * every instance binds ⌘K on `document`, so a second one would open two
 * dialogs. Pages therefore do NOT render their own; they contribute commands
 * through the registry:
 *
 *   import { useRegisterCommands } from '../components/CommandRegistry'
 *   useRegisterCommands([{ id, label, icon, onSelect, group }], [deps])
 *
 * `extraCommands` still works for a standalone/controlled instance and is
 * merged with whatever the registry holds.
 */
const NAV_COMMANDS = [
  { id: 'dashboard', label: 'Go to Dashboard', to: '/dashboard', icon: LayoutDashboard, roles: ['Admin', 'Head', 'Employee'] },
  { id: 'inbox', label: 'Go to Inbox', to: '/inbox', icon: Inbox, roles: ['Admin', 'Head'] },
  { id: 'tasks', label: 'Go to Tasks', to: '/tasks', icon: CheckSquare, roles: ['Admin', 'Head', 'Employee'] },
  { id: 'clients', label: 'Go to Clients', to: '/clients', icon: Building2, roles: ['Admin', 'Head', 'Employee'] },
  /* Same roles as the /reports route in App.jsx and the sidebar entry: the
   * server fully supports Head-scoped reports. */
  { id: 'reports', label: 'Go to Reports', to: '/reports', icon: ScrollText, roles: ['Admin', 'Head'] },
  { id: 'users', label: 'Go to Users & Approvals', to: '/admin/users', icon: Users, roles: ['Admin'] },
  { id: 'activity', label: 'Go to Activity Log', to: '/admin/activities', icon: ScrollText, roles: ['Admin'] },
  { id: 'profile', label: 'Go to My Profile', to: '/profile', icon: User, roles: ['Admin', 'Head', 'Employee'] },
]

const GROUP_HEADING_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-3'

/**
 * @param {boolean} [open] - controlled state; omit to let the palette own it
 * @param {(open:boolean)=>void} [onOpenChange]
 * @param {Array<{id:string,label:string,icon?:React.ReactNode,onSelect:Function,group?:string,keywords?:string[]}>} [extraCommands]
 *        Merged with anything registered through `useRegisterCommands()`.
 */
export function CommandPalette({ open: openProp, onOpenChange, extraCommands = [] }) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = openProp ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen
  const navigate = useNavigate()
  const { role, logout } = useAuth()
  const { theme, toggleTheme } = useTheme()
  const registered = useRegisteredCommands()

  /* Registry first, then anything passed directly to this instance. Later
   * duplicates of an id are dropped so a page cannot register twice. */
  const pageCommandGroups = useMemo(() => {
    const seen = new Set()
    const groups = new Map()
    for (const command of [...registered, ...extraCommands]) {
      if (!command || !command.id || seen.has(command.id)) continue
      seen.add(command.id)
      const heading = command.group || 'Actions'
      if (!groups.has(heading)) groups.set(heading, [])
      groups.get(heading).push(command)
    }
    return Array.from(groups, ([heading, commands]) => ({ heading, commands }))
  }, [registered, extraCommands])

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key?.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen(!open)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, setOpen])

  const navCommands = useMemo(
    () => NAV_COMMANDS.filter((c) => !role || c.roles.includes(role)),
    [role]
  )

  const run = (fn) => {
    setOpen(false)
    // Let the dialog unmount before navigating so focus restore behaves.
    window.setTimeout(fn, 0)
  }

  return (
    <RadixDialog.Root open={open} onOpenChange={setOpen}>
      <DialogPortal>
        <DialogOverlay />
        <RadixDialog.Content
          aria-label="Command palette"
          className={cn(
            'fixed left-1/2 top-[15%] z-modal w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2',
            'overflow-hidden rounded-xl border border-line bg-surface shadow-lg focus:outline-none',
            'data-[state=open]:animate-slide-in'
          )}
        >
          <RadixDialog.Title className="sr-only">Command palette</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">
            Search for a page or an action. Press Escape to close.
          </RadixDialog.Description>

          <Command loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-3" />
              <Command.Input
                autoFocus
                placeholder="Search pages and actions…"
                className="h-11 flex-1 border-0 bg-transparent text-sm text-fg outline-none placeholder:text-fg-off focus:ring-0"
              />
              <kbd className="rounded border border-line bg-subtle px-1.5 py-0.5 text-2xs text-fg-3">
                Esc
              </kbd>
            </div>

            <Command.List className="max-h-[320px] overflow-y-auto p-1 custom-scrollbar">
              <Command.Empty className="px-3 py-8 text-center text-sm text-fg-3">
                No matching commands.
              </Command.Empty>

              <Command.Group heading="Navigate" className={GROUP_HEADING_CLASS}>
                {navCommands.map(({ id, label, to, icon: Icon }) => (
                  <Item key={id} onSelect={() => run(() => navigate(to))}>
                    <Icon aria-hidden="true" className="h-4 w-4" />
                    {label}
                  </Item>
                ))}
              </Command.Group>

              {pageCommandGroups.map(({ heading, commands }) => (
                <Command.Group key={heading} heading={heading} className={GROUP_HEADING_CLASS}>
                  {commands.map((c) => (
                    <Item key={c.id} keywords={c.keywords} onSelect={() => run(c.onSelect)}>
                      {c.icon}
                      {c.label}
                    </Item>
                  ))}
                </Command.Group>
              ))}

              <Command.Group heading="Preferences" className={GROUP_HEADING_CLASS}>
                <Item onSelect={() => run(toggleTheme)}>
                  {theme === 'dark' ? (
                    <Sun aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Moon aria-hidden="true" className="h-4 w-4" />
                  )}
                  Switch to {theme === 'dark' ? 'light' : 'dark'} theme
                </Item>
                <Item onSelect={() => run(() => { logout(); navigate('/login', { replace: true }) })}>
                  <LogOut aria-hidden="true" className="h-4 w-4" />
                  Sign out
                </Item>
              </Command.Group>
            </Command.List>
          </Command>
        </RadixDialog.Content>
      </DialogPortal>
    </RadixDialog.Root>
  )
}

function Item({ children, onSelect, keywords }) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className="flex cursor-default select-none items-center gap-2 rounded px-2 py-2 text-sm text-fg-2 data-[selected=true]:bg-subtle data-[selected=true]:text-fg"
    >
      {children}
    </Command.Item>
  )
}

export default CommandPalette
