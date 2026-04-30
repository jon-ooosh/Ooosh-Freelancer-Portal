/**
 * Ooosh Operations Platform API Client
 *
 * Replaces Monday.com as the data source for the freelancer portal.
 * Uses the /api/portal/* endpoints on the OP backend.
 *
 * Feature flag: DATA_BACKEND=op  (default: monday)
 * Env vars: OP_BACKEND_URL (e.g. https://staff.oooshtours.co.uk)
 */

// =============================================================================
// CONFIG
// =============================================================================

export function isOpMode(): boolean {
  return process.env.DATA_BACKEND === 'op'
}

function getOpUrl(): string {
  const url = process.env.OP_BACKEND_URL
  if (!url) {
    throw new Error('OP_BACKEND_URL environment variable is not set')
  }
  return url.replace(/\/$/, '') // strip trailing slash
}

// =============================================================================
// TYPES (matching portal API response shapes)
// =============================================================================

export interface PortalJob {
  id: string
  name: string
  board: 'dc' | 'crew'
  type: string
  date: string | null
  finishDate?: string | null
  time: string | null
  venueName: string | null
  venueId: string | null
  driverPay: number
  runGroup: string | null
  runOrder: number | null
  runGroupFee: number | null
  // When set, this is the combined fee the freelancer is offered for
  // the whole run (overrides summing individual driverPay values).
  runCombinedFreelancerFee: number | null
  runCombinedClientFee: number | null
  runNotes: string | null
  hhRef: string | null
  status: string
  opsStatus: string
  keyNotes: string | null
  completedAtDate: string | null
  completionNotes: string | null
  isLocal: boolean
  isGrouped: false
  // D&C specific
  whatIsIt?: string
  clientEmail?: string | null
  // Crew specific
  workType?: string | null
  workTypeOther?: string | null
  workDurationHours?: number | null
  workDescription?: string | null
  numberOfDays?: number | null
  jobType?: string
  freelancerFee?: number
  distanceMiles?: number | null
  driveTimeMinutes?: number | null
}

export interface PortalJobsResponse {
  success: boolean
  user?: {
    id: string
    name: string
    email: string
  }
  today?: PortalJob[]
  upcoming?: PortalJob[]
  completed?: PortalJob[]
  cancelled?: PortalJob[]
  error?: string
}

export interface PortalJobDetailResponse {
  success: boolean
  job: PortalJob
  venue?: {
    id: string
    name: string
    address?: string
    whatThreeWords?: string
    contact1?: string
    phone?: string | null
    email?: string
    accessNotes?: string
    phoneHidden?: boolean
    phoneVisibleFrom?: string | null
  } | null
  contactsVisible: boolean
  boardType: 'dc' | 'crew'
}

export interface PortalEquipmentItem {
  id: string | number
  name: string
  quantity: number
  category: string
  categoryId: number | null
}

export interface PortalEquipmentResponse {
  success: boolean
  items: PortalEquipmentItem[]
  whatIsIt?: string
  message?: string
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Make an authenticated request to the OP backend portal API.
 * Forwards the session cookie from the incoming request.
 */
async function opFetch<T>(
  path: string,
  sessionToken: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${getOpUrl()}/api/portal${path}`

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${sessionToken}`,
      ...(options.headers as Record<string, string> || {}),
    },
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new Error(body.error || `OP API error: ${response.status}`)
  }

  return response.json()
}

/**
 * Fetch all jobs for the logged-in freelancer from OP backend.
 * Returns data in the same shape the dashboard page expects.
 */
export async function getJobsFromOP(sessionToken: string): Promise<PortalJobsResponse> {
  return opFetch<PortalJobsResponse>('/jobs', sessionToken)
}

/**
 * Fetch a single job detail from OP backend.
 */
export async function getJobDetailFromOP(
  sessionToken: string,
  quoteId: string
): Promise<PortalJobDetailResponse> {
  return opFetch<PortalJobDetailResponse>(`/jobs/${quoteId}`, sessionToken)
}

/**
 * Fetch equipment list for a job from OP backend (via HireHop broker).
 */
export async function getEquipmentFromOP(
  sessionToken: string,
  quoteId: string
): Promise<PortalEquipmentResponse> {
  return opFetch<PortalEquipmentResponse>(`/jobs/${quoteId}/equipment`, sessionToken)
}

/**
 * Notification settings — read.
 * Mirrors the response shape the Settings page used to get from Monday.
 */
export interface PortalNotificationSettingsResponse {
  success: boolean
  notifications: {
    globalMuteActive: boolean
    globalMuteUntil: string | null
    mutedJobIds: string[]
    mutedJobCount: number
  }
}

export async function getNotificationSettingsFromOP(
  sessionToken: string
): Promise<PortalNotificationSettingsResponse> {
  return opFetch<PortalNotificationSettingsResponse>('/settings/notifications', sessionToken)
}

/**
 * Notification settings — update. Same body shape as the Monday-era POST
 * (action + optional muteType / muteUntilDate / jobId).
 */
export async function updateNotificationSettingsOnOP(
  sessionToken: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; message?: string; mutedUntil?: string; jobId?: string }> {
  return opFetch('/settings/notifications', sessionToken, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

/**
 * Submit job completion from OP backend.
 */
export async function submitCompletionToOP(
  sessionToken: string,
  quoteId: string,
  formData: FormData
): Promise<{ success: boolean; message?: string }> {
  const url = `${getOpUrl()}/api/portal/jobs/${quoteId}/complete`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Cookie': `session=${sessionToken}`,
    },
    body: formData, // multipart/form-data (photos + signature)
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new Error(body.error || `Completion failed: ${response.status}`)
  }

  return response.json()
}

/**
 * Login to OP portal (create session).
 */
export async function loginToOP(
  email: string,
  password: string
): Promise<{ success: boolean; user?: { id: string; name: string; email: string }; sessionToken?: string; error?: string; status?: number }> {
  const url = `${getOpUrl()}/api/portal/auth/login`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const data = await response.json()

  if (!response.ok) {
    return { success: false, error: data.error || 'Login failed', status: response.status }
  }

  // Extract session cookie from response
  const setCookie = response.headers.get('set-cookie')
  let sessionToken: string | undefined
  if (setCookie) {
    const match = setCookie.match(/session=([^;]+)/)
    if (match) sessionToken = match[1]
  }

  return { success: true, user: data.user, sessionToken }
}

// =============================================================================
// REGISTRATION + PASSWORD RESET (OP mode)
// =============================================================================

async function opPostJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${getOpUrl()}/api/portal${path}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  return data
}

export async function registerStartOP(email: string): Promise<{ success: boolean; message?: string }> {
  return opPostJson('/auth/register/start', { email })
}

export async function registerVerifyOP(email: string, code: string): Promise<{ success: boolean }> {
  return opPostJson('/auth/register/verify', { email, code })
}

export async function registerCompleteOP(
  email: string,
  code: string,
  password: string
): Promise<{ success: boolean; user?: { id: string; name: string; email: string }; sessionToken?: string }> {
  const url = `${getOpUrl()}/api/portal/auth/register/complete`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, password }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  let sessionToken: string | undefined
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) {
    const m = setCookie.match(/session=([^;]+)/)
    if (m) sessionToken = m[1]
  }
  return { success: true, user: data.user, sessionToken }
}

export async function forgotPasswordOP(email: string): Promise<{ success: boolean; message?: string }> {
  return opPostJson('/auth/forgot-password', { email })
}

/**
 * Check whether a password reset token is still valid (not consumed, not
 * expired, and owned by an approved freelancer). Does not consume it.
 */
export async function verifyResetTokenOP(token: string): Promise<{ valid: boolean }> {
  const url = `${getOpUrl()}/api/portal/auth/verify-reset-token?token=${encodeURIComponent(token)}`
  const response = await fetch(url, { method: 'GET' })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }
  const data = await response.json().catch(() => ({ valid: false }))
  return { valid: !!data.valid }
}

export async function resetPasswordOP(
  token: string,
  password: string
): Promise<{ success: boolean; user?: { id: string; name: string; email: string }; sessionToken?: string }> {
  const url = `${getOpUrl()}/api/portal/auth/reset-password`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, password }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(data.error || `HTTP ${response.status}`) as Error & { status?: number }
    err.status = response.status
    throw err
  }
  let sessionToken: string | undefined
  const setCookie = response.headers.get('set-cookie')
  if (setCookie) {
    const m = setCookie.match(/session=([^;]+)/)
    if (m) sessionToken = m[1]
  }
  return { success: true, user: data.user, sessionToken }
}

// =============================================================================
// FALLBACK TELEMETRY
// =============================================================================

/**
 * Whether silent fallback to Monday is allowed when an OP call errors.
 *
 * Default: true (safety net during migration). Set PORTAL_MONDAY_FALLBACK_ENABLED=false
 * on Netlify once OP is the sole source of truth — callers then return a clean
 * 502 instead of silently serving Monday data.
 */
export function mondayFallbackAllowed(): boolean {
  return process.env.PORTAL_MONDAY_FALLBACK_ENABLED !== 'false'
}

/**
 * Report a Monday-fallback event to the OP so staff get alerted.
 *
 * Called whenever the portal attempts an OP operation, fails, and falls
 * back to Monday.com. Fire-and-forget — we never want telemetry to
 * block the user-facing flow.
 *
 * Requires env vars:
 *   OP_BACKEND_URL
 *   PORTAL_TELEMETRY_SECRET (matching value on OP server)
 *
 * If the secret isn't configured we log locally and give up — no exception
 * is thrown.
 */
export function reportFallback(operation: string, error: unknown, context: { email?: string } = {}): void {
  const secret = process.env.PORTAL_TELEMETRY_SECRET
  const baseUrl = process.env.OP_BACKEND_URL

  const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown error')
  const stack = error instanceof Error ? error.stack : undefined

  // Always log so Netlify function logs capture it
  console.warn(`[PORTAL FALLBACK] operation=${operation} email=${context.email || 'unknown'} error=${errorMessage}`)

  if (!secret || !baseUrl) {
    console.warn('[PORTAL FALLBACK] Skipping OP telemetry — PORTAL_TELEMETRY_SECRET or OP_BACKEND_URL not set')
    return
  }

  // Fire-and-forget
  fetch(`${baseUrl.replace(/\/$/, '')}/api/portal/telemetry/monday-fallback`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Telemetry-Key': secret,
    },
    body: JSON.stringify({
      operation,
      errorMessage,
      email: context.email,
      stack,
    }),
  }).catch((err) => {
    // Last-resort log. Telemetry failing shouldn't cascade into user-facing errors.
    console.error('[PORTAL FALLBACK] Failed to report to OP:', err)
  })
}
