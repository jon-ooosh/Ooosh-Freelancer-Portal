/**
 * How a studio night, a yard day and a fee read on screen. Shared by the Jobs
 * dashboard and the Completed list (FREELANCER-PORTAL-SPEC §10), so a night or
 * a yard day reads the same in both. Moved out of dashboard/page.tsx unchanged.
 */

import type { PortalDayBooking } from '@/lib/op-api'

/** SQL TIME ("17:00:00") → "5:00pm" (studio shifts). */
export function formatShiftTime(timeStr: string | null): string {
  if (!timeStr) return ''
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match) return ''
  const hours = parseInt(match[1], 10)
  return `${hours % 12 || 12}:${match[2]}${hours >= 12 ? 'pm' : 'am'}`
}

/** "5:00pm – 11:00pm", or what we know of it. */
export function shiftEnvelope(shift: { planned_start: string | null; planned_end: string | null }): string {
  const s = formatShiftTime(shift.planned_start)
  const e = formatShiftTime(shift.planned_end)
  if (s && e) return `${s} – ${e}`
  if (s) return `from ${s}`
  if (e) return `until ${e}`
  return 'Studio evening'
}

/** "£85", or '' when there is no fee. */
export function formatFee(amount: number | undefined | null): string {
  if (amount === undefined || amount === null) return ''
  return `£${amount.toFixed(0)}`
}

/** "Full day" / "Half day" / "09:00–13:00". */
export function yardHours(day: PortalDayBooking): string {
  return day.durationType === 'full_day' ? 'Full day'
    : day.durationType === 'half_day' ? 'Half day'
    : day.startTime && day.endTime ? `${day.startTime}–${day.endTime}`
    : 'Set hours'
}

/** "£140", "£15/hr", or null when no rate is set. */
export function yardFee(day: PortalDayBooking): string | null {
  if (day.agreedRate === null) return null
  return day.rateType === 'hourly' ? `${formatFee(day.agreedRate)}/hr` : formatFee(day.agreedRate)
}
