/**
 * Client-side wrapper for the get-prep-history Netlify function.
 * Fetches previous prep session data from R2 for pre-filling values.
 */

import { apiFetch } from '../config/api-config'

export interface PrepHistoryItem {
  name: string
  value: string
  detail?: string
  unit?: string
}

export interface PrepHistorySection {
  name: string
  items: PrepHistoryItem[]
  notes: string
}

export interface PrepHistorySession {
  vehicleReg: string
  preparedBy: string
  mileage: number | null
  fuelLevel: string | null
  date: string
  startedAt?: string
  completedAt?: string
  durationMinutes?: number
  overallStatus: string
  sections: PrepHistorySection[]
}

/**
 * Fetch the most recent prep session for a vehicle.
 * Returns null if no previous sessions or on error.
 */
export async function fetchLastPrepSession(
  vehicleReg: string,
): Promise<PrepHistorySession | null> {
  try {
    const resp = await apiFetch(
      `/get-prep-history?vehicleReg=${encodeURIComponent(vehicleReg)}&limit=1`,
    )
    if (!resp.ok) return null

    const data = await resp.json() as { sessions: PrepHistorySession[]; total: number }
    return data.sessions[0] ?? null
  } catch (err) {
    console.warn('[prep-history] Failed to fetch last session:', err)
    return null
  }
}

/**
 * Extract tyre values (PSI/mm fields) from a prep session.
 * Returns a map of item name → value string.
 */
export function extractTyreValues(session: PrepHistorySession): Record<string, string> {
  const values: Record<string, string> = {}
  for (const sec of session.sections) {
    for (const item of sec.items) {
      if (item.unit === 'PSI' || item.unit === 'mm') {
        values[item.name] = item.value
      }
    }
  }
  return values
}
