/**
 * Events API — creates vehicle events in Cloudflare R2.
 *
 * Previously wrote to Monday.com Events board. Now R2-only.
 * Events are stored at: vehicle-events/{vehicleReg}/{eventId}.json
 * Per-vehicle index at: vehicle-events/{vehicleReg}/_index.json
 */

import type { EventType, FuelLevel } from '../types/vehicle-event'
import { apiFetch } from '../config/api-config'

/**
 * Create a vehicle event in R2.
 * Returns the event ID.
 *
 * Non-blocking: If R2 save fails, returns a local ID so the flow can continue.
 */
export async function createVehicleEvent(params: {
  vehicleReg: string
  eventType: EventType
  eventDate?: string
  mileage?: number | null
  fuelLevel?: FuelLevel | null
  details?: string | null
  hireHopJob?: string | null
  clientEmail?: string | null
  photoFolderUrl?: string | null
  hireStatus?: 'Available' | 'On Hire' | 'Collected' | 'Prep Needed' | 'Not Ready' | null
}): Promise<{ id: string; error?: string }> {
  const dateStr = params.eventDate || new Date().toISOString().split('T')[0]!
  const eventId = `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  const event = {
    id: eventId,
    vehicleReg: params.vehicleReg,
    eventType: params.eventType,
    eventDate: dateStr,
    mileage: params.mileage ?? null,
    fuelLevel: params.fuelLevel ?? null,
    details: params.details ?? null,
    hireHopJob: params.hireHopJob ?? null,
    clientEmail: params.clientEmail ?? null,
    photoFolderUrl: params.photoFolderUrl ?? null,
    hireStatus: params.hireStatus ?? null,
    createdAt: new Date().toISOString(),
  }

  try {
    console.log('[events-api] Creating event:', eventId, params.eventType, params.vehicleReg)

    const response = await apiFetch('/save-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event }),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(errorData.error || `HTTP ${response.status}`)
    }

    console.log('[events-api] Event saved to R2:', eventId)
    return { id: eventId }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Event save failed'
    console.error('[events-api] R2 event save failed:', errMsg)
    return { id: eventId, error: errMsg }
  }
}
