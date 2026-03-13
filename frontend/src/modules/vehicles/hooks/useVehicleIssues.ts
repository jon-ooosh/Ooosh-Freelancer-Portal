/**
 * React Query hooks for vehicle-specific issues.
 */

import { useQuery } from '@tanstack/react-query'
import { getVehicleIssues, getIssue } from '../lib/issues-r2-api'
import type { VehicleIssue } from '../types/issue'

/**
 * Fetch all issues for a specific vehicle.
 * Returns full VehicleIssue objects sorted by reportedAt descending.
 */
export function useVehicleIssues(vehicleReg: string | undefined) {
  return useQuery<VehicleIssue[]>({
    queryKey: ['vehicle-issues', vehicleReg],
    queryFn: () => getVehicleIssues(vehicleReg!),
    enabled: !!vehicleReg,
    staleTime: 60 * 1000,       // 1 minute
    gcTime: 5 * 60 * 1000,     // 5 minutes
  })
}

/**
 * Fetch a single issue by vehicleReg + issueId.
 * Returns the full VehicleIssue with activity timeline.
 */
export function useIssue(vehicleReg: string | undefined, issueId: string | undefined) {
  return useQuery<VehicleIssue | null>({
    queryKey: ['issue', vehicleReg, issueId],
    queryFn: () => getIssue(vehicleReg!, issueId!),
    enabled: !!vehicleReg && !!issueId,
    staleTime: 30 * 1000,       // 30 seconds
    gcTime: 5 * 60 * 1000,     // 5 minutes
  })
}
