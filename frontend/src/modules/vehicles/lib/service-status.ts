/**
 * Service status helpers — shared between the Fleet table overview and the
 * Vehicle detail Key Dates section so the colour coding and thresholds stay
 * consistent everywhere. Mirrors the backend compliance-checker logic.
 */

import { getDateUrgency } from '../types/vehicle'
import type { DateUrgency, Vehicle } from '../types/vehicle'
import type { ComplianceSettings } from './fleet-api'

export interface ServiceMileageStatus {
  /** next_service_due − current_mileage. Negative = overdue. Null when unknown. */
  milesRemaining: number | null
  urgency: DateUrgency
}

/**
 * General (mileage-based) service status. Green when comfortably ahead,
 * amber within the warning threshold, red once overdue.
 */
export function getServiceMileageStatus(
  vehicle: Pick<Vehicle, 'nextServiceDue' | 'currentMileage'>,
  warningMiles: number,
): ServiceMileageStatus {
  const { nextServiceDue, currentMileage } = vehicle
  if (nextServiceDue == null || nextServiceDue <= 0 || currentMileage == null) {
    return { milesRemaining: null, urgency: 'unknown' }
  }
  const milesRemaining = nextServiceDue - currentMileage
  const urgency: DateUrgency =
    milesRemaining <= 0 ? 'overdue' : milesRemaining <= warningMiles ? 'soon' : 'ok'
  return { milesRemaining, urgency }
}

export interface RossettsStatus {
  /** Next Rossetts service due date (YYYY-MM-DD), or null when not applicable / undeterminable. */
  dueDate: string | null
  urgency: DateUrgency
  /** true when this is the first (warranty-window) service rather than an annual repeat. */
  isFirstService: boolean
}

/**
 * Shift a YYYY-MM-DD date, returning null when the input can't be parsed.
 *
 * The null guard is load-bearing: these run inside the fleet table's row map,
 * so an unparseable date used to throw "Invalid time value" out of
 * toISOString() and take the whole page down (RX73TBZ, stored with year 0006,
 * Sep 2026). Any year that isn't exactly 4 digits produces an Invalid Date.
 * Mirrors the same guard in `vehicle-lifecycle.ts` sellByDate().
 */
function shiftDate(dateStr: string, apply: (d: Date) => void): string | null {
  const d = new Date(dateStr + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return null
  apply(d)
  // The shift itself can still overflow the Date range (or land on NaN if a
  // settings value is non-numeric), so re-check before serialising.
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().split('T')[0]!
}

function addMonths(dateStr: string, months: number): string | null {
  return shiftDate(dateStr, d => d.setMonth(d.getMonth() + months))
}

function addYears(dateStr: string, years: number): string | null {
  return shiftDate(dateStr, d => d.setFullYear(d.getFullYear() + years))
}

/**
 * Rossetts annual warranty service status. Only meaningful for vans flagged
 * `rossettsApplicable` (Mercedes / on-plan). Next due is one interval after the
 * last Rossetts service, or — for a van never Rossetts-serviced — the initial
 * warranty window after first registration.
 */
export function getRossettsStatus(
  vehicle: Pick<Vehicle, 'rossettsApplicable' | 'lastRossettsServiceDate' | 'dateFirstReg'>,
  settings: Pick<ComplianceSettings, 'rossetts_interval_months' | 'rossetts_first_service_years' | 'rossetts_warning_days'>,
): RossettsStatus {
  if (!vehicle.rossettsApplicable) {
    return { dueDate: null, urgency: 'unknown', isFirstService: false }
  }

  let dueDate: string | null = null
  let isFirstService = false
  if (vehicle.lastRossettsServiceDate) {
    dueDate = addMonths(vehicle.lastRossettsServiceDate, settings.rossetts_interval_months)
  } else if (vehicle.dateFirstReg) {
    dueDate = addYears(vehicle.dateFirstReg, settings.rossetts_first_service_years)
    isFirstService = true
  }

  if (!dueDate) return { dueDate: null, urgency: 'unknown', isFirstService }

  return {
    dueDate,
    urgency: getDateUrgency(dueDate, settings.rossetts_warning_days),
    isFirstService,
  }
}

/** Tailwind text colour for a given urgency, used for compact table cells. */
export const URGENCY_TEXT: Record<DateUrgency, string> = {
  ok: 'text-green-700',
  soon: 'text-amber-600',
  overdue: 'text-red-600 font-semibold',
  unknown: 'text-gray-400',
}

/** Tailwind dot colour for a given urgency. */
export const URGENCY_DOT: Record<DateUrgency, string> = {
  ok: 'bg-green-500',
  soon: 'bg-amber-500',
  overdue: 'bg-red-500',
  unknown: 'bg-gray-300',
}
