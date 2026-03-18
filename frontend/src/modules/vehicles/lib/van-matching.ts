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
 * Find vehicles matching a requirement, excluding already-allocated ones.
 * Returns ALL matching vehicles (including On Hire for planning ahead),
 * sorted by availability: Available first, then Prep Needed, then On Hire.
 *
 * Filters:
 * - Not old/sold
 * - Not already allocated to another job
 * - Matches the type + gearbox requirement
 *
 * Does NOT filter by hire status — the UI shows warnings for non-Available vehicles.
 */
export function findMatchingVehicles(
  vehicles: Vehicle[],
  requirement: VanRequirement,
  existingAllocations: VanAllocation[],
): Vehicle[] {
  // Build set of already-allocated vehicle IDs
  const allocatedVehicleIds = new Set(
    existingAllocations.map(a => a.vehicleId),
  )

  return vehicles
    .filter(v => {
      // Must not be old/sold
      if (v.isOldSold) return false
      // Must not already be allocated
      if (allocatedVehicleIds.has(v.id)) return false
      // Must match the requirement (type + gearbox)
      return vehicleMatchesRequirement(v, requirement)
    })
    .sort((a, b) => getStatusPriority(a.hireStatus) - getStatusPriority(b.hireStatus))
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
