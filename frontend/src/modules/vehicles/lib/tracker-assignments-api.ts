/**
 * Tracker assignments API — manages which GPS tracker is fitted to which vehicle.
 *
 * Trackers are reusable physical devices (Teltonika FMC920) numbered sequentially.
 * Each can be moved between vehicles. This API manages the current assignments.
 *
 * Stored in R2 at: trackers/assignments.json
 * Format: { "RX22SYV": "1", "RO23HLV": "3", ... }
 */

import { apiFetch } from '../config/api-config'

/** Tracker number keyed by vehicle registration */
export type TrackerAssignments = Record<string, string>

/**
 * Fetch current tracker assignments.
 */
export async function getTrackerAssignments(): Promise<TrackerAssignments> {
  const response = await apiFetch('/get-tracker-assignments')
  if (!response.ok) {
    throw new Error(`Failed to fetch tracker assignments: HTTP ${response.status}`)
  }
  const data = await response.json() as { assignments: TrackerAssignments }
  return data.assignments || {}
}

/**
 * Save all tracker assignments (full replace).
 */
export async function saveTrackerAssignments(
  assignments: TrackerAssignments,
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await apiFetch('/save-tracker-assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments }),
    })

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `HTTP ${response.status}` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Save failed' }
  }
}
