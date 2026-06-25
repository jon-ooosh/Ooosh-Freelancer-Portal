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
  /**
   * Per-photo label index recovered from the event JSON's `photoMeta`
   * field. Maps `angle slug → human label`. Empty for events saved
   * before label persistence was added (legacy data).
   */
  photoLabels: Map<string, string>
}

export interface EventIndexEntry {
  id: string
  vehicleReg: string
  eventType: string
  eventDate: string
  mileage: number | null
  fuelLevel: string | null
  hireHopJob: string | null
  hireStatus: string | null
  createdAt: string
  /** Resolved by the backend from `jobs.hh_job_number` → `jobs.id` so the
   *  Event History UI can deep-link to the OP job detail page as well as
   *  the HireHop job page. Null when no matching OP job exists. */
  opJobId?: string | null
}

/**
 * Fetch events for a vehicle from R2, optionally filtered by type.
 */
export async function fetchVehicleEvents(
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

    const photoMetaRaw = fullEvent?.photoMeta as Array<{ angle: string; label: string }> | null | undefined
    const photoLabels = new Map<string, string>()
    if (Array.isArray(photoMetaRaw)) {
      for (const entry of photoMetaRaw) {
        if (entry?.angle && entry?.label) photoLabels.set(entry.angle, entry.label)
      }
    }

    const eventData: BookOutEventData = {
      id: latest.id,
      eventDate: latest.eventDate,
      mileage: latest.mileage,
      fuelLevel: latest.fuelLevel,
      hireHopJob: latest.hireHopJob,
      clientEmail: (fullEvent?.clientEmail as string) || null,
      driverName,
      notes: notesValue,
      photoLabels,
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
  /** True when the van CANNOT be checked in right now. */
  alreadyCheckedIn: boolean
  /** Date (YYYY-MM-DD) of the prior check-in, only set when reason is already_checked_in. */
  checkInDate?: string
  /** Specific reason the gate is blocking, so the UI can show a sensible message. */
  reason?: 'already_checked_in' | 'never_booked_out'
  /**
   * Authoritative HH job number of the van's open (booked_out/active)
   * assignment, straight from `vehicle_hire_assignments` — NOT from R2 event
   * history. This is the source of truth for which hire is being checked in.
   * The check-in flow must prefer this over the latest book-out event's job,
   * because a book-out whose history event never landed leaves the event query
   * returning a STALE book-out from a previous hire (RX73TBZ 16057↔16149).
   */
  hirehopJob?: number | null
}

/**
 * Ask the backend whether this vehicle is currently eligible for check-in.
 *
 * Source of truth is `vehicle_hire_assignments.status` in the DB — we don't
 * try to derive it from R2 event history any more (that comparison was
 * fooled by same-day book-out + check-in pairs once `eventDate` was stored
 * as a date-only string, and blocked real check-ins).
 */
export async function checkAlreadyCheckedIn(
  vehicleReg: string,
): Promise<CheckInStatus> {
  try {
    const params = new URLSearchParams({ vehicleReg })
    const response = await apiFetch(`/check-in-eligibility?${params}`)
    if (!response.ok) {
      throw new Error(`Eligibility check failed: HTTP ${response.status}`)
    }
    const data = await response.json() as {
      eligible: boolean
      reason: 'already_checked_in' | 'never_booked_out' | null
      checkInDate: string | null
      hirehopJob: number | null
    }

    if (data.eligible) {
      return { alreadyCheckedIn: false, hirehopJob: data.hirehopJob }
    }

    return {
      alreadyCheckedIn: true,
      reason: data.reason ?? undefined,
      checkInDate: data.checkInDate ?? undefined,
    }
  } catch (err) {
    console.error('[events-query] Failed to check check-in status:', err)
    // On error, don't block the flow — the backend save-event handler is
    // idempotent and will reject a second check-in on its own.
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
