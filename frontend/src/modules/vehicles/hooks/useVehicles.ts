/**
 * React Query hook for vehicle data.
 * Handles fetching, caching, and filtering.
 */

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { fetchAllVehicles } from '../lib/fleet-api'
import type { Vehicle, VehicleListFilters } from '../types/vehicle'

/**
 * Fetch and cache all vehicles from the fleet board.
 * Stale time: 2 minutes (data doesn't change rapidly).
 */
export function useVehicles() {
  return useQuery<Vehicle[]>({
    queryKey: ['vehicles'],
    queryFn: fetchAllVehicles,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })
}

/**
 * Get a single vehicle by Monday.com item ID.
 */
export function useVehicle(id: string | undefined) {
  const { data: vehicles, ...rest } = useVehicles()
  const vehicle = useMemo(
    () => vehicles?.find(v => v.id === id),
    [vehicles, id],
  )
  return { data: vehicle, ...rest }
}

/**
 * Filtered and searchable vehicle list.
 */
export function useFilteredVehicles() {
  const { data: vehicles, ...queryState } = useVehicles()
  const [filters, setFilters] = useState<VehicleListFilters>({
    search: '',
    simpleType: null,
    damageStatus: null,
    showOldSold: false,
  })

  const filtered = useMemo(() => {
    if (!vehicles) return []

    return vehicles.filter(v => {
      // Old & Sold toggle — exclusive category
      // When "Old & Sold" is selected, ONLY show old/sold vehicles.
      // Otherwise, hide old/sold vehicles (they're excluded by default).
      if (filters.showOldSold) {
        if (!v.isOldSold) return false
      } else {
        if (v.isOldSold) return false
      }

      // Text search on reg, make, model, type
      if (filters.search) {
        const term = filters.search.toLowerCase()
        const searchable = `${v.reg} ${v.make} ${v.model} ${v.vehicleType} ${v.colour}`.toLowerCase()
        if (!searchable.includes(term)) return false
      }

      // Filter by simple type (only when NOT viewing old/sold)
      if (filters.simpleType && v.simpleType !== filters.simpleType) {
        return false
      }

      // Filter by damage status
      if (filters.damageStatus && v.damageStatus !== filters.damageStatus) {
        return false
      }

      return true
    })
  }, [vehicles, filters])

  return {
    vehicles: filtered,
    allVehicles: vehicles || [],
    filters,
    setFilters,
    ...queryState,
  }
}
