/**
 * GPS tracker register API — which numbered tracker is in which van.
 *
 * Backend: /api/vehicles/trackers (services/gps-trackers.ts is THE definition).
 * Traccar knows a unit by its IMEI, so a van's Traccar device is found through
 * the tracker fitted to it — see findDeviceForVehicle() in traccar-api.ts.
 */

import { apiFetch } from '../config/api-config'

export type TrackerStatus = 'active' | 'faulty' | 'retired'

export interface GpsTracker {
  id: string
  trackerNumber: string     // the label on the unit: '001'
  imei: string              // = Traccar device uniqueId
  iccid: string | null      // SIM number
  status: TrackerStatus
  notes: string | null
  vehicleId: string | null  // the van it is in now; null = spare
  vehicleReg: string | null
  vehicleActive: boolean | null  // false = that van has left the fleet
  fittedOn: string | null   // YYYY-MM-DD
}

export interface TrackerFitting {
  vehicleId: string | null
  vehicleReg: string
  fittedOn: string
  removedOn: string | null
  fittedBy: string | null
  removedBy: string | null
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init)
  const body = await res.json().catch(() => ({})) as { data?: T; error?: string }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body.data as T
}

function send<T>(path: string, method: string, payload: unknown): Promise<T> {
  return call<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function getTrackers(): Promise<GpsTracker[]> {
  return call<GpsTracker[]>('/trackers')
}

export function getTrackerHistory(id: string): Promise<TrackerFitting[]> {
  return call<TrackerFitting[]>(`/trackers/${id}/history`)
}

export function createTracker(input: {
  trackerNumber: string
  imei: string
  iccid?: string
  notes?: string
}): Promise<GpsTracker> {
  return send<GpsTracker>('/trackers', 'POST', input)
}

export function updateTracker(
  id: string,
  patch: Partial<Pick<GpsTracker, 'trackerNumber' | 'imei' | 'iccid' | 'status' | 'notes'>>,
): Promise<GpsTracker> {
  return send<GpsTracker>(`/trackers/${id}`, 'PATCH', patch)
}

export function fitTracker(id: string, vehicleId: string, fittedOn?: string): Promise<GpsTracker> {
  return send<GpsTracker>(`/trackers/${id}/fit`, 'POST', { vehicleId, fittedOn })
}

export function removeTracker(id: string, removedOn?: string): Promise<GpsTracker> {
  return send<GpsTracker>(`/trackers/${id}/remove`, 'POST', { removedOn })
}
