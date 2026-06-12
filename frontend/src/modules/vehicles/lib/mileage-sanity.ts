// Non-blocking sanity check for odometer readings.
//
// Catches fat-fingered entries (an extra digit / a transposition) that would
// otherwise ratchet a vehicle's current_mileage permanently high — every
// mileage write path only ever moves the figure UP, so a single bad high
// reading sticks until someone corrects it by hand (the RX73TBZ incident,
// May 2026: a 132,782 service-record typo locked the van's mileage 35k miles
// above reality).
//
// Thresholds are intentionally generous: Ooosh vans can cover ~50k/year and
// big travel days (London<->Glasgow round trips), so the goal is to flag a
// genuinely implausible jump, not to police a normal high-mileage hire.
//
// To tune from the UI later, promote these to calculator_settings — for a
// non-blocking warning, hardcoded constants are proportionate for now.

export const MILEAGE_WARN_PER_DAY = 400 // average miles/day allowance
export const MILEAGE_WARN_FLOOR = 500 // minimum allowance when a date span is known
export const MILEAGE_WARN_NO_DATE_CAP = 12000 // allowance when no last-reading date (~30 days at the daily rate)

export type MileageCheckLevel = 'ok' | 'lower' | 'high'

export interface MileageCheckResult {
  level: MileageCheckLevel
  message: string | null
}

/**
 * Resolve the floor a new odometer reading is checked against.
 *
 * Prefer the canonical fleet `current_mileage` over the last raw event reading.
 * `current_mileage` is the ONLY figure a manager can correct DOWN (via the
 * audited correction endpoint) to undo a fat-fingered high entry — every event
 * write only ever ratchets up. If prep/book-out kept blocking against the last
 * raw event instead, a corrected van would stay stuck because the bad event
 * still sits in history (the RX21UOB incident, Jun 2026: mileage corrected to
 * 170,915 on the fleet board, but prep + book-out still floored at the bad
 * 179,902 check-in event). Falls back to the last event reading when no
 * canonical figure exists yet.
 */
export function resolveMileageFloor(opts: {
  currentMileage: number | null | undefined
  lastEventMileage: number | null | undefined
}): number | null {
  const current = Number(opts.currentMileage)
  if (Number.isFinite(current) && current > 0) return current
  const last = Number(opts.lastEventMileage)
  if (Number.isFinite(last) && last > 0) return last
  return null
}

function toTime(d: string | Date | null | undefined): number | null {
  if (!d) return null
  const t = new Date(d).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Compare a freshly-entered odometer reading against the last known reading.
 * Returns 'lower' (below baseline — backdate/correction territory), 'high'
 * (an implausible jump — likely a typo), or 'ok'. Always non-blocking; the
 * caller decides whether to show the message and/or require a confirm.
 */
export function checkMileagePlausibility(opts: {
  newReading: number | null | undefined
  lastReading: number | null | undefined
  lastReadingDate?: string | Date | null
  newReadingDate?: string | Date | null
}): MileageCheckResult {
  const newReading = Number(opts.newReading)
  const lastReading = Number(opts.lastReading)

  if (!Number.isFinite(newReading) || newReading <= 0) return { level: 'ok', message: null }
  if (!Number.isFinite(lastReading) || lastReading <= 0) return { level: 'ok', message: null }

  if (newReading < lastReading) {
    return {
      level: 'lower',
      message: `That's ${(lastReading - newReading).toLocaleString()} mi below the last recorded reading (${lastReading.toLocaleString()} mi). Only continue if this is a backdated record or a deliberate correction.`,
    }
  }

  let allowed = MILEAGE_WARN_NO_DATE_CAP
  const lastT = toTime(opts.lastReadingDate)
  if (lastT != null) {
    const newT = toTime(opts.newReadingDate) ?? Date.now()
    const days = Math.max(0, Math.round((newT - lastT) / (1000 * 60 * 60 * 24)))
    allowed = Math.max(days * MILEAGE_WARN_PER_DAY, MILEAGE_WARN_FLOOR)
  }

  const jump = newReading - lastReading
  if (jump > allowed) {
    return {
      level: 'high',
      message: `That's ${jump.toLocaleString()} mi above the last reading (${lastReading.toLocaleString()} mi) — more than the expected ~${allowed.toLocaleString()} mi. Double-check for a typo (an extra digit?).`,
    }
  }

  return { level: 'ok', message: null }
}
