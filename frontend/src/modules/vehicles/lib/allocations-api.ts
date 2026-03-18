/**
 * Allocations API — client-side wrappers for van allocation persistence.
 *
 * Reads/writes via the OP assignments compat layer (/api/assignments/compat/allocations)
 * which stores allocations in the vehicle_hire_assignments database table.
 */

import type { VanAllocation } from '../types/hirehop'
import { getAuthHeaders } from '../config/api-config'

const COMPAT_URL = '/api/assignments/compat/allocations'

/** Fetch all active allocations from the assignments database */
export async function getAllocations(): Promise<VanAllocation[]> {
  try {
    const resp = await fetch(COMPAT_URL, {
      headers: getAuthHeaders(),
    })
    if (!resp.ok) return []
    const data = await resp.json() as { allocations?: VanAllocation[] }
    return data.allocations || []
  } catch (err) {
    console.warn('[allocations-api] Failed to fetch allocations:', err)
    return []
  }
}

/** Save the full allocations array (syncs to vehicle_hire_assignments table) */
export async function saveAllocations(
  allocations: VanAllocation[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await fetch(COMPAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getAuthHeaders(),
      },
      body: JSON.stringify({ allocations }),
    })

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `HTTP ${resp.status}` }
    }

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Network error',
    }
  }
}
