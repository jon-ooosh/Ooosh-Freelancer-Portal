/**
 * Vehicle availability hook — find vans occupied for a given hire window.
 *
 * Calls `GET /api/assignments/availability` with the job's start/end dates
 * and an `exclude_hh_job_id` so the job we're allocating for doesn't
 * self-conflict. Returns a Set of vehicle IDs that are unavailable, plus
 * the full conflict details for tooltips/messages.
 *
 * Date window uses Job Finish (not Returning) — the +1-day turnaround
 * buffer is deliberately ignored until we make it configurable. See
 * CLAUDE.md for the future tweak.
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../config/api-config'

export type UnavailableAssignment = {
  vehicleId: string
  vehicleReg: string | null
  assignmentId: string
  status: string
  jobId: string | null
  hirehopJobId: number | null
  jobName: string | null
  hhJobNumber: number | null
  effectiveStart: string | null
  effectiveEnd: string | null
  driverName: string | null
}

export type AvailabilityResult = {
  unavailable: UnavailableAssignment[]
  unavailableIds: Set<string>
}

export function useAvailability(params: {
  start: string | null | undefined
  end: string | null | undefined
  excludeHhJobId?: number | null
  enabled?: boolean
}) {
  const { start, end, excludeHhJobId, enabled = true } = params

  return useQuery<AvailabilityResult>({
    queryKey: ['assignment-availability', start, end, excludeHhJobId],
    enabled: enabled && !!start && !!end,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const qs = new URLSearchParams({ start: start!, end: end! })
      if (excludeHhJobId) qs.set('exclude_hh_job_id', String(excludeHhJobId))
      const resp = await apiFetch(`/api/assignments/availability?${qs.toString()}`)
      if (!resp.ok) {
        throw new Error(`Availability fetch failed: ${resp.status}`)
      }
      const json = await resp.json() as { data: { unavailable: UnavailableAssignment[] } }
      const unavailable = json.data?.unavailable || []
      return {
        unavailable,
        unavailableIds: new Set(unavailable.map(u => u.vehicleId)),
      }
    },
  })
}
