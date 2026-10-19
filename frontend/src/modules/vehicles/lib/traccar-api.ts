/**
 * Traccar API client — all requests proxied through /.netlify/functions/traccar
 */

import type { TraccarDevice, TraccarPosition, TraccarGeofence, TraccarTrip } from '../types/traccar'
import { isRealFix } from '../types/traccar'
import { apiFetch } from '../config/api-config'
import { getTrackers, type GpsTracker } from './gps-trackers-api'

async function traccarFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const res = await apiFetch('/traccar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint, params }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }))
    throw new Error((err as { error?: string }).error || `Traccar API error: ${res.status}`)
  }

  return res.json() as Promise<T>
}

/** Get all tracked devices */
export async function getDevices(): Promise<TraccarDevice[]> {
  return traccarFetch<TraccarDevice[]>('/devices')
}

/**
 * Get latest positions for all devices (or a specific device).
 * A position with no satellite fix (0,0 — mid-Atlantic) is dropped, so a
 * device whose latest report had no fix simply has no position.
 */
export async function getPositions(deviceId?: number): Promise<TraccarPosition[]> {
  const params: Record<string, string> = {}
  if (deviceId != null) {
    params.deviceId = String(deviceId)
  }
  const rows = await traccarFetch<TraccarPosition[]>('/positions', params)
  return rows.filter(isRealFix)
}

/** Get all geofences */
export async function getGeofences(): Promise<TraccarGeofence[]> {
  return traccarFetch<TraccarGeofence[]>('/geofences')
}

/** Get trip history for a device over a date range */
export async function getTrips(deviceId: number, from: string, to: string): Promise<TraccarTrip[]> {
  return traccarFetch<TraccarTrip[]>('/reports/trips', {
    deviceId: String(deviceId),
    from,
    to,
  })
}

/** Get route positions for a device over a date range */
export async function getRoute(deviceId: number, from: string, to: string): Promise<TraccarPosition[]> {
  const rows = await traccarFetch<TraccarPosition[]>('/reports/route', {
    deviceId: String(deviceId),
    from,
    to,
  })
  return rows.filter(isRealFix)
}

const normaliseReg = (s: string) => s.replace(/\s+/g, '').toUpperCase()

/**
 * Find a vehicle's Traccar device: through the tracker fitted to it on the
 * register (Traccar's uniqueId is the IMEI), else a device named after the
 * reg (vans not on the register yet).
 * Returns null if no tracker is fitted to this vehicle.
 */
export async function findDeviceByReg(
  reg: string,
  devices?: TraccarDevice[],
  trackers?: GpsTracker[],
): Promise<TraccarDevice | null> {
  const allDevices = devices || await getDevices()
  const register = trackers || await getTrackers().catch(() => [] as GpsTracker[])
  const target = normaliseReg(reg)
  const tracker = register.find(t => t.vehicleReg && normaliseReg(t.vehicleReg) === target)
  if (tracker) {
    const byImei = allDevices.find(d => d.uniqueId === tracker.imei)
    if (byImei) return byImei
  }
  return allDevices.find(d => normaliseReg(d.name) === target) || null
}

/** The register's tracker for a Traccar device (by IMEI), if any. */
export function trackerForDevice(device: TraccarDevice, trackers: GpsTracker[] | undefined): GpsTracker | undefined {
  return trackers?.find(t => t.imei === device.uniqueId)
}
