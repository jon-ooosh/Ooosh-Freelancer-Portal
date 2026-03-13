/**
 * Client-side fetch wrappers for the R2-backed issues API.
 * Follows the same pattern as prep-history.ts.
 */

import type { VehicleIssue, IssueIndexEntry } from '../types/issue'
import { apiFetch } from '../config/api-config'

/**
 * Save (create or update) an issue to R2.
 * Writes the full issue JSON and upserts the fleet-wide index.
 */
export async function saveIssue(issue: VehicleIssue): Promise<{ success: boolean; error?: string }> {
  try {
    const resp = await apiFetch('/save-issue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issue }),
    })

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({})) as { error?: string }
      return { success: false, error: data.error || `HTTP ${resp.status}` }
    }

    return { success: true }
  } catch (err) {
    console.warn('[issues-r2-api] Failed to save issue:', err)
    return { success: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

/**
 * Fetch all issues for a specific vehicle.
 * Returns full VehicleIssue objects sorted by reportedAt descending.
 */
export async function getVehicleIssues(vehicleReg: string): Promise<VehicleIssue[]> {
  try {
    const resp = await apiFetch(`/get-vehicle-issues?vehicleReg=${encodeURIComponent(vehicleReg)}`)
    if (!resp.ok) return []

    const data = await resp.json() as { issues: VehicleIssue[] }
    return data.issues || []
  } catch (err) {
    console.warn('[issues-r2-api] Failed to fetch vehicle issues:', err)
    return []
  }
}

/**
 * Fetch the fleet-wide issue index.
 * Returns lightweight IssueIndexEntry objects.
 */
export async function getAllIssues(): Promise<IssueIndexEntry[]> {
  try {
    const resp = await apiFetch('/get-all-issues')
    if (!resp.ok) return []

    const data = await resp.json() as { issues: IssueIndexEntry[] }
    return data.issues || []
  } catch (err) {
    console.warn('[issues-r2-api] Failed to fetch all issues:', err)
    return []
  }
}

/**
 * Fetch a single issue by vehicleReg + issueId.
 * Returns the full VehicleIssue or null if not found.
 */
export async function getIssue(vehicleReg: string, issueId: string): Promise<VehicleIssue | null> {
  try {
    const resp = await apiFetch(`/get-issue?vehicleReg=${encodeURIComponent(vehicleReg)}&issueId=${encodeURIComponent(issueId)}`)
    if (!resp.ok) return null

    const data = await resp.json() as { issue: VehicleIssue }
    return data.issue || null
  } catch (err) {
    console.warn('[issues-r2-api] Failed to fetch issue:', err)
    return null
  }
}
