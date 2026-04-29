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

import { getFreelancerSession, clearFreelancerSession } from './freelancer-session'
import type { FreelancerBookoutContext } from './freelancer-session'

export type SessionScope = 'staff' | 'freelancer'

/** Context passed to BookOutPage when running in freelancer scope. */
export interface FreelancerContext {
  /** HireHop job number as string (preferred) or OP job UUID (fallback) */
  jobId: string
  driverEmail: string
  /** The freelancer's display name (the DELIVERY person, not the driver) */
  driverName: string
  vehicleId: string
  vehicleReg: string
  vehicleMakeModel: string
  vehicleType: string | null
  assignmentId: string
  /** The customer's name — drives the PDF "Driver" field + signature label */
  customerDriverName: string | null
  /** The customer's email — drives the hire agreement email recipient */
  customerDriverEmail: string | null
  returnUrl: string | null
}

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
  /** Present only when scope === 'freelancer' */
  freelancerContext: FreelancerContext | null
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
 *
 * If a freelancer book-out session is active (localStorage has
 * `ooosh_freelancer_bookout_session`), that takes precedence over the
 * staff store — the embedded vehicle module then runs in freelancer scope
 * and BookOutPage gets the scoped context. Logout clears the freelancer
 * session (not the staff session, which may well be valid in another tab).
 */
export function getOpAuthState(): AuthAdapterState | null {
  if (!opAuthStoreGetter) return null

  // Freelancer session takes precedence when present.
  const fs = getFreelancerSession()
  if (fs) {
    return {
      isAuthenticated: true,
      isLoading: false,
      scope: 'freelancer',
      userName: fs.context.driverName,
      userEmail: fs.context.driverEmail,
      userRole: null,
      token: fs.token,
      freelancerContext: freelancerContextFromStorage(fs.context),
      logout: clearFreelancerSession,
    }
  }

  const state = opAuthStoreGetter()
  return {
    isAuthenticated: state.isAuthenticated,
    isLoading: false,
    scope: 'staff',
    userName: state.user ? `${state.user.first_name} ${state.user.last_name}`.trim() : null,
    userEmail: state.user?.email ?? null,
    userRole: state.user?.role ?? null,
    token: state.accessToken,
    freelancerContext: null,
    logout: state.logout,
  }
}

function freelancerContextFromStorage(ctx: FreelancerBookoutContext): FreelancerContext {
  return {
    jobId: ctx.hhJobNumber ?? ctx.opJobId,
    driverEmail: ctx.driverEmail,
    driverName: ctx.driverName,
    vehicleId: ctx.vehicleId,
    vehicleReg: ctx.vehicleReg,
    vehicleMakeModel: ctx.vehicleMakeModel,
    vehicleType: ctx.vehicleType,
    assignmentId: ctx.assignmentId,
    customerDriverName: ctx.customerDriverName,
    customerDriverEmail: ctx.customerDriverEmail,
    returnUrl: ctx.returnUrl,
  }
}
