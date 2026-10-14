/**
 * Client wrapper for the Vehicle > History > MOT sub-tab.
 *
 * Mirrors backend/src/services/dvsa-mot.ts (THE definition) — the backend
 * parses DVSA's response; this only fetches and triggers a refresh.
 */

import { apiFetch } from '../config/api-config'

export interface MotDefect {
  type: string | null
  text: string | null
  dangerous: boolean
}

export interface MotTest {
  completedDate: string | null
  result: string
  expiryDate: string | null
  odometer: number | null
  odometerUnit: 'MI' | 'KM' | null
  odometerResultType: string | null
  testNumber: string | null
  location: string | null
  defects: MotDefect[]
}

export interface MotSummary {
  make: string | null
  model: string | null
  hasOutstandingRecall: string | null
  tests: MotTest[]
  dvsaMotDue: string | null
}

export interface VehicleMotView {
  configured: boolean
  fetchedAt: string | null
  lastAttemptAt: string | null
  lastError: string | null
  summary: MotSummary | null
  motDue: string | null
  motDueSource: 'dvsa' | 'manual' | null
  comparison: 'update' | 'earlier' | 'same' | 'none'
}

export async function fetchMotHistory(vehicleId: string): Promise<VehicleMotView> {
  const resp = await apiFetch(`/fleet/${vehicleId}/mot-history`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const body = await resp.json() as { data: VehicleMotView }
  return body.data
}

export async function refreshMotHistory(vehicleId: string): Promise<VehicleMotView> {
  const resp = await apiFetch(`/fleet/${vehicleId}/mot-history/refresh`, { method: 'POST' })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const body = await resp.json() as { data: VehicleMotView }
  return body.data
}

/** "Use DVSA date" — settle a flagged manual MOT Due in DVSA's favour. */
export async function applyDvsaMotDate(vehicleId: string): Promise<VehicleMotView> {
  const resp = await apiFetch(`/fleet/${vehicleId}/mot-history/use-dvsa`, { method: 'POST' })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const body = await resp.json() as { data: VehicleMotView }
  return body.data
}

/** Admin: every active van from DVSA, in the background. */
export async function refreshAllMots(): Promise<{ started: boolean; vehicles: number }> {
  const resp = await apiFetch('/mot-history/refresh-all', { method: 'POST' })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const body = await resp.json() as { data: { started: boolean; vehicles: number } }
  return body.data
}

