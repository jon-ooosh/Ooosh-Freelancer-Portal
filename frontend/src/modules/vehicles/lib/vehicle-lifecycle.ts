/**
 * Vehicle lifespan helpers — the "5 years from first registration" sell window
 * Ooosh plans disposals around, plus the countdown to it.
 *
 * The lifespan is a global default (jon, May 2026 — 5 years). Kept as a
 * constant here for now; if it ever needs to be staff-editable it should move
 * to `system_settings` (key e.g. `vehicle_lifespan_years`) and be fetched, but
 * a single fleet-wide number doesn't justify that plumbing yet.
 */

export const VEHICLE_LIFESPAN_YEARS = 5

/** The date a van hits its planned sell window: first registration + 5 years. */
export function sellByDate(dateFirstReg: string | null | undefined): Date | null {
  if (!dateFirstReg) return null
  const d = new Date(dateFirstReg + 'T00:00:00')
  if (isNaN(d.getTime())) return null
  d.setFullYear(d.getFullYear() + VEHICLE_LIFESPAN_YEARS)
  return d
}

export type LifespanUrgency = 'ok' | 'soon' | 'overdue'

export interface LifespanCountdown {
  /** Human countdown, e.g. "3 years 4 months", "5 months", "Due now", "8 months ago". */
  text: string
  /** ok = >12 months away, soon (amber) = within 12 months, overdue (red) = passed. */
  urgency: LifespanUrgency
  /** Whole months from now to the sell date (negative once passed). */
  months: number
}

/** "3 years 4 months" style label from a whole-month count. */
function formatYearsMonths(totalMonths: number): string {
  const years = Math.floor(totalMonths / 12)
  const months = totalMonths % 12
  const parts: string[] = []
  if (years > 0) parts.push(`${years} year${years === 1 ? '' : 's'}`)
  if (months > 0) parts.push(`${months} month${months === 1 ? '' : 's'}`)
  if (parts.length === 0) return 'less than a month'
  return parts.join(' ')
}

/**
 * Countdown from today to the sell-by date. Colour thresholds:
 *   - more than 12 months away → 'ok'
 *   - within 12 months         → 'soon' (amber)
 *   - on/after the date        → 'overdue' (red)
 */
export function lifespanCountdown(dateFirstReg: string | null | undefined): LifespanCountdown | null {
  const target = sellByDate(dateFirstReg)
  if (!target) return null

  const now = new Date()
  // Whole-month difference, rounding by day-of-month.
  let months = (target.getFullYear() - now.getFullYear()) * 12 + (target.getMonth() - now.getMonth())
  if (target.getDate() < now.getDate()) months -= 1

  if (months < 0) {
    const ago = formatYearsMonths(Math.abs(months))
    return { text: `${ago} ago`, urgency: 'overdue', months }
  }
  if (months === 0) {
    return { text: 'Due now', urgency: 'overdue', months }
  }
  return {
    text: formatYearsMonths(months),
    urgency: months <= 12 ? 'soon' : 'ok',
    months,
  }
}

/** GBP formatter for cost/price displays (no decimals when whole). */
export function formatGbp(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)
}
