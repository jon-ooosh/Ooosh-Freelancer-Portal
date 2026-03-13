/**
 * Fuel Log API — CRUD for vehicle fuel records and fleet cost reporting.
 */

import { apiFetch } from '../config/api-config'

export interface FuelLogRecord {
  id: string
  vehicleId: string
  date: string | null
  litres: number | null
  cost: number
  mileageAtFill: number | null
  fullTank: boolean
  receiptFile: { name: string; url: string; type: string; size?: number } | null
  notes: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string | null
}

export interface FuelStats {
  totalCost: number
  totalLitres: number
  fillCount: number
  costPerMile: number | null
}

export interface FleetCostRow {
  vehicleId: string
  reg: string
  make: string
  model: string
  simpleType: string
  serviceCost: number
  serviceCount: number
  fuelCost: number
  fuelCount: number
  totalCost: number
}

export interface FleetCostReport {
  data: FleetCostRow[]
  period: { from: string; to: string }
  totals: { serviceCost: number; fuelCost: number; totalCost: number; vehicleCount: number }
}

export async function fetchFuelLog(
  vehicleId: string,
  opts?: { limit?: number; offset?: number },
): Promise<{ data: FuelLogRecord[]; total: number; stats: FuelStats }> {
  const params = new URLSearchParams()
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.offset) params.set('offset', String(opts.offset))
  const qs = params.toString()

  const response = await apiFetch(`/fleet/${vehicleId}/fuel${qs ? `?${qs}` : ''}`)
  if (!response.ok) throw new Error(`Failed to fetch fuel log: ${response.status}`)
  return response.json() as Promise<{ data: FuelLogRecord[]; total: number; stats: FuelStats }>
}

export async function createFuelRecord(
  vehicleId: string,
  params: { date: string; litres?: number | null; cost: number; mileage_at_fill?: number | null; full_tank?: boolean; notes?: string | null },
): Promise<FuelLogRecord> {
  const response = await apiFetch(`/fleet/${vehicleId}/fuel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to create record: ${response.status}`)
  }
  return response.json() as Promise<FuelLogRecord>
}

export async function deleteFuelRecord(vehicleId: string, fuelId: string): Promise<void> {
  const response = await apiFetch(`/fleet/${vehicleId}/fuel/${fuelId}`, { method: 'DELETE' })
  if (!response.ok) throw new Error(`Failed to delete: ${response.status}`)
}

export async function fetchFleetCosts(from?: string, to?: string): Promise<FleetCostReport> {
  const params = new URLSearchParams()
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  const qs = params.toString()

  const response = await apiFetch(`/fleet-costs${qs ? `?${qs}` : ''}`)
  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to fetch costs: ${response.status}`)
  }
  return response.json() as Promise<FleetCostReport>
}
