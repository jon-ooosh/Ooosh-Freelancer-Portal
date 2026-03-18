/**
 * Traccar API client — all requests proxied through /.netlify/functions/traccar
 */

import type { TraccarDevice, TraccarPosition, TraccarGeofence, TraccarTrip } from '../types/traccar'
import { apiFetch } from '../config/api-config'

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

/** Get latest positions for all devices (or a specific device) */
export async function getPositions(deviceId?: number): Promise<TraccarPosition[]> {
  const params: Record<string, string> = {}
  if (deviceId != null) {
    params.deviceId = String(deviceId)
  }
  return traccarFetch<TraccarPosition[]>('/positions', params)
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
  return traccarFetch<TraccarPosition[]>('/reports/route', {
    deviceId: String(deviceId),
    from,
    to,
  })
}

/**
 * Find a Traccar device by vehicle registration.
 * Traccar device names are set to reg numbers.
 * Returns null if no tracker is fitted to this vehicle.
 */
export async function findDeviceByReg(
  reg: string,
  devices?: TraccarDevice[],
): Promise<TraccarDevice | null> {
  const allDevices = devices || await getDevices()
  const normalise = (s: string) => s.replace(/\s+/g, '').toUpperCase()
  const target = normalise(reg)
  return allDevices.find(d => normalise(d.name) === target) || null
}
