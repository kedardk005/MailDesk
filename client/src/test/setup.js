/**
 * Global test setup — runs once per test file, before any test.
 *
 *  1. jest-dom matchers (`toBeInTheDocument`, `toHaveAttribute`, …)
 *  2. jest-axe's `toHaveNoViolations`
 *  3. the MSW server: NO test may reach the real network. `onUnhandledRequest`
 *     is 'error' on purpose — a request nobody mocked is a test that is lying
 *     about what the page does.
 *  4. jsdom gaps that Radix, recharts and TanStack rely on.
 */
import '@testing-library/jest-dom/vitest'
import { configure } from '@testing-library/react'
import { toHaveNoViolations } from 'jest-axe'
import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import { server } from './server'

expect.extend(toHaveNoViolations)

configure({ asyncUtilTimeout: 4000 })

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})

afterEach(() => {
  server.resetHandlers()
  window.localStorage.clear()
  window.sessionStorage.clear()
  document.documentElement.className = ''
  vi.clearAllTimers()
})

afterAll(() => {
  server.close()
})

/* ---------------------------------------------------------------------------
 * jsdom gaps
 * ------------------------------------------------------------------------ */

/** recharts' ResponsiveContainer and EmailBody's auto-height both need this. */
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor() {
      this.root = null
      this.rootMargin = ''
      this.thresholds = []
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return []
    }
  }
}

/** ThemeProvider reads prefers-color-scheme; jsdom has no matchMedia. */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })
}

/* Radix menus/selects use Pointer Events + these three methods, none of which
 * jsdom implements. Without them every dropdown test throws. */
if (typeof window.PointerEvent === 'undefined') {
  window.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type, props = {}) {
      super(type, props)
      this.pointerId = props.pointerId ?? 1
      this.pointerType = props.pointerType ?? 'mouse'
      this.isPrimary = props.isPrimary ?? true
    }
  }
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {}
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {}
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

/* jsdom throws "Not implemented" for these; several pages call them. */
if (typeof window.scrollTo !== 'function') {
  window.scrollTo = () => {}
}
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test'
  URL.revokeObjectURL = () => {}
}
