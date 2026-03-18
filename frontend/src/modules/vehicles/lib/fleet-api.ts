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

export interface ComplianceSettings {
  mot_warning_days: number
  mot_urgent_days: number
  tax_warning_days: number
  tax_urgent_days: number
  insurance_warning_days: number
  insurance_urgent_days: number
  tfl_warning_days: number
  tfl_urgent_days: number
}

export const DEFAULT_COMPLIANCE: ComplianceSettings = {
  mot_warning_days: 30,
  mot_urgent_days: 7,
  tax_warning_days: 30,
  tax_urgent_days: 7,
  insurance_warning_days: 30,
  insurance_urgent_days: 7,
  tfl_warning_days: 30,
  tfl_urgent_days: 7,
}

export async function fetchComplianceSettings(): Promise<ComplianceSettings> {
  const response = await apiFetch('/compliance/settings')
  if (!response.ok) throw new Error(`Failed to fetch compliance settings: ${response.status}`)
  const data = await response.json() as Record<string, unknown>
  return { ...DEFAULT_COMPLIANCE, ...data } as ComplianceSettings
}

export async function updateComplianceSettings(updates: Partial<ComplianceSettings>): Promise<void> {
  const response = await apiFetch('/compliance/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!response.ok) throw new Error(`Failed to update compliance settings: ${response.status}`)
}

/**
 * Upload a file to a vehicle's files JSONB array.
 */
export async function uploadVehicleFile(
  vehicleId: string,
  file: File,
  label?: string,
  comment?: string,
): Promise<{ name: string; url: string; type: string }> {
  const form = new FormData()
  form.append('file', file)
  if (label) form.append('label', label)
  if (comment) form.append('comment', comment)

  const response = await apiFetch(`/fleet/${vehicleId}/files`, {
    method: 'POST',
    body: form,
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || 'File upload failed')
  }
  return response.json() as Promise<{ name: string; url: string; type: string }>
}

/**
 * Delete a file from a vehicle.
 */
export async function deleteVehicleFile(vehicleId: string, key: string): Promise<void> {
  const response = await apiFetch(`/fleet/${vehicleId}/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })
  if (!response.ok) throw new Error('File delete failed')
}

/**
 * Get a download URL for a vehicle file (authenticated blob fetch via /api/files/download).
 */
export async function fetchVehicleFileBlob(key: string): Promise<string> {
  // Use the generic files download endpoint (outside /api/vehicles prefix)
  const token = (await import('../adapters/auth-adapter')).getOpAuthState()?.token
  const response = await fetch(`/api/files/download?key=${encodeURIComponent(key)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!response.ok) throw new Error('File download failed')
  const blob = await response.blob()
  return URL.createObjectURL(blob)
}
