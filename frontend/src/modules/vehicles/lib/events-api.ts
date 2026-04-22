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
  // Driver name stored as a first-class field so regenerate-pdf doesn't
  // have to parse it out of `details`.
  driverName?: string | null
  // Raw notes (not the joined `details` blob) — regenerate-pdf can render
  // them cleanly when re-building a PDF later.
  notes?: string | null
  // Per-item briefing checklist ticks captured at book-out. Array of
  // the item names that were ticked. Used when regenerating a mis-fired
  // book-out PDF after the fact.
  briefingItems?: string[] | null
  // Driver signature as base64 data URI. Persisted on the server as a
  // separate R2 object (stripped from the event JSON before storage).
  signatureBase64?: string | null
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
    driverName: params.driverName ?? null,
    notes: params.notes ?? null,
    briefingItems: params.briefingItems ?? null,
    signatureBase64: params.signatureBase64 ?? null,
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

/**
 * Rebuild a condition report PDF for an existing event and optionally
 * email it. Used to patch up mis-fires (e.g. original PDF crashed) or
 * resend to a different address later for damage disputes.
 */
export async function regenerateEventPdf(params: {
  eventId: string
  vehicleReg: string
  email?: string
  skipEmail?: boolean
}): Promise<{
  success: boolean
  pdf?: string
  filename?: string
  size?: number
  photoCount?: number
  signatureFound?: boolean
  emailSent?: boolean
  emailedTo?: string | null
  error?: string
}> {
  try {
    const response = await apiFetch(
      `/events/${encodeURIComponent(params.eventId)}/regenerate-pdf`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vehicleReg: params.vehicleReg,
          email: params.email,
          skipEmail: params.skipEmail,
        }),
      },
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as { error?: string }
      return { success: false, error: errorData.error || `HTTP ${response.status}` }
    }

    const data = await response.json() as {
      pdf: string
      filename: string
      size: number
      photoCount: number
      signatureFound: boolean
      emailSent: boolean
      emailedTo: string | null
    }
    return { success: true, ...data }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Regenerate failed' }
  }
}
