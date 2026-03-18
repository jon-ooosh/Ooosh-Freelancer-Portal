/**
 * Auth Adapter — bridges between the VM's useAuth and the OP's useAuthStore.
 *
 * In standalone mode: VM's own AuthProvider/useAuth is used (session tokens, PIN login).
 * In embedded mode:   The OP's Zustand auth store is injected here, and the VM's
 *                     useAuth hook reads from this adapter instead.
 *
 * The adapter exposes the same interface as VM's useAuth so that all VM components
 * can import from here without knowing which auth system is backing them.
 *
 * ─── OP Auth Store Interface (for reference) ───
 *
 *   interface User {
 *     id: string
 *     email: string
 *     role: string        // 'admin' | 'manager' | 'staff' | 'general_assistant' | 'weekend_manager'
 *     first_name: string
 *     last_name: string
 *   }
 *
 *   interface AuthState {
 *     user: User | null
 *     accessToken: string | null
 *     refreshToken: string | null
 *     isAuthenticated: boolean
 *     login: (user, accessToken, refreshToken) => void
 *     logout: () => void
 *     setTokens: (accessToken, refreshToken) => void
 *   }
 *
 * Tokens stored in localStorage: ooosh_access_token, ooosh_refresh_token, ooosh_user.
 * The OP's api service adds Authorization: Bearer <token> to every request automatically.
 */

export type SessionScope = 'staff' | 'freelancer'

export interface AuthAdapterState {
  isAuthenticated: boolean
  isLoading: boolean
  scope: SessionScope
  /** Display name for the current user (used in prep/book-out "prepared by" fields) */
  userName: string | null
  /** User email (used for email-related features) */
  userEmail: string | null
  /** User role from OP auth (admin, manager, staff, etc.) */
  userRole: string | null
  /** Session token (VM standalone) or access token (OP embedded) */
  token: string | null
  logout: () => void
}

/**
 * Injected OP auth store getter.
 * Set via `setOpAuthStore()` during OP integration init.
 */
let opAuthStoreGetter: (() => {
  user: { id: string; email: string; role: string; first_name: string; last_name: string } | null
  accessToken: string | null
  isAuthenticated: boolean
  logout: () => void
}) | null = null

/**
 * Inject the OP's Zustand auth store.
 * Called once during OP integration setup.
 *
 * Example:
 *   import { useAuthStore } from '../hooks/useAuthStore'
 *   setOpAuthStore(() => useAuthStore.getState())
 */
export function setOpAuthStore(getter: NonNullable<typeof opAuthStoreGetter>) {
  opAuthStoreGetter = getter
}

/**
 * Check whether we're running in embedded (OP) mode.
 */
export function isEmbeddedMode(): boolean {
  return opAuthStoreGetter !== null
}

/**
 * Get auth state from the OP store (embedded mode only).
 * Returns null if not in embedded mode.
 */
export function getOpAuthState(): AuthAdapterState | null {
  if (!opAuthStoreGetter) return null

  const state = opAuthStoreGetter()
  return {
    isAuthenticated: state.isAuthenticated,
    isLoading: false,
    scope: 'staff',
    userName: state.user ? `${state.user.first_name} ${state.user.last_name}`.trim() : null,
    userEmail: state.user?.email ?? null,
    userRole: state.user?.role ?? null,
    token: state.accessToken,
    logout: state.logout,
  }
}
