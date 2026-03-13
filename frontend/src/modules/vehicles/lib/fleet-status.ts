/**
 * Fleet Status API — updates hire status via the OP backend.
 *
 * Previously: Updated Monday.com board column via GraphQL.
 * Now: PATCH /api/vehicles/fleet/by-reg/:reg/hire-status
 *
 * Called from book-out (set "On Hire") and check-in (set "Prep Needed").
 */

import { apiFetch } from '../config/api-config'

type HireStatus = 'Available' | 'On Hire' | 'Collected' | 'Prep Needed' | 'Not Ready'

/**
 * Update the hire status for a vehicle by its registration plate.
 *
 * @param vehicleReg - The vehicle registration (used as identifier)
 * @param status - The new hire status label
 */
export async function updateFleetHireStatus(
  vehicleReg: string,
  status: HireStatus,
): Promise<{ success: boolean; error?: string }> {
  try {
    console.log('[fleet-status] Updating hire status for', vehicleReg, 'to', status)

    const response = await apiFetch(`/fleet/by-reg/${encodeURIComponent(vehicleReg)}/hire-status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })

    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: string }
      const errMsg = err.error || `Status update failed: ${response.status}`
      console.error('[fleet-status] Update failed:', errMsg)
      return { success: false, error: errMsg }
    }

    console.log('[fleet-status] Status updated successfully')
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Status update failed'
    console.error('[fleet-status] Update failed:', errMsg)
    return { success: false, error: errMsg }
  }
}
