import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import * as authStore from '../lib/auth'

/**
 * Single source of truth for the signed-in user.
 *
 * Before this existed, the user object was re-read and re-parsed from
 * localStorage in 12 places with 4 different fallback shapes. Read it from
 * here instead:
 *
 *   const { user, isAdmin, logout } = useAuth()
 *
 * `logout()` clears the token, the user AND all 7 `cached_*` keys — the
 * previous behaviour left the last user's email subjects, senders and body
 * previews readable by the next person on a shared machine.
 */
const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUserState] = useState(() => authStore.getUser())
  const [token, setTokenState] = useState(() => authStore.getToken())

  // Keep in sync with other tabs and with non-React writers (axios 401 handler).
  useEffect(() => {
    return authStore.subscribe(() => {
      setUserState(authStore.getUser())
      setTokenState(authStore.getToken())
    })
  }, [])

  const setUser = useCallback((next) => {
    // Accept an updater function like useState.
    setUserState((prev) => {
      const value = typeof next === 'function' ? next(prev) : next
      authStore.setUser(value)
      return value
    })
  }, [])

  const login = useCallback(({ token: t, user: u }) => {
    authStore.setSession({ token: t, user: u })
    setTokenState(t || null)
    setUserState(u || null)
  }, [])

  /** Clears token + user + every cached_* key. */
  const logout = useCallback(() => {
    authStore.clearSession()
    setTokenState(null)
    setUserState(null)
  }, [])

  const value = useMemo(
    () => ({
      user,
      token,
      setUser,
      login,
      logout,
      isAuthenticated: Boolean(token),
      role: user?.role || null,
      isAdmin: user?.role === 'Admin',
      isHead: user?.role === 'Head',
      isEmployee: user?.role === 'Employee',
      /** @param {string|string[]} role */
      hasRole: (role) => authStore.hasRole(role, user),
      /** Display name that never renders "undefined". */
      displayName: user?.name || user?.email || 'Unknown user',
    }),
    [user, token, setUser, login, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/**
 * @returns {{
 *   user: object|null,
 *   token: string|null,
 *   setUser: Function,
 *   login: Function,
 *   logout: Function,
 *   isAuthenticated: boolean,
 *   role: string|null,
 *   isAdmin: boolean,
 *   isHead: boolean,
 *   isEmployee: boolean,
 *   hasRole: (role: string|string[]) => boolean,
 *   displayName: string,
 * }}
 */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth() must be used inside <AuthProvider>.')
  return ctx
}

export default AuthProvider
