/**
 * Van Matching — pure utility functions for matching fleet vehicles to HireHop job requirements.
 *
 * No API calls — just matching logic. Used by the AllocationsPage and BookOutPage.
 *
 * Gearbox is derived from the vehicleType field (e.g. "PREMIUM LWB (A)" = auto).
 * The simpleType field (Premium, Basic, Panel, Vito) doesn't include gearbox.
 */

import type { Vehicle } from '../types/vehicle'
import type { VanRequirement, VanAllocation } from '../types/hirehop'

/**
 * Canonical van types. A vehicle's `simple_type` must be exactly one of these
 * for it to match a HireHop-derived job requirement (the requirement infers
 * the same strings). A blank `simple_type` matches nothing — which is why the
 * fleet UI must always offer a way to set it.
 */
export const VAN_TYPES = ['Premium', 'Basic', 'Vito', 'Panel'] as const

/**
 * Derive gearbox type from vehicleType string.
 * Fleet Master board uses (A) for auto, (M) for manual.
 * Examples: "PREMIUM LWB (A)", "BASIC MWB (M)", "PANEL VAN"
 */
export function getGearbox(vehicleType: string): 'auto' | 'manual' | 'unknown' {
  if (vehicleType.includes('(A)')) return 'auto'
  if (vehicleType.includes('(M)')) return 'manual'
  return 'unknown'
}

/**
 * Format a gearbox-aware label for display.
 * e.g. "Premium auto", "Basic manual", "Panel"
 */
export function formatVanType(simpleType: string, gearbox: 'auto' | 'manual'): string {
  // Panel doesn't distinguish gearbox
  if (simpleType === 'Panel') return 'Panel'
  return `${simpleType} ${gearbox}`
}

/**
 * Check if a vehicle matches a van requirement (type + gearbox).
 */
export function vehicleMatchesRequirement(
  vehicle: Vehicle,
  requirement: VanRequirement,
): boolean {
  // Must match simple type
  if (vehicle.simpleType !== requirement.simpleType) return false

  // Panel vans don't distinguish gearbox — always match
  if (requirement.simpleType === 'Panel') return true

  // Other types: check gearbox
  const gearbox = getGearbox(vehicle.vehicleType)
  if (gearbox !== 'unknown' && gearbox !== requirement.gearbox) return false

  return true
}

/**
 * Priority order for hire status when sorting vehicles.
 * Available first (ready to go), then Prep Needed, then On Hire (will be back), then everything else.
 */
const HIRE_STATUS_PRIORITY: Record<string, number> = {
  'Available': 0,
  'Prep Needed': 1,
  'On Hire': 2,
  'Not Ready': 3,
}

function getStatusPriority(status: string): number {
  return HIRE_STATUS_PRIORITY[status] ?? 4
}

/**
 * Check if a vehicle needs a prep warning — anything that's not "Available" (prepped & ready).
 */
export function vehicleNeedsPrepWarning(vehicle: Vehicle): boolean {
  return vehicle.hireStatus !== 'Available'
}

/**
 * IDs of vehicles that are occupied for the hire window being filled.
 * Opaque to the matcher — resolved by the caller from the availability
 * endpoint (`GET /api/assignments/availability`). Empty set = no date
 * window known, fall back to showing all non-old/sold matching vans.
 */
export type UnavailableVehicleIds = Set<string>

/**
 * Find vehicles matching a requirement.
 *
 * Historically this excluded any vehicle already allocated to ANY other job,
 * which broke forward-planning: a van currently on hire 10–20 April was
 * invisible even when picking for a hire starting 23 April. The fix is to
 * filter by overlapping DATE WINDOWS, not by "allocated somewhere".
 *
 * Filters:
 * - Not old/sold
 * - Not occupied for THIS hire's date window (pass in `unavailableVehicleIds`)
 * - Matches the type + gearbox requirement
 *
 * Does NOT filter by hire status — the UI shows warnings for non-Available vehicles.
 *
 * @param unavailableVehicleIds IDs of vehicles with an overlapping assignment
 *   on a different job. Pass an empty set to skip the overlap filter (e.g.
 *   when the hire window is unknown).
 */
export function findMatchingVehicles(
  vehicles: Vehicle[],
  requirement: VanRequirement,
  unavailableVehicleIds: UnavailableVehicleIds,
): Vehicle[] {
  return vehicles
    .filter(v => {
      // Must not be old/sold
      if (v.isOldSold) return false
      // Must not be occupied for this hire's date window
      if (unavailableVehicleIds.has(v.id)) return false
      // Must match the requirement (type + gearbox)
      return vehicleMatchesRequirement(v, requirement)
    })
    .sort((a, b) => getStatusPriority(a.hireStatus) - getStatusPriority(b.hireStatus))
}

/**
 * Legacy signature — retained so callers that still pass `VanAllocation[]`
 * can migrate gradually. Extracts vehicle IDs and delegates. Prefer
 * `findMatchingVehicles` with an `UnavailableVehicleIds` set, sourced from
 * the availability endpoint.
 */
export function findMatchingVehiclesLegacy(
  vehicles: Vehicle[],
  requirement: VanRequirement,
  existingAllocations: VanAllocation[],
): Vehicle[] {
  const ids = new Set(existingAllocations.map(a => a.vehicleId))
  return findMatchingVehicles(vehicles, requirement, ids)
}

/**
 * Get the gearbox label for a vehicle, for display purposes.
 */
export function getVehicleGearboxLabel(vehicle: Vehicle): string {
  const gearbox = getGearbox(vehicle.vehicleType)
  if (gearbox === 'auto') return 'Auto'
  if (gearbox === 'manual') return 'Manual'
  return ''
}
