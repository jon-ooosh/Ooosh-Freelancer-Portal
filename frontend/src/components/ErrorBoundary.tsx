import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * localStorage keys that must SURVIVE a "reset view settings" — anything
 * that holds a session. Everything else in localStorage is a view
 * preference (collapsed sections, sort orders, board modes) and is safe to
 * clear. Allowlisting the session keys rather than listing every pref key
 * means dynamically-named prefs are covered too, and a new pref added
 * later needs no change here.
 */
const SESSION_KEYS = new Set([
  'ooosh_access_token',
  'ooosh_refresh_token',
  'ooosh_user',
  'vehicleAppSession',
  'vehicleAppSessionExpiry',
  'vehicleAppSessionScope',
  'vehicleAppFreelancerContext',
])

/**
 * Clear every persisted view preference, keeping the user logged in.
 *
 * This is the escape hatch for a persisted preference that puts a page
 * straight back into a crashing state on reload — e.g. `fleet-view-mode`,
 * which pinned Fleet to a table view that threw on bad data, so reloading
 * just re-crashed (Sep 2026).
 */
function resetViewPreferences(): void {
  try {
    const doomed = Object.keys(localStorage).filter(k => !SESSION_KEYS.has(k))
    for (const key of doomed) localStorage.removeItem(key)
  } catch {
    // Private mode / blocked storage — nothing to reset, carry on.
  }
}

interface Props {
  children: React.ReactNode
  /** Changing this clears a caught error — we pass the current pathname. */
  resetKey: string
  onGoHome: () => void
}

interface State {
  error: Error | null
  componentStack: string | null
}

class ErrorBoundaryInner extends React.Component<Props, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the console trace — it's how we diagnosed the Fleet crash.
    console.error('[ErrorBoundary] Render error:', error, info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  componentDidUpdate(prev: Props): void {
    // Navigating away clears the error so the rest of the app stays usable.
    // Deliberately does NOT re-key the children — page state survives normal
    // navigation exactly as it did before this boundary existed.
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, componentStack: null })
    }
  }

  private retry = (): void => this.setState({ error: null, componentStack: null })

  private resetPrefs = (): void => {
    resetViewPreferences()
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div className="mx-auto max-w-2xl p-4 sm:p-6">
        <div className="rounded-lg border border-red-200 bg-white p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-gray-900">This section hit an error</h2>
          <p className="mt-2 text-sm text-gray-600">
            The rest of the platform is still working — use the menu above to carry on,
            or try one of the options below.
          </p>

          <div className="mt-4 rounded-md bg-red-50 px-3 py-2 font-mono text-xs break-words text-red-800">
            {error.message || String(error)}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <button
              onClick={this.retry}
              className="rounded-md bg-ooosh-navy px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Try again
            </button>
            <button
              onClick={this.props.onGoHome}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Back to dashboard
            </button>
            <button
              onClick={this.resetPrefs}
              title="Clears saved view settings (sort orders, board modes, collapsed sections). You stay logged in."
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Reset saved view settings
            </button>
          </div>

          <p className="mt-3 text-xs text-gray-400">
            If this keeps happening, send a screenshot of the message above — it names the fault.
          </p>

          {componentStack && (
            <details className="mt-4">
              <summary className="cursor-pointer text-xs text-gray-500">Technical detail</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded bg-gray-50 p-3 text-[11px] leading-relaxed text-gray-600">
                {componentStack}
              </pre>
            </details>
          )}
        </div>
      </div>
    )
  }
}

/**
 * Catches render errors in the subtree and shows a recoverable panel instead
 * of unmounting the whole SPA to a white page.
 *
 * Mounted twice in App: once INSIDE Layout (so a page crash keeps the nav
 * usable) and once around the whole app (a backstop for Layout itself and
 * the public, Layout-less routes).
 */
export default function ErrorBoundary({ children }: { children: React.ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <ErrorBoundaryInner resetKey={location.pathname} onGoHome={() => navigate('/')}>
      {children}
    </ErrorBoundaryInner>
  )
}
