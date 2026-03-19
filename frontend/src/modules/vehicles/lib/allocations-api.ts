/**
 * Allocations API — client-side wrappers for van allocation persistence.
 *
 * Reads/writes via the OP assignments compat layer (/api/assignments/compat/allocations)
 * which stores allocations in the vehicle_hire_assignments database table.
 *
 * Uses apiFetch for automatic 401 retry with token refresh.
 */

import type { VanAllocation } from '../types/hirehop'
import { apiFetch } from '../config/api-config'

const COMPAT_PATH = '/api/assignments/compat/allocations'

/** Fetch all active allocations from the assignments database */
export async function getAllocations(): Promise<VanAllocation[]> {
  try {
    // Use absolute URL but via apiFetch so we get auto-refresh on 401
    const resp = await apiFetch(COMPAT_PATH)
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
    const resp = await apiFetch(COMPAT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
