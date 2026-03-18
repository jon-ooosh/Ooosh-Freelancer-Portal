/**
 * Allocations API — client-side wrappers for van allocation persistence in R2.
 *
 * Allocations are stored as a single file at allocations/_index.json in R2.
 * Pattern follows issues-r2-api.ts (thin fetch wrappers).
 */

import type { VanAllocation } from '../types/hirehop'
import { apiFetch } from '../config/api-config'

/** Fetch all active allocations from R2 */
export async function getAllocations(): Promise<VanAllocation[]> {
  try {
    const resp = await apiFetch('/get-allocations')
    if (!resp.ok) return []
    const data = await resp.json() as { allocations?: VanAllocation[] }
    return data.allocations || []
  } catch (err) {
    console.warn('[allocations-api] Failed to fetch allocations:', err)
    return []
  }
}

/** Save the full allocations array to R2 (replaces existing) */
export async function saveAllocations(
  allocations: VanAllocation[],
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/save-allocations', {
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
