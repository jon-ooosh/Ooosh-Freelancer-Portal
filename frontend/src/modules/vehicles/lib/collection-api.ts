/**
 * Collection API — client-side wrappers for freelancer collection data in R2.
 *
 * Collection data records vehicle state at the point a freelancer picks up
 * the vehicle from the client. This data pre-populates the staff check-in.
 */

import type { CollectionData } from '../types/vehicle-event'
import { apiFetch } from '../config/api-config'

/** Save collection data to R2 */
export async function saveCollection(
  collection: CollectionData,
): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/save-collection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection }),
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

/** Fetch collection data for a vehicle + job from R2 */
export async function getCollection(
  vehicleReg: string,
  jobId: string,
): Promise<CollectionData | null> {
  try {
    const resp = await apiFetch(
      `/get-collection?vehicleReg=${encodeURIComponent(vehicleReg)}&jobId=${encodeURIComponent(jobId)}`,
    )
    if (!resp.ok) return null

    const data = await resp.json() as { collection: CollectionData | null }
    return data.collection
  } catch (err) {
    console.warn('[collection-api] Failed to fetch collection:', err)
    return null
  }
}
