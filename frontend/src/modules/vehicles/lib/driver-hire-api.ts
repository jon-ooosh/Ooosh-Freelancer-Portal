/**
 * Driver Hire Forms API — fetches and updates driver/hire data.
 *
 * REPOINTED from Monday.com GraphQL to OP backend API.
 * Data now comes from vehicle_hire_assignments + drivers + job_excess tables.
 *
 * The DriverHireForm interface shape is preserved for backward compatibility
 * with BookOutPage, AllocationsPage, CheckInPage, CollectionPage.
 */

import { apiFetch } from '../config/api-config'

/** Parsed driver hire form entry (same shape as Monday.com version) */
export interface DriverHireForm {
  id: string                          // Assignment UUID (was Monday.com item ID)
  driverName: string                  // Driver full name
  hireHopJob: string | null           // HireHop job number
  hireStart: string | null            // YYYY-MM-DD
  hireEnd: string | null              // YYYY-MM-DD
  clientEmail: string | null          // Client/driver email
  excess: string | null               // Excess amount display string
  startTime: string | null            // HH:mm
  endTime: string | null              // HH:mm
  ve103b: string | null               // VE103b reference
  returnOvernight: string | null      // "Yes" | "No" | null
  // Extra fields from OP backend
  vehicleReg?: string | null
  vehicleModel?: string | null
  driverId?: string | null
  status?: string | null
  pdfKey?: string | null
  pdfGeneratedAt?: string | null
}

/**
 * Transform OP backend row to DriverHireForm shape.
 */
function mapToDriverHireForm(row: any): DriverHireForm {
  // Format excess as display string
  let excess: string | null = null
  if (row.excess_amount_required) {
    const amount = parseFloat(row.excess_amount_required)
    excess = `\u00A3${amount.toLocaleString('en-GB', { minimumFractionDigits: 0 })}`
  }

  // Format time — backend stores as TIME (HH:mm:ss), we need HH:mm
  const formatTime = (t: string | null): string | null => {
    if (!t) return null
    // If already HH:mm, return as-is
    if (/^\d{2}:\d{2}$/.test(t)) return t
    // If HH:mm:ss, strip seconds
    const match = t.match(/^(\d{2}:\d{2})/)
    return match ? match[1] : t
  }

  return {
    id: row.id,
    driverName: row.driver_name || '',
    hireHopJob: row.hirehop_job_id ? String(row.hirehop_job_id) : null,
    hireStart: row.hire_start ? String(row.hire_start).substring(0, 10) : null,
    hireEnd: row.hire_end ? String(row.hire_end).substring(0, 10) : null,
    clientEmail: row.client_email || row.driver_email || null,
    excess,
    startTime: formatTime(row.start_time ? String(row.start_time) : null),
    endTime: formatTime(row.end_time ? String(row.end_time) : null),
    ve103b: row.ve103b_ref || null,
    returnOvernight: row.return_overnight === true ? 'Yes' : row.return_overnight === false ? 'No' : null,
    vehicleReg: row.vehicle_reg || null,
    vehicleModel: row.vehicle_model || null,
    driverId: row.driver_id || null,
    status: row.status || null,
    pdfKey: row.hire_form_pdf_key || null,
    pdfGeneratedAt: row.hire_form_generated_at || null,
  }
}

/**
 * Helper: fetch from OP backend with auth headers + automatic token refresh.
 * Uses apiFetch which handles 401→refresh→retry automatically.
 */

/**
 * Fetch driver hire forms matching a HireHop job number.
 *
 * Returns all hire form entries that have the given job number,
 * which may include multiple drivers for multi-van jobs.
 */
export async function fetchHireFormsByJobNumber(
  hireHopJobNumber: string,
): Promise<DriverHireForm[]> {
  try {
    console.log('[driver-hire-api] Fetching hire forms for job:', hireHopJobNumber)

    const response = await apiFetch(`/api/hire-forms/by-job/${encodeURIComponent(hireHopJobNumber)}`)

    if (!response.ok) {
      if (response.status === 404) {
        console.log('[driver-hire-api] No hire forms found for job', hireHopJobNumber)
        return []
      }
      throw new Error(`API error: ${response.status}`)
    }

    const json = await response.json() as { data: any[] }
    const forms = (json.data || []).map(mapToDriverHireForm)
    console.log('[driver-hire-api] Found', forms.length, 'hire form(s) for job', hireHopJobNumber)
    return forms
  } catch (err) {
    console.error('[driver-hire-api] Failed to fetch hire forms:', err)
    return []
  }
}

/**
 * Fetch all active hire forms (for date range cross-referencing).
 * Used by AllocationsPage to see all upcoming assignments.
 */
export async function fetchActiveHireForms(): Promise<DriverHireForm[]> {
  try {
    console.log('[driver-hire-api] Fetching active hire forms')

    const response = await apiFetch('/api/hire-forms/active')

    if (!response.ok) {
      // If endpoint doesn't exist yet, return empty gracefully
      console.log('[driver-hire-api] Active hire forms endpoint returned', response.status)
      return []
    }

    const json = await response.json() as { data: any[] }
    const forms = (json.data || []).map(mapToDriverHireForm)
    console.log('[driver-hire-api] Found', forms.length, 'active hire form(s)')
    return forms
  } catch (err) {
    console.error('[driver-hire-api] Failed to fetch active hire forms:', err)
    return []
  }
}

// ── Write-back after book-out ──

/**
 * Write book-out data back to a hire assignment in the OP backend.
 *
 * Called after a successful book-out to record which vehicle was assigned
 * and the mileage reading. Replaces the Monday.com write-back.
 */
export async function updateDriverHireForm(params: {
  hireFormItemId: string
  vehicleReg?: string
  mileageOut?: number
  startTime?: string            // "HH:mm" format
  endTime?: string              // "HH:mm" format
  ve103b?: string
  returnOvernight?: string      // "Yes" | "No" | "Don't know"
}): Promise<{ success: boolean; error?: string }> {
  const body: Record<string, unknown> = {}

  if (params.startTime) body.start_time = params.startTime
  if (params.endTime) body.end_time = params.endTime
  if (params.ve103b) body.ve103b_ref = params.ve103b
  if (params.returnOvernight !== undefined) {
    body.return_overnight = params.returnOvernight === 'Yes' ? true
      : params.returnOvernight === 'No' ? false : null
  }

  // Status update to booked_out
  body.status = 'booked_out'

  if (Object.keys(body).length === 0) {
    return { success: true }
  }

  try {
    console.log('[driver-hire-api] Updating hire form', params.hireFormItemId, ':', JSON.stringify(body))

    const response = await apiFetch(`/api/hire-forms/${encodeURIComponent(params.hireFormItemId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new Error(`PATCH failed: ${response.status}`)
    }

    console.log('[driver-hire-api] Update successful for', params.hireFormItemId)
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Update failed'
    console.error('[driver-hire-api] Update failed for', params.hireFormItemId, ':', errMsg)
    return { success: false, error: errMsg }
  }
}
