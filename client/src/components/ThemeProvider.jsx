import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

/**
 * Theme control. `darkMode: 'class'` is now explicit in tailwind.config.js —
 * previously it defaulted to `'media'`, which made KeywordApprovalModal render
 * dark inside an otherwise light app on any machine with OS dark mode on.
 *
 *   const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme()
 *
 * `theme` is 'light' | 'dark' | 'system'; `resolvedTheme` is 'light' | 'dark'.
 */
const STORAGE_KEY = 'maildesk_theme'
const ThemeContext = createContext(null)

function systemTheme() {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readStored() {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY)
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'light'
  } catch {
    return 'light'
  }
}

export function ThemeProvider({ children, defaultTheme = 'light' }) {
  const [preference, setPreference] = useState(() => readStored() || defaultTheme)
  // Only ever written from the media-query event handler, never from an effect.
  const [systemDark, setSystemDark] = useState(() => systemTheme() === 'dark')

  const resolved =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    document.documentElement.classList.toggle('dark', resolved === 'dark')
    try {
      window.localStorage.setItem(STORAGE_KEY, preference)
    } catch {
      /* ignore */
    }
  }, [resolved, preference])

  useEffect(() => {
    if (!window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((t) => setPreference(t), [])
  const toggleTheme = useCallback(
    () => setPreference((t) => (t === 'dark' ? 'light' : 'dark')),
    []
  )

  const value = useMemo(
    () => ({ theme: resolved, preference, resolvedTheme: resolved, setTheme, toggleTheme }),
    [preference, resolved, setTheme, toggleTheme]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme() must be used inside <ThemeProvider>.')
  return ctx
}

export default ThemeProvider
