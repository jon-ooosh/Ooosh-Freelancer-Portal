/**
 * Fleet API — fetches vehicle data from the OP backend.
 *
 * Previously: read from Monday.com board #4255233576.
 * Now: reads from the OP's fleet_vehicles table via /api/vehicles/fleet.
 *
 * The OP backend returns data already mapped to the Vehicle interface shape.
 */

import { apiFetch } from '../config/api-config'
import type { Vehicle } from '../types/vehicle'

/**
 * Fetch ALL vehicles from the OP fleet database.
 * Replaces the Monday.com GraphQL queries.
 */
export async function fetchAllVehicles(): Promise<Vehicle[]> {
  const response = await apiFetch('/fleet?include_inactive=true')

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to fetch fleet: ${response.status}`)
  }

  const result = await response.json() as { data: Vehicle[] }
  return result.data
}

/**
 * Fetch active fleet vehicles only (excludes old/sold).
 */
export async function fetchActiveVehicles(): Promise<Vehicle[]> {
  const response = await apiFetch('/fleet')

  if (!response.ok) {
    throw new Error(`Failed to fetch active fleet: ${response.status}`)
  }

  const result = await response.json() as { data: Vehicle[] }
  return result.data
}

/**
 * Fetch a single vehicle by ID or registration.
 */
export async function fetchVehicle(idOrReg: string): Promise<Vehicle> {
  const response = await apiFetch(`/fleet/${encodeURIComponent(idOrReg)}`)

  if (!response.ok) {
    throw new Error(`Failed to fetch vehicle: ${response.status}`)
  }

  return response.json() as Promise<Vehicle>
}

/**
 * Update a vehicle by ID. Returns the updated vehicle.
 */
export async function updateVehicle(id: string, fields: Record<string, unknown>): Promise<Vehicle> {
  const response = await apiFetch(`/fleet/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to update vehicle: ${response.status}`)
  }

  return response.json() as Promise<Vehicle>
}

/**
 * Create a new vehicle. Returns the created vehicle.
 */
export async function createVehicle(fields: Record<string, unknown>): Promise<Vehicle> {
  const response = await apiFetch('/fleet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to create vehicle: ${response.status}`)
  }

  return response.json() as Promise<Vehicle>
}
