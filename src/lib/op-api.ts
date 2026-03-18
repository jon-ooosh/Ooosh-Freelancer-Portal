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
): Promise<{ success: boolean; user?: { id: string; name: string; email: string }; sessionToken?: string; error?: string }> {
  const url = `${getOpUrl()}/api/portal/auth/login`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })

  const data = await response.json()

  if (!response.ok) {
    return { success: false, error: data.error || 'Login failed' }
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
