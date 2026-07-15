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
// STUDIO SITTER SHIFTS (Rehearsals — Phase D portal surface)
// =============================================================================

export interface SitterSharedFile {
  name: string
  url: string
  fileType: string | null
}

export interface SitterShiftJob {
  job_id: string
  hh_job_number: number | null
  label: string          // band / client / job name
  rooms: string[]        // sitter-needed room labels, e.g. ["Room 1 · Lockout"]
  files?: SitterSharedFile[]
}

export interface SitterShift {
  date: string           // YYYY-MM-DD
  planned_start: string | null
  planned_end: string | null
  status: string         // shift status ('closed' once locked up)
  assignment_status: string // assigned / confirmed
  fee: number | null
  report_submitted_at?: string | null // lock-up submitted → "Completed"
  jobs: SitterShiftJob[] // who's in that night
}

export interface SitterShiftsResponse {
  success: boolean
  shifts: SitterShift[]
}

export interface SitterShiftDetail {
  date: string
  planned_start: string | null
  planned_end: string | null
  status: string
  fee: number | null
  assignment_status: string | null
  jobs: SitterShiftJob[]
}

export interface SitterShiftDetailResponse extends SitterShiftDetail {
  success: boolean
}

/** The sitter's own upcoming/recent rostered evenings. */
export async function getSitterShiftsFromOP(sessionToken: string): Promise<SitterShiftsResponse> {
  return opFetch<SitterShiftsResponse>('/studio-sitter/shifts', sessionToken)
}

/** One evening's detail — who's in each room + that job's shared specs/files. */
export async function getSitterShiftDetailFromOP(
  sessionToken: string,
  date: string
): Promise<SitterShiftDetailResponse> {
  return opFetch<SitterShiftDetailResponse>(`/studio-sitter/shifts/${date}`, sessionToken)
}

export interface SitterThreadMessage {
  id: string
  content: string
  created_at: string
  author: string
  from_staff: boolean
  mine: boolean
  files: SitterSharedFile[]
}

export interface SitterThreadResponse {
  success: boolean
  messages: SitterThreadMessage[]
}

/** Read the handover thread for one evening. */
export async function getSitterThreadFromOP(
  sessionToken: string,
  date: string
): Promise<SitterThreadResponse> {
  return opFetch<SitterThreadResponse>(`/studio-sitter/shifts/${date}/thread`, sessionToken)
}

/** Post a handover note to one evening's thread (text only). */
export async function postSitterThreadOP(
  sessionToken: string,
  date: string,
  content: string
): Promise<{ success: boolean; message: SitterThreadMessage }> {
  return opFetch(`/studio-sitter/shifts/${date}/thread`, sessionToken, {
    method: 'POST',
    body: JSON.stringify({ content }),
  })
}

/** Post a handover note with attachments (multipart: content + files[]). */
export async function postSitterThreadWithFilesOP(
  sessionToken: string,
  date: string,
  formData: FormData
): Promise<{ success: boolean; message: SitterThreadMessage }> {
  const url = `${getOpUrl()}/api/portal/studio-sitter/shifts/${date}/thread`
  // 60s — attachments can be slow on site.
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Cookie': `session=${sessionToken}` },
    body: formData, // multipart/form-data (content + files)
  }, 60_000)
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new OpApiError((body as { error?: string })?.error || `HTTP ${response.status}`, response.status, body)
  }
  return response.json()
}

// =============================================================================
// STUDIO SITTER LOCK-UP REPORT (Rehearsals — Phase E)
// =============================================================================

export interface LockupReference {
  text?: string
  photos: string[]  // R2 keys OR external URLs
}
export interface LockupItem {
  id: string
  label: string
  type: 'yesno' | 'text' | 'number'
  section?: string
  expected?: string
  end_of_booking_only?: boolean
  reference?: LockupReference
}

export interface LockupTemplate {
  version: number
  intro?: string
  items: LockupItem[]
  notes_label?: string
  lost_property_prompt?: string
}

export interface LockupStoredReport {
  answers: Record<string, unknown>
  exception_notes: Record<string, { text: string; photos: unknown[] }>
  notes: { text: string; photos: unknown[] }
  continuing_tomorrow: boolean
  continuing_overridden: boolean
  submitted_at: string
}

export interface LockupContextResponse {
  success: boolean
  date: string
  template: LockupTemplate
  continuing_tomorrow: boolean
  continuing_derived: boolean
  submitted: LockupStoredReport | null
  has_shift: boolean
  error?: string
}

export interface LockupException {
  id: string
  label: string
  answer: string
  expected: string
}

export interface LockupSubmitResponse {
  success: boolean
  ok: boolean
  shift_id: string
  exceptions: LockupException[]
  error?: string
}

/** Lock-up sub-page context: template + derived continuing + prior submission. */
export async function getLockupContextFromOP(
  sessionToken: string,
  date: string
): Promise<LockupContextResponse> {
  return opFetch<LockupContextResponse>(`/studio-sitter/shifts/${date}/lockup`, sessionToken)
}

/** Submit the lock-up report (multipart: `payload` JSON + optional photos). */
export async function submitLockupReportOP(
  sessionToken: string,
  date: string,
  formData: FormData
): Promise<LockupSubmitResponse> {
  const url = `${getOpUrl()}/api/portal/studio-sitter/shifts/${date}/lockup`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Cookie: `session=${sessionToken}` },
    body: formData,
  }, 60_000)
  if (!response.ok) {
    const b = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new OpApiError((b as { error?: string })?.error || `HTTP ${response.status}`, response.status, b)
  }
  return response.json()
}

/** Log lost property found during a shift (multipart: description/found_location + photos). */
export async function logShiftLostPropertyOP(
  sessionToken: string,
  date: string,
  formData: FormData
): Promise<{ success: boolean; id: string; error?: string }> {
  const url = `${getOpUrl()}/api/portal/studio-sitter/shifts/${date}/lost-property`
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Cookie: `session=${sessionToken}` },
    body: formData,
  }, 60_000)
  if (!response.ok) {
    const b = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new OpApiError((b as { error?: string })?.error || `HTTP ${response.status}`, response.status, b)
  }
  return response.json()
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Typed error thrown by opFetch on non-2xx responses. Carries the HTTP
 * status so callers can distinguish "the user asked for something that
 * doesn't exist / they aren't allowed" (4xx — propagate to the user,
 * NOT alert-worthy) from "the OP backend is broken" (5xx / network —
 * fire a Monday-fallback alert email, and optionally fall back).
 *
 * Routes catching from opFetch should use `isOpClientError(err)` to
 * branch — see helper below.
 */
export class OpApiError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = 'OpApiError'
    this.status = status
    this.body = body
  }
}

/**
 * True when the error came back as an HTTP 4xx from OP. These are
 * legitimate "your request was wrong" responses (auth failures, 404 not
 * found, validation errors, etc.) and should NOT trigger a Monday
 * fallback alert email — they're not OP outages, they're correct
 * negative responses.
 */
export function isOpClientError(err: unknown): err is OpApiError {
  return err instanceof OpApiError && err.status >= 400 && err.status < 500
}

/**
 * fetch with a hard timeout via AbortController. Portal POSTs (login,
 * completion, legs, register/reset) previously had NO timeout — a genuinely
 * slow / hung OP backend left the freelancer staring at an indefinite spinner
 * mid-handover. On timeout we throw a friendly, retryable message instead.
 * Default 20s for JSON POSTs; callers pass a longer window for uploads.
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('The server is taking too long to respond. Please check your signal and try again.')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Make an authenticated request to the OP backend portal API.
 * Forwards the session cookie from the incoming request.
 *
 * GETs are retried once on 5xx / network failure (300ms backoff) to swallow
 * brief OP backend restart windows. POSTs are NOT retried — a 5xx mid-POST
 * is ambiguous (request may have landed and died after the write), and a
 * blind retry could create duplicate records.
 */
async function opFetch<T>(
  path: string,
  sessionToken: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${getOpUrl()}/api/portal${path}`
  const fetchOptions: RequestInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `session=${sessionToken}`,
      ...(options.headers as Record<string, string> || {}),
    },
  }

  const isGet = !options.method || options.method.toUpperCase() === 'GET'
  const maxAttempts = isGet ? 2 : 1

  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetchWithTimeout(url, fetchOptions)

      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
        const err = new OpApiError(
          (body as { error?: string })?.error || `OP API error: ${response.status}`,
          response.status,
          body,
        )
        // Retry once on 5xx for GETs; surface 4xx immediately
        if (isGet && response.status >= 500 && attempt < maxAttempts) {
          lastError = err
          await new Promise((r) => setTimeout(r, 300))
          continue
        }
        throw err
      }

      return response.json()
    } catch (err) {
      // Network failures (DNS, ECONNREFUSED, abort) — treat like 5xx for GETs
      if (err instanceof OpApiError) throw err
      if (isGet && attempt < maxAttempts) {
        lastError = err
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      throw err
    }
  }

  // Unreachable in practice — the loop either returns or throws — but keeps TS happy
  throw lastError instanceof Error ? lastError : new Error('opFetch exhausted retries')
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

  // 60s window — completion carries photo + signature uploads which can be
  // legitimately slow on site, so a longer ceiling than the JSON default.
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Cookie': `session=${sessionToken}`,
    },
    body: formData, // multipart/form-data (photos + signature)
  }, 60_000)

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
    throw new Error(body.error || `Completion failed: ${response.status}`)
  }

  return response.json()
}

/**
 * Declare which legs a D&C job involves (van and/or equipment), from the
 * /start wizard selection. Lets OP close the quote server-side when the last
 * required leg lands, instead of depending on the browser returning to
 * /complete across the OP↔portal domain boundary.
 */
export async function declareLegsOP(
  sessionToken: string,
  quoteId: string,
  legs: { van: boolean; equipment: boolean }
): Promise<{ success: boolean }> {
  return opFetch<{ success: boolean }>(`/jobs/${quoteId}/legs`, sessionToken, {
    method: 'POST',
    body: JSON.stringify(legs),
  })
}

/**
 * Login to OP portal (create session).
 */
export async function loginToOP(
  email: string,
  password: string
): Promise<{ success: boolean; user?: { id: string; name: string; email: string }; sessionToken?: string; error?: string; status?: number }> {
  const url = `${getOpUrl()}/api/portal/auth/login`

  const response = await fetchWithTimeout(url, {
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
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new OpApiError(
      (data as { error?: string })?.error || `HTTP ${response.status}`,
      response.status,
      data,
    )
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
    throw new OpApiError(
      (data as { error?: string })?.error || `HTTP ${response.status}`,
      response.status,
      data,
    )
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
    throw new OpApiError(
      (data as { error?: string })?.error || `HTTP ${response.status}`,
      response.status,
      data,
    )
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
