/**
 * React Query hook for tracker-to-vehicle assignments.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getTrackerAssignments, saveTrackerAssignments, type TrackerAssignments } from '../lib/tracker-assignments-api'
import { useCallback, useState } from 'react'

const QUERY_KEY = ['tracker-assignments']

/**
 * Hook to read tracker assignments (cached, 5-min staleTime).
 */
export function useTrackerAssignments() {
  return useQuery<TrackerAssignments>({
    queryKey: QUERY_KEY,
    queryFn: getTrackerAssignments,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * Hook for getting the tracker number for a specific vehicle.
 */
export function useVehicleTracker(vehicleReg: string | undefined) {
  const { data: assignments, isLoading } = useTrackerAssignments()
  return {
    trackerNumber: vehicleReg ? assignments?.[vehicleReg] || null : null,
    isLoading,
  }
}

/**
 * Hook for assigning/unassigning a tracker to a vehicle.
 */
export function useUpdateTrackerAssignment() {
  const queryClient = useQueryClient()
  const [isSaving, setIsSaving] = useState(false)

  const assign = useCallback(async (vehicleReg: string, trackerNumber: string | null) => {
    setIsSaving(true)
    try {
      // Read current assignments
      const current = await getTrackerAssignments()

      // If assigning a tracker, remove it from any other vehicle first
      if (trackerNumber) {
        for (const [reg, num] of Object.entries(current)) {
          if (num === trackerNumber && reg !== vehicleReg) {
            delete current[reg]
          }
        }
        current[vehicleReg] = trackerNumber
      } else {
        delete current[vehicleReg]
      }

      const result = await saveTrackerAssignments(current)
      if (result.success) {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY })
      }
      return result
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed' }
    } finally {
      setIsSaving(false)
    }
  }, [queryClient])

  return { assign, isSaving }
}
