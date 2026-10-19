// Tyre tread sanity + threshold helpers for the prep checklist.
//
// Two problems this addresses, both surfaced by the RX24SZG blow-out
// (Jun 2026): a tyre with very low tread went out on hire because (a) staff
// enter tread as a whole number (82 = 8.2mm) so the existing ≤Nmm auto-flag
// never fired (82 > 5), and (b) nothing compared the entered figure against
// the last recorded depth, so a sudden drop went unnoticed.
//
// The cap forces decimal entry (no real tyre exceeds ~9mm of tread, so a
// figure over 10 is a missing decimal point). The sanity check is a
// non-blocking nudge mirroring mileage-sanity.ts.
//
// Thresholds are constants here as the single source of truth. The backend
// low-tread notify reads the amber figure from system_settings (default 5)
// so the email trigger is staff-tweakable; the on-screen colour thresholds
// are these constants. Promote to a settings fetch if the two ever need to
// diverge per-environment.

/** Hard cap — entries above this are rejected (a missing decimal point). */
export const TYRE_TREAD_CAP_MM = 10
/** Red "below safe minimum" threshold (inclusive). Raised from 3 → 4 Jun 2026. */
export const TYRE_TREAD_RED_MM = 4
/** Amber "getting low, plan replacement" threshold (inclusive). */
export const TYRE_TREAD_AMBER_MM = 5

export type TyreCheckLevel = 'ok' | 'increase' | 'drop'

export interface TyreCheckResult {
  level: TyreCheckLevel
  message: string | null
}

/**
 * Normalise a possibly-legacy tread reading for comparison.
 *
 * Historical preps stored tread ×10 (the data-entry bug — "82" meaning
 * 8.2mm). Anything above the cap is treated as a ×10 legacy figure and
 * divided down so the sanity comparison against a fresh decimal entry is
 * meaningful during the transition (and after the one-off normalisation
 * script has run, previous values are already decimals and this is a no-op).
 */
function normaliseLegacyTread(value: number): number {
  return value > TYRE_TREAD_CAP_MM ? value / 10 : value
}

/**
 * Compare a freshly-entered tread depth against the last recorded depth for
 * the same corner. Non-blocking — the caller decides whether to surface it.
 *
 * - 'increase' — new reading meaningfully higher than last (new/swapped tyre?)
 * - 'drop'     — new reading meaningfully lower than last (double-check / wear)
 * - 'ok'       — within normal variation, or no usable baseline
 *
 * "Meaningful" = a change of more than 1.5mm. Tread wears gradually, so a
 * jump in either direction over a single hire is worth a second look.
 */
export function checkTyreTreadPlausibility(opts: {
  newReading: number | null | undefined
  lastReading: number | null | undefined
}): TyreCheckResult {
  const newReading = Number(opts.newReading)
  const lastRaw = Number(opts.lastReading)

  if (!Number.isFinite(newReading) || newReading <= 0) return { level: 'ok', message: null }
  if (!Number.isFinite(lastRaw) || lastRaw <= 0) return { level: 'ok', message: null }

  const lastReading = normaliseLegacyTread(lastRaw)
  const delta = newReading - lastReading
  const THRESHOLD = 1.5

  if (delta > THRESHOLD) {
    return {
      level: 'increase',
      message: `Last recorded was ${lastReading}mm — you've entered ${newReading}mm. New or swapped tyre? If not, double-check the reading.`,
    }
  }

  if (delta < -THRESHOLD) {
    return {
      level: 'drop',
      message: `Last recorded was ${lastReading}mm — you've entered ${newReading}mm, a ${Math.abs(delta).toFixed(1)}mm drop. Double-check the reading and consider whether the tyre needs changing.`,
    }
  }

  return { level: 'ok', message: null }
}

/**
 * Validate a tread entry against the hard cap. Returns an error string when
 * the value is over the cap (a missing decimal point), else null.
 */
export function checkTyreTreadCap(value: string | number | null | undefined): string | null {
  const num = Number(value)
  if (!Number.isFinite(num)) return null
  if (num > TYRE_TREAD_CAP_MM) {
    return `Tread can't be over ${TYRE_TREAD_CAP_MM}mm — enter the decimal (e.g. 8.2, not 82).`
  }
  return null
}
