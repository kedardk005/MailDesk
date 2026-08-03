import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState } from 'react'

/**
 * CommandRegistry — the registration channel for the single command palette.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ProtectedLayout` mounts one *controlled* <CommandPalette>. A page that wanted
 * its own commands had only one option — mount a second palette — and every
 * instance binds ⌘K on `document`, so two dialogs would open at once and the
 * second would steal focus from the first. The result was that no page could
 * contribute a single command.
 *
 * Now the layout wraps its content in <CommandRegistryProvider> and the palette
 * reads the registry. A page contributes commands with one hook and they are
 * removed automatically when the page unmounts.
 *
 *   import { useRegisterCommands } from '../components/CommandRegistry'
 *
 *   useRegisterCommands(
 *     [
 *       { id: 'inbox-sync',  label: 'Sync inbox now', icon: <RefreshCw className="h-4 w-4" />, onSelect: sync },
 *       { id: 'inbox-clear', label: 'Clear all emails', group: 'Inbox', onSelect: clearAll },
 *     ],
 *     [sync, clearAll],   // <- deps, exactly like useEffect/useMemo
 *   )
 *
 * A command is `{ id, label, onSelect, icon?, group?, keywords? }`.
 *   - `group`    optional group heading in the palette (default "Actions")
 *   - `keywords` extra search terms; cmdk matches on label + keywords
 *
 * The registry is optional everywhere: outside a provider the hook is a no-op
 * and the palette simply shows nothing extra, so `<CommandPalette>` still works
 * standalone (e.g. in a test or on a public route).
 */

const CommandRegistryContext = createContext(null)

/** Mount once, above the palette. `ProtectedLayout` already does. */
export function CommandRegistryProvider({ children }) {
  /* Keyed by the owner's useId(), so two pages (or two hooks in one page)
   * never collide and unmount removes exactly one entry. */
  const [registry, setRegistry] = useState({})

  const register = useCallback((key, commands) => {
    setRegistry((prev) => ({ ...prev, [key]: commands }))
    return () => {
      setRegistry((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }, [])

  const commands = useMemo(
    () => Object.values(registry).flat().filter(Boolean),
    [registry]
  )

  const value = useMemo(() => ({ register, commands }), [register, commands])

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  )
}

/**
 * Read the currently registered commands. Used by <CommandPalette>; pages
 * should not need this.
 * @returns {Array<{id:string,label:string,onSelect:Function,icon?:React.ReactNode,group?:string,keywords?:string[]}>}
 */
export function useRegisteredCommands() {
  return useContext(CommandRegistryContext)?.commands ?? EMPTY
}

const EMPTY = []

/**
 * Contribute page-scoped commands to the shell's palette. They are unregistered
 * on unmount.
 *
 * @param {Array<{id:string,label:string,onSelect:Function,icon?:React.ReactNode,group?:string,keywords?:string[]}>} commands
 * @param {Array} [deps=[]] - re-register when these change, exactly like
 *        useEffect. The array literal you pass as `commands` is a new object on
 *        every render, so it is intentionally NOT a dependency: list the values
 *        the commands close over instead.
 */
export function useRegisterCommands(commands, deps = []) {
  const ctx = useContext(CommandRegistryContext)
  const register = ctx?.register
  const key = useId()

  useEffect(() => {
    if (!register) return undefined
    if (!commands || commands.length === 0) return undefined
    return register(key, commands)
    /* `commands` is deliberately excluded — see the JSDoc above. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register, key, ...deps])
}

export default CommandRegistryProvider
