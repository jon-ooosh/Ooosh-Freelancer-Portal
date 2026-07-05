/**
 * Freelancer book-out session storage.
 *
 * Freelancers land on /vehicles/book-out with an HMAC token minted by the
 * portal. The shell exchanges that token for a scoped session JWT via
 * POST /api/vehicles/freelancer-bookout/resolve. This module owns the
 * client-side storage for that session.
 *
 * Storage is deliberately separate from the staff auth (useAuthStore):
 *   - Staff token lives at 'ooosh_access_token'
 *   - Freelancer session lives under 'ooosh_freelancer_bookout_*' keys
 * No cross-contamination — a freelancer never writes to the staff store,
 * a staff user never reads the freelancer store.
 *
 * The session JWT is narrow: server-side it only authorises writes to a
 * specific vehicle_hire_assignment and 4h TTL. Session expiry is tracked
 * locally so we can show "session expired, go back to portal" cleanly
 * rather than letting the JWT 401 in the middle of a walkaround.
 */

const KEY_SESSION = 'ooosh_freelancer_bookout_session'
const KEY_CONTEXT = 'ooosh_freelancer_bookout_context'
const KEY_EXPIRY = 'ooosh_freelancer_bookout_expiry'

/** Stored on resolve success — everything BookOutPage needs to pre-fill. */
export interface FreelancerBookoutContext {
  /** vehicle_hire_assignments.id — scope of the session JWT */
  assignmentId: string
  /** fleet_vehicles.id — for matching against useVehicles list */
  vehicleId: string
  /** Vehicle registration (uppercased, e.g. 'RX24SZC') */
  vehicleReg: string
  /** "Mercedes Sprinter" or similar (for display only) */
  vehicleMakeModel: string
  /** Vehicle type label ("Premium LWB", "Basic MWB" etc.) — for the PDF */
  vehicleType: string | null
  /** OP quote UUID (from the HMAC token) */
  quoteId: string
  /** HireHop job number as string — what BookOutPage expects for job lookup */
  hhJobNumber: string | null
  /** OP jobs.id UUID — fallback when hhJobNumber is null (pre-HH-sync) */
  opJobId: string
  /** Venue display string */
  venueName: string | null
  /** Freelancer display name (the DELIVERY person, not the driver) */
  driverName: string
  /** Freelancer email */
  driverEmail: string
  /**
   * The CUSTOMER's name (the actual driver who signs the hire agreement).
   * Distinct from driverName which is the freelancer doing the delivery.
   * Used for: PDF "Driver" field, signature label, hire agreement email.
   * May be null if the customer hasn't yet submitted their hire form —
   * caller should block book-out with a clear message.
   */
  customerDriverName: string | null
  /** The customer's email — recipient for the hire agreement PDF */
  customerDriverEmail: string | null
  /** Where to send them after book-out completes (portal completion page) */
  returnUrl: string | null
}

export function setFreelancerSession(
  sessionToken: string,
  context: FreelancerBookoutContext,
  ttlMs = 4 * 60 * 60 * 1000,
): void {
  try {
    const expiry = new Date(Date.now() + ttlMs).toISOString()
    localStorage.setItem(KEY_SESSION, sessionToken)
    localStorage.setItem(KEY_CONTEXT, JSON.stringify(context))
    localStorage.setItem(KEY_EXPIRY, expiry)
  } catch (err) {
    console.error('[freelancer-session] Failed to persist session:', err)
  }
}

/**
 * Read the current freelancer session (if any).
 * Returns null and clears storage if expired.
 */
export function getFreelancerSession(): {
  token: string
  context: FreelancerBookoutContext
  expiry: string
} | null {
  try {
    const token = localStorage.getItem(KEY_SESSION)
    const contextRaw = localStorage.getItem(KEY_CONTEXT)
    const expiry = localStorage.getItem(KEY_EXPIRY)

    if (!token || !contextRaw || !expiry) return null

    if (new Date(expiry) <= new Date()) {
      clearFreelancerSession()
      return null
    }

    const context = JSON.parse(contextRaw) as FreelancerBookoutContext
    return { token, context, expiry }
  } catch {
    clearFreelancerSession()
    return null
  }
}

export function clearFreelancerSession(): void {
  try {
    localStorage.removeItem(KEY_SESSION)
    localStorage.removeItem(KEY_CONTEXT)
    localStorage.removeItem(KEY_EXPIRY)
  } catch {
    /* ignore */
  }
}

export function isFreelancerSessionActive(): boolean {
  return getFreelancerSession() !== null
}

/**
 * Resolve an HMAC token (from the portal) for a scoped session JWT.
 * Returns the stored session on success; a string error message on failure.
 */
export async function resolveFreelancerToken(
  opBaseUrl: string,
  hmacToken: string,
  returnUrl: string | null,
  resolvePath: 'freelancer-bookout/resolve' | 'freelancer-checkin/resolve' = 'freelancer-bookout/resolve',
): Promise<
  | { ok: true; token: string; context: FreelancerBookoutContext }
  | { ok: false; error: string; code?: string }
> {
  try {
    const response = await fetch(`${opBaseUrl}/${resolvePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: hmacToken }),
    })

    const data = (await response.json().catch(() => ({}))) as {
      success?: boolean
      sessionToken?: string
      assignment?: {
        id: string
        vehicleId: string
        registration: string
        makeModel: string
        vehicleType: string | null
        status: string
        customerDriver: { name: string; email: string | null } | null
      }
      job?: { id: string; hhJobNumber: number | string | null; venueName: string | null }
      driver?: { name: string; email: string }
      error?: string
      code?: string
      hint?: string
    }

    if (!response.ok || !data.success || !data.sessionToken || !data.assignment || !data.job || !data.driver) {
      const msg = data.error
        ? data.hint ? `${data.error}. ${data.hint}` : data.error
        : `Token exchange failed (HTTP ${response.status})`
      return { ok: false, error: msg, code: data.code }
    }

    const context: FreelancerBookoutContext = {
      assignmentId: data.assignment.id,
      vehicleId: data.assignment.vehicleId,
      vehicleReg: (data.assignment.registration || '').toUpperCase(),
      vehicleMakeModel: data.assignment.makeModel || '',
      vehicleType: data.assignment.vehicleType ?? null,
      quoteId: '', // not surfaced in resolve response; not needed client-side
      hhJobNumber: data.job.hhJobNumber != null ? String(data.job.hhJobNumber) : null,
      opJobId: data.job.id,
      venueName: data.job.venueName,
      driverName: data.driver.name,
      driverEmail: data.driver.email,
      customerDriverName: data.assignment.customerDriver?.name ?? null,
      customerDriverEmail: data.assignment.customerDriver?.email ?? null,
      returnUrl,
    }

    return { ok: true, token: data.sessionToken, context }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error contacting OP backend',
    }
  }
}

/**
 * Resolve a COLLECTION (check-in) token — same shape as book-out, but hits the
 * check-in resolver, which targets the van currently OUT on the job and mints a
 * checkin-mode session (soft check-in, no 'returned' flip).
 */
export function resolveFreelancerCheckinToken(
  opBaseUrl: string,
  hmacToken: string,
  returnUrl: string | null,
) {
  return resolveFreelancerToken(opBaseUrl, hmacToken, returnUrl, 'freelancer-checkin/resolve')
}
