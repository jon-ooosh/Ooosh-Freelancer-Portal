/**
 * Freelancer PREP session storage (STAFF-CALENDAR-SPEC §21.6).
 *
 * A freelancer taps "Open prep sheet" on the portal and lands on
 * /vehicles/freelancer-prep?prepToken=… with a 15-minute redeem token. The
 * shell swaps it for a 4h session scoped to ONE van (POST
 * /api/vehicles/freelancer-prep/resolve) and keeps it here.
 *
 * Separate keys from both the staff login and the book-out session: a phone
 * that did a delivery this morning can hold a book-out session too, and the
 * two must never stand in for each other. Which one a request carries is
 * decided by the PAGE (see isOnFreelancerPrepPage), not by which happens to
 * be stored.
 */

const KEY_SESSION = 'ooosh_freelancer_prep_session'
const KEY_CONTEXT = 'ooosh_freelancer_prep_context'
const KEY_EXPIRY = 'ooosh_freelancer_prep_expiry'

export const FREELANCER_PREP_PATH = '/vehicles/freelancer-prep'

export interface FreelancerPrepContext {
  taskId: string
  taskTitle: string
  vehicleId: string
  vehicleReg: string
  vehicleType: string | null
  /** The freelancer — "Prepared by". */
  personName: string
  date: string
  /** Back to the portal (their dashboard or shift page). */
  returnUrl: string | null
}

export { safeReturnUrl } from '../lib/safe-url'

export function isOnFreelancerPrepPage(): boolean {
  try {
    return window.location.pathname.startsWith(FREELANCER_PREP_PATH)
  } catch {
    return false
  }
}

export function setFreelancerPrepSession(token: string, context: FreelancerPrepContext, ttlSeconds: number): void {
  try {
    localStorage.setItem(KEY_SESSION, token)
    localStorage.setItem(KEY_CONTEXT, JSON.stringify(context))
    localStorage.setItem(KEY_EXPIRY, new Date(Date.now() + ttlSeconds * 1000).toISOString())
  } catch (err) {
    console.error('[freelancer-prep-session] Failed to persist session:', err)
  }
}

export function getFreelancerPrepSession(): { token: string; context: FreelancerPrepContext } | null {
  try {
    const token = localStorage.getItem(KEY_SESSION)
    const raw = localStorage.getItem(KEY_CONTEXT)
    const expiry = localStorage.getItem(KEY_EXPIRY)
    if (!token || !raw || !expiry) return null
    const exp = new Date(expiry)
    if (Number.isNaN(exp.getTime()) || exp <= new Date()) {
      clearFreelancerPrepSession()
      return null
    }
    const context = JSON.parse(raw) as FreelancerPrepContext
    if (!context?.vehicleReg || !context?.taskId) {
      clearFreelancerPrepSession()
      return null
    }
    return { token, context }
  } catch {
    clearFreelancerPrepSession()
    return null
  }
}

export function clearFreelancerPrepSession(): void {
  try {
    localStorage.removeItem(KEY_SESSION)
    localStorage.removeItem(KEY_CONTEXT)
    localStorage.removeItem(KEY_EXPIRY)
  } catch {
    /* ignore */
  }
}

export type PrepResolveResult =
  | { kind: 'ok'; token: string; context: FreelancerPrepContext; ttlSeconds: number }
  | { kind: 'error'; error: string }

/** Swap the redeem token from the URL for a session. Never throws. */
export async function resolveFreelancerPrepToken(prepToken: string, returnUrl: string | null): Promise<PrepResolveResult> {
  try {
    const res = await fetch('/api/vehicles/freelancer-prep/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: prepToken }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      token?: string
      expiresIn?: number
      context?: Omit<FreelancerPrepContext, 'returnUrl'>
      error?: string
    }
    if (!res.ok || !data.token || !data.context) {
      return { kind: 'error', error: data.error || 'Could not open the prep sheet.' }
    }
    return {
      kind: 'ok',
      token: data.token,
      context: { ...data.context, returnUrl },
      ttlSeconds: data.expiresIn ?? 4 * 60 * 60,
    }
  } catch {
    return { kind: 'error', error: 'Could not reach the server — check your signal and try again.' }
  }
}
