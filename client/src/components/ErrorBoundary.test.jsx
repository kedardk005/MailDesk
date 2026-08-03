/**
 * ErrorBoundary.
 *
 * The app previously had zero boundaries: one throw anywhere produced a white
 * screen, and the Tasks page threw on every filter click. App.jsx now wraps the
 * router once and every lazy route again, keyed on `location.key` so navigating
 * away from a broken screen un-breaks it. That reset is the part most likely to
 * be lost in a refactor, so it is asserted here.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import ErrorBoundary from './ErrorBoundary'

function Boom({ throwNow = true }) {
  if (throwNow) throw new Error('kaboom from the page')
  return <p>Working content</p>
}

/** React logs every caught error through console.error; that is expected here. */
const silenceReact = () => vi.spyOn(console, 'error').mockImplementation(() => {})

describe('ErrorBoundary', () => {
  it('renders the fallback instead of unmounting the tree', () => {
    silenceReact()
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>
    )

    const alert = screen.getByRole('alert')
    expect(alert).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /something went wrong on this screen/i })).toBeInTheDocument()
    expect(screen.queryByText('Working content')).toBeNull()
  })

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <Boom throwNow={false} />
      </ErrorBoundary>
    )
    expect(screen.getByText('Working content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps sibling subtrees alive — the shell survives a broken panel', () => {
    silenceReact()
    render(
      <div>
        <nav>Navigation</nav>
        <ErrorBoundary compact>
          <Boom />
        </ErrorBoundary>
      </div>
    )

    expect(screen.getByText('Navigation')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  it('reports the error to onError as well as console.error', () => {
    const spy = silenceReact()
    const onError = vi.fn()

    render(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>
    )

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(onError.mock.calls[0][0].message).toBe('kaboom from the page')
    expect(spy.mock.calls.some((args) => args[0] === '[ErrorBoundary]')).toBe(true)
  })

  it('"Try again" re-renders the subtree, which recovers once the child stops throwing', async () => {
    silenceReact()
    const user = userEvent.setup()

    function Harness() {
      const [broken, setBroken] = useState(true)
      return (
        <>
          <button type="button" onClick={() => setBroken(false)}>
            Fix it
          </button>
          <ErrorBoundary>
            <Boom throwNow={broken} />
          </ErrorBoundary>
        </>
      )
    }

    render(<Harness />)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Fix it' }))
    await user.click(screen.getByRole('button', { name: /try again/i }))

    expect(screen.getByText('Working content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('a changed resetKey clears the error — this is what makes navigation recover', async () => {
    silenceReact()
    const user = userEvent.setup()

    function Harness() {
      const [key, setKey] = useState('route-a')
      return (
        <>
          <button type="button" onClick={() => setKey('route-b')}>
            Navigate
          </button>
          <ErrorBoundary resetKey={key}>
            <Boom throwNow={key === 'route-a'} />
          </ErrorBoundary>
        </>
      )
    }

    render(<Harness />)
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Navigate' }))
    expect(screen.getByText('Working content')).toBeInTheDocument()
  })

  it('a custom fallback replaces the default UI and receives the error', () => {
    silenceReact()
    render(
      <ErrorBoundary fallback={(error) => <p>Custom: {error.message}</p>}>
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByText('Custom: kaboom from the page')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /something went wrong/i })).toBeNull()
  })

  it('accepts a custom title and description', () => {
    silenceReact()
    render(
      <ErrorBoundary title="The inbox could not be drawn" description="Try another mailbox.">
        <Boom />
      </ErrorBoundary>
    )
    expect(screen.getByRole('heading', { name: 'The inbox could not be drawn' })).toBeInTheDocument()
    expect(screen.getByText('Try another mailbox.')).toBeInTheDocument()
  })
})
