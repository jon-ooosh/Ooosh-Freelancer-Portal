/**
 * Service Log API — CRUD for vehicle service, repair, MOT, insurance, and tax records.
 *
 * Records are stored in the vehicle_service_log table, linked to fleet_vehicles.
 */

import { apiFetch } from '../config/api-config'

export type ServiceType = 'service' | 'repair' | 'mot' | 'insurance' | 'tax' | 'tyre' | 'other'

export interface ServiceLogFile {
  name: string
  url: string
  type: string
  size?: number
  comment?: string
  uploaded_at?: string
  uploaded_by?: string
}

export interface ServiceLogRecord {
  id: string
  vehicleId: string
  name: string
  serviceType: ServiceType
  serviceDate: string | null
  mileage: number | null
  cost: number | null
  status: string | null
  garage: string | null
  hirehopJob: string | null
  notes: string | null
  nextDueDate: string | null
  nextDueMileage: number | null
  aiSummary: string | null
  aiExtracted: boolean
  files: ServiceLogFile[]
  createdBy: string | null
  createdByName: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface CreateServiceLogParams {
  name: string
  service_type: ServiceType
  service_date?: string | null
  mileage?: number | null
  cost?: number | null
  status?: string | null
  garage?: string | null
  hirehop_job?: string | null
  notes?: string | null
  next_due_date?: string | null
  next_due_mileage?: number | null
  ai_summary?: string | null
  ai_extracted?: boolean
  files?: Array<{ name: string; url: string; type: string; size?: number }>
}

/**
 * Fetch service log records for a vehicle.
 */
export async function fetchServiceLog(
  vehicleId: string,
  opts?: { type?: ServiceType; limit?: number; offset?: number },
): Promise<{ data: ServiceLogRecord[]; total: number }> {
  const params = new URLSearchParams()
  if (opts?.type) params.set('type', opts.type)
  if (opts?.limit) params.set('limit', String(opts.limit))
  if (opts?.offset) params.set('offset', String(opts.offset))

  const qs = params.toString()
  const response = await apiFetch(`/fleet/${vehicleId}/service-log${qs ? `?${qs}` : ''}`)

  if (!response.ok) {
    throw new Error(`Failed to fetch service log: ${response.status}`)
  }

  return response.json() as Promise<{ data: ServiceLogRecord[]; total: number }>
}

/**
 * Create a new service log record.
 */
export async function createServiceLogRecord(
  vehicleId: string,
  params: CreateServiceLogParams,
): Promise<ServiceLogRecord> {
  const response = await apiFetch(`/fleet/${vehicleId}/service-log`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to create record: ${response.status}`)
  }

  return response.json() as Promise<ServiceLogRecord>
}

/**
 * Update an existing service log record.
 */
export async function updateServiceLogRecord(
  vehicleId: string,
  logId: string,
  fields: Partial<CreateServiceLogParams>,
): Promise<ServiceLogRecord> {
  const response = await apiFetch(`/fleet/${vehicleId}/service-log/${logId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fields),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Failed to update record: ${response.status}`)
  }

  return response.json() as Promise<ServiceLogRecord>
}

/**
 * Delete a service log record.
 */
export async function deleteServiceLogRecord(
  vehicleId: string,
  logId: string,
): Promise<void> {
  const response = await apiFetch(`/fleet/${vehicleId}/service-log/${logId}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    throw new Error(`Failed to delete record: ${response.status}`)
  }
}

/**
 * Upload a file to a service log record.
 */
export async function uploadServiceLogFile(
  vehicleId: string,
  logId: string,
  file: File,
  comment?: string,
): Promise<ServiceLogFile> {
  const formData = new FormData()
  formData.append('file', file)
  if (comment?.trim()) {
    formData.append('comment', comment.trim())
  }

  const response = await apiFetch(`/fleet/${vehicleId}/service-log/${logId}/files`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error || `Upload failed: ${response.status}`)
  }

  return response.json() as Promise<ServiceLogFile>
}

/**
 * Delete a file from a service log record.
 */
export async function deleteServiceLogFile(
  vehicleId: string,
  logId: string,
  key: string,
): Promise<void> {
  const response = await apiFetch(`/fleet/${vehicleId}/service-log/${logId}/files`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  })

  if (!response.ok) {
    throw new Error(`Failed to delete file: ${response.status}`)
  }
}
