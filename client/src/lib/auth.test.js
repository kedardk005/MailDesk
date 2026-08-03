/**
 * Regression guard for PROJECT_AUDIT §S-9: logout leaked the previous user's
 * data to the next person on a shared machine.
 *
 * The old logout cleared only `token` and `user`. Seven `cached_*` keys
 * survived — including 50 email subjects, senders and body previews — so the
 * next person to sign in on the same office machine saw the previous user's
 * mail on first paint.
 *
 * Also guards §S-8 / the 12-place duplication: the user object used to be
 * re-read and re-parsed from localStorage in 12 places with 4 different
 * defaults, which is why updating your Profile refreshed the Sidebar but not
 * the Navbar.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  CACHE_KEYS,
  getRole,
  getToken,
  getUser,
  hasRole,
  isAuthenticated,
  clearSession,
  setSession,
  setUser,
} from './auth'

const seedFullSession = () => {
  setSession({
    token: 'header.payload.signature',
    user: { _id: 'u1', name: 'Test User', email: 't@example.test', role: 'Head' },
  })
  CACHE_KEYS.forEach((key, i) => {
    window.localStorage.setItem(key, JSON.stringify({ leaked: `secret-${i}` }))
  })
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('clearSession', () => {
  it('clears the token and user', () => {
    seedFullSession()
    expect(getToken()).toBeTruthy()

    clearSession()

    expect(getToken()).toBeFalsy()
    expect(getUser()).toBeNull()
    expect(isAuthenticated()).toBe(false)
  })

  it('clears every cached_* key so the next user sees no leftover mail', () => {
    seedFullSession()
    // Guard the guard: the fixture must actually have written them.
    expect(CACHE_KEYS.length).toBeGreaterThanOrEqual(7)
    CACHE_KEYS.forEach((key) => expect(window.localStorage.getItem(key)).not.toBeNull())

    clearSession()

    const survivors = CACHE_KEYS.filter((key) => window.localStorage.getItem(key) !== null)
    expect(survivors).toEqual([])
  })

  it('leaves unrelated keys alone', () => {
    seedFullSession()
    window.localStorage.setItem('theme', 'dark')

    clearSession()

    expect(window.localStorage.getItem('theme')).toBe('dark')
  })
})

describe('single source of truth', () => {
  it('reads back exactly what was written', () => {
    setSession({ token: 't', user: { _id: 'u1', name: 'Ada', role: 'Admin' } })

    expect(getUser()).toMatchObject({ _id: 'u1', name: 'Ada', role: 'Admin' })
    expect(getRole()).toBe('Admin')
  })

  it('reflects an update immediately, so every consumer stays in sync', () => {
    setSession({ token: 't', user: { _id: 'u1', name: 'Ada', role: 'Admin' } })

    setUser({ _id: 'u1', name: 'Ada Lovelace', role: 'Admin' })

    expect(getUser().name).toBe('Ada Lovelace')
  })

  it('survives corrupted storage instead of throwing', () => {
    window.localStorage.setItem('user', '{not valid json')

    expect(() => getUser()).not.toThrow()
    expect(getUser()).toBeNull()
  })
})

describe('role checks', () => {
  it.each([
    ['Admin', 'Admin', true],
    ['Head', 'Admin', false],
    ['Employee', 'Admin', false],
  ])('user %s vs required %s -> %s', (role, required, expected) => {
    setSession({ token: 't', user: { _id: 'u1', role } })
    expect(hasRole(required)).toBe(expected)
  })

  it('accepts an array of allowed roles', () => {
    setSession({ token: 't', user: { _id: 'u1', role: 'Head' } })
    expect(hasRole(['Admin', 'Head'])).toBe(true)
    expect(hasRole(['Admin'])).toBe(false)
  })

  it('denies everything when signed out', () => {
    expect(hasRole('Admin')).toBe(false)
    expect(hasRole(['Admin', 'Head', 'Employee'])).toBe(false)
  })
})
