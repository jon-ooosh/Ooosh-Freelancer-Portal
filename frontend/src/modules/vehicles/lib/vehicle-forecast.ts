/**
 * Client wrapper for the Vehicle > Forecast tab.
 *
 * Reads the deterministic forecast + cached AI assessment from the OP backend
 * (one source of truth — same object the AI narrator reasons over), and triggers
 * an on-demand regeneration.
 */

import { apiFetch } from '../config/api-config'
import type { PrepHistorySession } from './prep-history'

export interface ForecastCorner {
  corner: 'FL' | 'FR' | 'RL' | 'RR'
  axle: 'front' | 'rear'
  label: string
  currentTread: number | null
  wearRatePer1000: number | null
  status: 'red' | 'amber' | 'green' | 'unknown'
  milesTo5mm: number | null
  milesTo4mm: number | null
  resetCount: number
}

export interface VehicleForecast {
  vehicle: { id: string; reg: string; currentMileage: number | null; simpleType: string | null; ulezCompliant?: boolean | null }
  mileage: { perDay: number | null; perWeek: number | null; annualProjected: number | null; readings: number }
  service: {
    nextDueMileage: number | null
    milesUntil: number | null
    etaWeeks: number | null
    status: 'ok' | 'soon' | 'due' | 'unknown'
    lastServiceMileage: number | null
    lastServiceDate: string | null
  }
  compliance: Array<{ kind: string; due: string | null; days: number | null; status: 'ok' | 'soon' | 'overdue' | 'unknown' }>
  fluids: Array<{ key: string; label: string; topUps: number; preps: number; milesBetween: number | null; status: 'ok' | 'watch' }>
  tyres: { corners: ForecastCorner[]; prepsWithTread: number }
  tyreEvents: Array<{ date: string | null; mileage: number | null; corners: Array<'FL' | 'FR' | 'RL' | 'RR'>; description: string }>
  costs: {
    last12mTotal: number
    perMile: number | null
    serviceTotal: number
    fuelTotal: number
    prior12mTotal: number | null
    byCategory: Array<{ type: string; total: number; count: number }>
    recent: Array<{ date: string | null; type: string; name: string; cost: number | null; garage: string | null }>
  }
  recurringIssues: Array<{ label: string; count: number; lastDate: string | null }>
  prepSessions: PrepHistorySession[]
}

export interface VehicleAssessment {
  id: string
  headline: string | null
  summary: string | null
  watch_items: Array<{ label: string; detail: string; severity: string }>
  recommendations: Array<{ action: string; reason: string; priority: string }>
  overall_status: string | null
  model: string | null
  trigger: string
  generated_at: string
}

export interface ForecastResponse {
  forecast: VehicleForecast
  assessment: VehicleAssessment | null
}

export async function fetchVehicleForecast(vehicleId: string): Promise<ForecastResponse> {
  const resp = await apiFetch(`/fleet/${vehicleId}/forecast`)
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  return resp.json() as Promise<ForecastResponse>
}

export async function regenerateAssessment(vehicleId: string): Promise<VehicleAssessment> {
  const resp = await apiFetch(`/fleet/${vehicleId}/forecast/assess`, { method: 'POST' })
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error || `HTTP ${resp.status}`)
  }
  const data = await resp.json() as { assessment: VehicleAssessment }
  return data.assessment
}
