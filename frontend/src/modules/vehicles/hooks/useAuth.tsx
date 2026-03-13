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
 * Exchange a freelancerToken from the freelancer portal for a scoped session.
 */
async function exchangeFreelancerToken(freelancerToken: string): Promise<{
  sessionToken: string
  expiresAt: string
  jobId: string
  driverEmail: string
} | { error: string }> {
  try {
    const response = await apiFetch('/validate-freelancer-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freelancerToken }),
    })

    const data = (await response.json()) as {
      valid: boolean
      sessionToken?: string
      expiresAt?: string
      jobId?: string
      driverEmail?: string
      error?: string
    }

    if (data.valid && data.sessionToken && data.expiresAt && data.jobId && data.driverEmail) {
      return {
        sessionToken: data.sessionToken,
        expiresAt: data.expiresAt,
        jobId: data.jobId,
        driverEmail: data.driverEmail,
      }
    }

    return { error: data.error || `Token validation failed (HTTP ${response.status})` }
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
        scope: 'staff',
        freelancerContext: null,
        freelancerError: null,
        login: () => { /* no-op in embedded mode */ },
        logout: opState.logout,
      }
    }
    throw new Error('useAuth must be used within an AuthProvider or in embedded mode (call initVehicleModule first)')
  }

  return context
}
