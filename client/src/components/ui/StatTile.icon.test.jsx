/**
 * Regression guard: StatTile crashed the Dashboard when given a lucide icon.
 *
 * lucide-react v1 exports forwardRef OBJECTS, so the old `typeof icon ===
 * "function"` test failed and the raw object was rendered as a React child —
 * "Objects are not valid as a React child", white screen. Both documented
 * forms must work.
 */
import { render, screen } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { StatTile } from './Card'

describe('StatTile icon forms', () => {
  it('accepts a lucide component type', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<StatTile label="Open" value={7} icon={Inbox} />)).not.toThrow()
    expect(screen.getByText('Open')).toBeInTheDocument()
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })
  it('accepts an already-created element', () => {
    expect(() => render(<StatTile label="Late" value={2} icon={<Inbox />} />)).not.toThrow()
    expect(screen.getByText('Late')).toBeInTheDocument()
  })
  it('renders fine with no icon', () => {
    expect(() => render(<StatTile label="Done" value={9} />)).not.toThrow()
  })
})
