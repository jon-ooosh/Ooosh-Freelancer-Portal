/**
 * Events Query API — fetches vehicle events from Cloudflare R2.
 *
 * Previously read from Monday.com Events board. Now R2-only.
 * Reads from: vehicle-events/{vehicleReg}/_index.json
 *
 * Used by:
 * - Check-in to retrieve the most recent book-out event for comparison
 * - Prep to pre-fill mileage and fuel level
 * - Check-in to prevent double check-ins
 */

import { apiFetch } from '../config/api-config'

export interface BookOutEventData {
  id: string
  eventDate: string
  mileage: number | null
  fuelLevel: string | null
  hireHopJob: string | null
  clientEmail: string | null
  driverName: string | null
  notes: string | null
}

interface EventIndexEntry {
  id: string
  vehicleReg: string
  eventType: string
  eventDate: string
  mileage: number | null
  fuelLevel: string | null
  hireHopJob: string | null
  hireStatus: string | null
  createdAt: string
}

/**
 * Fetch events for a vehicle from R2, optionally filtered by type.
 */
async function fetchVehicleEvents(
  vehicleReg: string,
  eventType?: string,
): Promise<EventIndexEntry[]> {
  const params = new URLSearchParams({ vehicleReg })
  if (eventType) params.set('eventType', eventType)

  const response = await apiFetch(`/get-events?${params}`)
  if (!response.ok) {
    throw new Error(`Failed to fetch events: HTTP ${response.status}`)
  }

  const data = await response.json() as { events: EventIndexEntry[] }
  return data.events || []
}

/**
 * Fetch the full event detail from R2.
 */
async function fetchEventDetail(
  vehicleReg: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const params = new URLSearchParams({ vehicleReg, eventId })
  const response = await apiFetch(`/get-events?${params}`)
  if (!response.ok) return null

  const data = await response.json() as { event?: Record<string, unknown> }
  return data.event || null
}

/**
 * Fetch the most recent Book Out event for a vehicle registration.
 * Returns the event data needed for check-in comparison, or null if none found.
 */
export async function fetchBookOutForVehicle(
  vehicleReg: string,
): Promise<BookOutEventData | null> {
  try {
    console.log('[events-query] Fetching book-out events for:', vehicleReg)

    const events = await fetchVehicleEvents(vehicleReg, 'Book Out')

    if (events.length === 0) {
      console.log('[events-query] No book-out events found for:', vehicleReg)
      return null
    }

    // Index is already sorted by date desc — first entry is most recent
    const latest = events[0]!

    // Fetch full detail to get driver name and notes from details field
    const fullEvent = await fetchEventDetail(vehicleReg, latest.id)
    const details = (fullEvent?.details as string) || ''

    const driverMatch = details.match(/Driver:\s*(.+)/i)
    const driverName = driverMatch?.[1]?.trim() || null

    const notesMatch = details.match(/Notes:\s*([\s\S]+?)(?=\n[A-Z]|$)/i)
    const notesValue = notesMatch?.[1]?.trim() || null

    const eventData: BookOutEventData = {
      id: latest.id,
      eventDate: latest.eventDate,
      mileage: latest.mileage,
      fuelLevel: latest.fuelLevel,
      hireHopJob: latest.hireHopJob,
      clientEmail: (fullEvent?.clientEmail as string) || null,
      driverName,
      notes: notesValue,
    }

    console.log('[events-query] Found book-out event:', eventData.id, 'date:', eventData.eventDate)
    return eventData
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Query failed'
    console.error('[events-query] Failed to fetch book-out events:', errMsg)
    throw err
  }
}

export interface CheckInStatus {
  alreadyCheckedIn: boolean
  checkInDate?: string
}

/**
 * Check whether a vehicle has already been checked in after its most recent book-out.
 * Used to prevent double check-ins.
 */
export async function checkAlreadyCheckedIn(
  vehicleReg: string,
): Promise<CheckInStatus> {
  try {
    const events = await fetchVehicleEvents(vehicleReg)

    // Filter to Book Out and Check In events, already sorted by date desc
    const relevant = events.filter(
      e => e.eventType === 'Book Out' || e.eventType === 'Check In',
    )

    if (relevant.length === 0) {
      return { alreadyCheckedIn: false }
    }

    // If the most recent relevant event is a Check In, already checked in
    const mostRecent = relevant[0]!
    if (mostRecent.eventType === 'Check In') {
      return { alreadyCheckedIn: true, checkInDate: mostRecent.eventDate }
    }

    // Most recent is a Book Out — check if there's a Check In after it
    const checkInAfter = relevant.find(
      e => e.eventType === 'Check In' && e.eventDate >= mostRecent.eventDate,
    )

    if (checkInAfter) {
      return { alreadyCheckedIn: true, checkInDate: checkInAfter.eventDate }
    }

    return { alreadyCheckedIn: false }
  } catch (err) {
    console.error('[events-query] Failed to check check-in status:', err)
    // On error, don't block the flow
    return { alreadyCheckedIn: false }
  }
}

export interface LastEventData {
  id: string
  eventType: string
  eventDate: string
  mileage: number | null
  fuelLevel: string | null
}

/**
 * Fetch the most recent event (any type that records mileage/fuel) for a vehicle.
 * Used to pre-fill mileage and fuel level in the prep form.
 */
export async function fetchLastEventForVehicle(
  vehicleReg: string,
): Promise<LastEventData | null> {
  try {
    const events = await fetchVehicleEvents(vehicleReg)

    // Filter to event types that record mileage/fuel
    const MILEAGE_EVENT_TYPES = ['Check In', 'Book Out', 'Prep Completed']
    const relevant = events.filter(
      e => MILEAGE_EVENT_TYPES.includes(e.eventType) && (e.mileage != null || e.fuelLevel),
    )

    if (relevant.length === 0) return null

    // Already sorted by date desc — first is most recent
    const latest = relevant[0]!
    console.log('[events-query] Last event for', vehicleReg, ':', latest.eventType, latest.eventDate, 'mileage:', latest.mileage)

    return {
      id: latest.id,
      eventType: latest.eventType,
      eventDate: latest.eventDate,
      mileage: latest.mileage,
      fuelLevel: latest.fuelLevel,
    }
  } catch (err) {
    console.error('[events-query] Failed to fetch last event:', err)
    return null
  }
}
