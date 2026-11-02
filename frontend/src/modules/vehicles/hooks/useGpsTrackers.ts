/**
 * React Query hooks for the GPS tracker register.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { getTrackers, type GpsTracker } from '../lib/gps-trackers-api'

export const TRACKERS_QUERY_KEY = ['gps-trackers']

/** Every tracker on the register, with the van it is in now. */
export function useGpsTrackers() {
  return useQuery<GpsTracker[]>({
    queryKey: TRACKERS_QUERY_KEY,
    queryFn: getTrackers,
    staleTime: 5 * 60 * 1000,
  })
}

/** The tracker fitted to this van now (undefined while loading, null = none). */
export function useVehicleTracker(vehicleId: string | undefined): GpsTracker | null | undefined {
  const { data } = useGpsTrackers()
  if (!data || !vehicleId) return undefined
  return data.find(t => t.vehicleId === vehicleId) || null
}

/** Call after any write so every view of the register refreshes. */
export function useRefreshTrackers() {
  const queryClient = useQueryClient()
  return useCallback(
    () => queryClient.invalidateQueries({ queryKey: TRACKERS_QUERY_KEY }),
    [queryClient],
  )
}
