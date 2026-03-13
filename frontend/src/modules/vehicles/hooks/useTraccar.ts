/**
 * React Query hooks for Traccar GPS data.
 */

import { useQuery } from '@tanstack/react-query'
import { getDevices, getPositions, findDeviceByReg, getTrips } from '../lib/traccar-api'
import type { TraccarDevice, TraccarPosition, TraccarTrip } from '../types/traccar'

/** Fetch all Traccar devices — cached for 5 minutes */
export function useTraccarDevices() {
  return useQuery<TraccarDevice[]>({
    queryKey: ['traccar', 'devices'],
    queryFn: getDevices,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Get a Traccar device matching a vehicle registration.
 * Returns undefined while loading, null if no tracker fitted.
 */
export function useTraccarDevice(reg: string | undefined) {
  const { data: devices } = useTraccarDevices()

  return useQuery<TraccarDevice | null>({
    queryKey: ['traccar', 'device', reg],
    queryFn: () => findDeviceByReg(reg!, devices),
    enabled: !!reg && !!devices,
    staleTime: 5 * 60 * 1000,
  })
}

/**
 * Get the latest position for a Traccar device.
 * Polls every 60 seconds for near-real-time updates.
 */
export function useTraccarPosition(deviceId: number | undefined) {
  return useQuery<TraccarPosition | null>({
    queryKey: ['traccar', 'position', deviceId],
    queryFn: async () => {
      const positions = await getPositions(deviceId!)
      return positions[0] || null
    },
    enabled: !!deviceId,
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,  // Poll every 60s
  })
}

/**
 * Get trip history for a device over a date range.
 */
export function useTraccarTrips(deviceId: number | undefined, from: string, to: string) {
  return useQuery<TraccarTrip[]>({
    queryKey: ['traccar', 'trips', deviceId, from, to],
    queryFn: () => getTrips(deviceId!, from, to),
    enabled: !!deviceId && !!from && !!to,
    staleTime: 5 * 60 * 1000,
  })
}
