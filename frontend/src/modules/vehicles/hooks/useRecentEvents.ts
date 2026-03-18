/**
 * React Query hook for the global recent events feed.
 */

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../config/api-config'

export interface RecentEventEntry {
  id: string
  vehicleReg: string
  eventType: string
  eventDate: string
  mileage: number | null
  fuelLevel: string | null
  hireHopJob: string | null
  hireStatus: string | null
  createdAt: string
}

async function getRecentEvents(limit = 10): Promise<RecentEventEntry[]> {
  try {
    const resp = await apiFetch(`/get-recent-events?limit=${limit}`)
    if (!resp.ok) return []
    const data = await resp.json() as { events: RecentEventEntry[] }
    return data.events || []
  } catch (err) {
    console.warn('[useRecentEvents] Failed to fetch:', err)
    return []
  }
}

/**
 * Fetch the most recent events across all vehicles.
 * Used by the dashboard Recent Activity section.
 */
export function useRecentEvents(limit = 10) {
  return useQuery<RecentEventEntry[]>({
    queryKey: ['recent-events', limit],
    queryFn: () => getRecentEvents(limit),
    staleTime: 60 * 1000,      // 1 minute
    gcTime: 5 * 60 * 1000,    // 5 minutes
  })
}
