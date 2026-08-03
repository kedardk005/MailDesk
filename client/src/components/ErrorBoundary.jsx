import { Component } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './ui/Button'

/**
 * The app previously had ZERO error boundaries — a single throw anywhere
 * produced a white screen (the Tasks page throws on every filter click).
 *
 * One boundary wraps the router; a second wraps each lazy route, so a broken
 * page degrades to an inline error with the shell and navigation intact.
 *
 * @param {string} [title]
 * @param {string} [description]
 * @param {boolean} [compact] - inline variant for a route/panel
 * @param {(error, info) => void} [onError]
 * @param {any} [resetKey] - changing this remounts the subtree (e.g. location.key)
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info?.componentStack)
    this.props.onError?.(error, info)
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    const {
      title = 'Something went wrong on this screen',
      description = 'The error has been logged. You can retry, or move to another section using the navigation.',
      compact = false,
      fallback,
    } = this.props

    if (fallback) {
      return typeof fallback === 'function'
        ? fallback(error, () => this.setState({ error: null }))
        : fallback
    }

    return (
      <div
        role="alert"
        className={
          compact
            ? 'm-6 rounded-lg border border-danger-border bg-danger-subtle p-5'
            : 'flex min-h-screen items-center justify-center bg-canvas p-6'
        }
      >
        <div className={compact ? '' : 'w-full max-w-[440px] rounded-lg border border-line bg-surface p-6'}>
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-danger-subtle text-danger">
              <AlertTriangle aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-fg">{title}</h2>
              <p className="mt-1 text-sm text-fg-3">{description}</p>
              {import.meta.env?.DEV ? (
                <pre className="mt-3 max-h-40 overflow-auto rounded border border-line bg-subtle p-2 text-2xs text-fg-2">
                  {String(error?.stack || error?.message || error)}
                </pre>
              ) : null}
              <div className="mt-4 flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
                  onClick={() => this.setState({ error: null })}
                >
                  Try again
                </Button>
                <Button variant="secondary" size="sm" onClick={() => window.location.reload()}>
                  Reload the app
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
