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
  /** The latest test's key and what staff have marked on it (VEHICLE-SALES-SPEC §18). */
  latestTestKey: string | null
  advisoryMarks: AdvisoryMark[]
}

export type AdvisoryState = 'done' | 'noted'

export interface AdvisoryMark {
  defectKey: string
  state: AdvisoryState
  note: string | null
  markedBy: string | null
  markedAt: string
}

/**
 * One key per defect, null for non-advisories — the SAME rule as the backend's
 * advisoryKeys() (services/dvsa-mot.ts), which refuses any key it didn't build.
 */
export function advisoryKeys(t: MotTest): Array<string | null> {
  const seen = new Map<string, number>()
  return t.defects.map((d) => {
    if (d.type !== 'ADVISORY' && d.type !== 'MINOR') return null
    const base = `${d.type}|${(d.text ?? '').trim()}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base}#${n}`
  })
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


/** Mark one advisory on the latest test done / noted, or clear it (state null). */
export async function markAdvisory(
  vehicleId: string,
  body: { testKey: string; defectKey: string; state: AdvisoryState | null; note?: string | null },
): Promise<VehicleMotView> {
  const resp = await apiFetch(`/fleet/${vehicleId}/mot-history/advisories`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!resp.ok) {
    const b = await resp.json().catch(() => ({}))
    throw new Error((b as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const b = await resp.json() as { data: VehicleMotView }
  return b.data
}
