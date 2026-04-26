import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { apiFetch } from '../config/api-config'
import { getOpAuthState } from '../adapters/auth-adapter'

type SessionScope = 'staff' | 'freelancer'

interface FreelancerContext {
  jobId: string
  driverEmail: string
  returnUrl: string | null
  // Optional fields populated in embedded mode (OP-issued scoped session).
  // BookOutPage uses these to pre-fill vehicle + skip the select-vehicle step.
  driverName?: string
  vehicleId?: string
  vehicleReg?: string
  vehicleMakeModel?: string
  assignmentId?: string
}

interface AuthState {
  isAuthenticated: boolean
  isLoading: boolean
  sessionToken: string | null
  scope: SessionScope
  freelancerContext: FreelancerContext | null
  freelancerError: string | null
  login: (token: string, expiresAt: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

const STORAGE_KEY_TOKEN = 'vehicleAppSession'
const STORAGE_KEY_EXPIRY = 'vehicleAppSessionExpiry'
const STORAGE_KEY_SCOPE = 'vehicleAppSessionScope'
const STORAGE_KEY_FREELANCER = 'vehicleAppFreelancerContext'

/**
 * Checks localStorage for a non-expired session token.
 */
function getStoredSession(): { token: string; scope: SessionScope; freelancerContext: FreelancerContext | null } | null {
  try {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN)
    const expiry = localStorage.getItem(STORAGE_KEY_EXPIRY)

    if (token && expiry && new Date(expiry) > new Date()) {
      const scope = (localStorage.getItem(STORAGE_KEY_SCOPE) as SessionScope) || 'staff'
      let freelancerContext: FreelancerContext | null = null
      const stored = localStorage.getItem(STORAGE_KEY_FREELANCER)
      if (stored) {
        try { freelancerContext = JSON.parse(stored) } catch { /* ignore */ }
      }
      return { token, scope, freelancerContext }
    }

    // Expired or missing — clean up
    clearStorage()
    return null
  } catch {
    return null
  }
}

function clearStorage() {
  localStorage.removeItem(STORAGE_KEY_TOKEN)
  localStorage.removeItem(STORAGE_KEY_EXPIRY)
  localStorage.removeItem(STORAGE_KEY_SCOPE)
  localStorage.removeItem(STORAGE_KEY_FREELANCER)
}

/**
 * Exchange a hubToken from the staff hub for a session.
 */
async function exchangeHubToken(hubToken: string): Promise<{
  sessionToken: string
  expiresAt: string
} | null> {
  try {
    const response = await apiFetch('/validate-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hubToken }),
    })

    const data = (await response.json()) as {
      valid: boolean
      sessionToken?: string
      expiresAt?: string
    }

    if (data.valid && data.sessionToken && data.expiresAt) {
      return { sessionToken: data.sessionToken, expiresAt: data.expiresAt }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Exchange a freelancerToken from the freelancer portal for a scoped
 * book-out session. Hits OP's /api/vehicles/freelancer-bookout/resolve
 * (replaces the legacy Netlify /validate-freelancer-token when the
 * vehicle module is embedded in OP).
 *
 * The OP endpoint returns the already-allocated assignment + vehicle
 * so the book-out flow can skip the "pick a van" step entirely.
 */
async function exchangeFreelancerToken(freelancerToken: string): Promise<{
  sessionToken: string
  expiresAt: string
  jobId: string
  driverEmail: string
} | { error: string }> {
  try {
    const response = await apiFetch('/freelancer-bookout/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: freelancerToken }),
    })

    const data = (await response.json()) as {
      success?: boolean
      sessionToken?: string
      assignment?: { id: string; vehicleId: string; registration: string; makeModel: string; status: string }
      job?: { id: string; hhJobNumber: number | string | null; venueName: string | null }
      driver?: { name: string; email: string }
      error?: string
      code?: string
      hint?: string
    }

    if (data.success && data.sessionToken && data.job && data.driver?.email) {
      // Session JWT lives 4h server-side — expose an expiresAt in the
      // same shape the local storage helpers already use.
      const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
      // BookOutPage expects jobId as a numeric HireHop job number
      // (parseInt). Fall back to the OP UUID if no HH number is
      // linked yet — downstream code handles both shapes in its
      // job-lookup paths.
      const jobIdForPage = data.job.hhJobNumber != null
        ? String(data.job.hhJobNumber)
        : data.job.id
      return {
        sessionToken: data.sessionToken,
        expiresAt,
        jobId: jobIdForPage,
        driverEmail: data.driver.email,
      }
    }

    // Surface hint if the allocation hasn't happened yet — more useful
    // than a generic "Token validation failed".
    const errorMsg = data.error
      ? data.hint ? `${data.error}. ${data.hint}` : data.error
      : `Token validation failed (HTTP ${response.status})`
    return { error: errorMsg }
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error connecting to server' }
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [sessionToken, setSessionToken] = useState<string | null>(null)
  const [scope, setScope] = useState<SessionScope>('staff')
  const [freelancerContext, setFreelancerContext] = useState<FreelancerContext | null>(null)
  const [freelancerError, setFreelancerError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  const login = useCallback((token: string, expiresAt: string) => {
    localStorage.setItem(STORAGE_KEY_TOKEN, token)
    localStorage.setItem(STORAGE_KEY_EXPIRY, expiresAt)
    setSessionToken(token)
  }, [])

  const loginFreelancer = useCallback((
    token: string,
    expiresAt: string,
    ctx: FreelancerContext,
  ) => {
    localStorage.setItem(STORAGE_KEY_TOKEN, token)
    localStorage.setItem(STORAGE_KEY_EXPIRY, expiresAt)
    localStorage.setItem(STORAGE_KEY_SCOPE, 'freelancer')
    localStorage.setItem(STORAGE_KEY_FREELANCER, JSON.stringify(ctx))
    setSessionToken(token)
    setScope('freelancer')
    setFreelancerContext(ctx)
  }, [])

  const logout = useCallback(() => {
    clearStorage()
    setSessionToken(null)
    setScope('staff')
    setFreelancerContext(null)
  }, [])

  useEffect(() => {
    async function init() {
      const params = new URLSearchParams(window.location.search)

      // 1. Check for freelancerToken in URL (from freelancer portal)
      const freelancerToken = params.get('freelancerToken')
      if (freelancerToken) {
        const returnUrl = params.get('returnUrl')

        const result = await exchangeFreelancerToken(freelancerToken)
        if ('error' in result) {
          // Token exchange failed — show error, keep URL intact for debugging
          console.error('[freelancer-auth] Token exchange failed:', result.error)
          setFreelancerError(result.error)
          setIsLoading(false)
          return
        }

        // Success — clean URL and set up session
        const cleanUrl = new URL(window.location.href)
        cleanUrl.searchParams.delete('freelancerToken')
        cleanUrl.searchParams.delete('returnUrl')
        window.history.replaceState({}, '', cleanUrl.toString())

        loginFreelancer(result.sessionToken, result.expiresAt, {
          jobId: result.jobId,
          driverEmail: result.driverEmail,
          returnUrl,
        })
        setIsLoading(false)
        return
      }

      // 2. Check for hubToken in URL (staff hub handoff)
      const hubToken = params.get('hubToken')
      if (hubToken) {
        const cleanUrl = new URL(window.location.href)
        cleanUrl.searchParams.delete('hubToken')
        window.history.replaceState({}, '', cleanUrl.toString())

        const result = await exchangeHubToken(hubToken)
        if (result) {
          login(result.sessionToken, result.expiresAt)
          setIsLoading(false)
          return
        }
      }

      // 3. Check for existing session in localStorage
      const existing = getStoredSession()
      if (existing) {
        setSessionToken(existing.token)
        setScope(existing.scope)
        setFreelancerContext(existing.freelancerContext)
      }

      setIsLoading(false)
    }

    init()
  }, [login, loginFreelancer])

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: sessionToken !== null,
        isLoading,
        sessionToken,
        scope,
        freelancerContext,
        freelancerError,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

/**
 * useAuth — works in both standalone and embedded (OP) mode.
 *
 * Standalone: reads from AuthContext (AuthProvider wraps the app).
 * Embedded:   reads from the OP's Zustand auth store via the auth adapter.
 *             No AuthProvider needed — returns a compatible AuthState.
 */
export function useAuth(): AuthState {
  const context = useContext(AuthContext)

  // Embedded mode: no AuthProvider, use OP auth adapter instead
  if (!context) {
    const opState = getOpAuthState()
    if (opState) {
      return {
        isAuthenticated: opState.isAuthenticated,
        isLoading: false,
        sessionToken: opState.token,
        scope: opState.scope,
        freelancerContext: opState.freelancerContext
          ? {
              jobId: opState.freelancerContext.jobId,
              driverEmail: opState.freelancerContext.driverEmail,
              returnUrl: opState.freelancerContext.returnUrl,
              driverName: opState.freelancerContext.driverName,
              vehicleId: opState.freelancerContext.vehicleId,
              vehicleReg: opState.freelancerContext.vehicleReg,
              vehicleMakeModel: opState.freelancerContext.vehicleMakeModel,
              assignmentId: opState.freelancerContext.assignmentId,
            }
          : null,
        freelancerError: null,
        login: () => { /* no-op in embedded mode */ },
        logout: opState.logout,
      }
    }
    throw new Error('useAuth must be used within an AuthProvider or in embedded mode (call initVehicleModule first)')
  }

  return context
}
