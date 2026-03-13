/**
 * React Query hooks for Driver Hire Form data.
 *
 * Fetches driver details from the Monday.com Driver Hire Forms board,
 * matched by HireHop job number. Used to auto-populate book-out forms
 * and show driver info on allocations.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchHireFormsByJobNumber } from '../lib/driver-hire-api'
import type { DriverHireForm } from '../lib/driver-hire-api'

/**
 * Fetch driver hire forms for a specific HireHop job number.
 *
 * Returns all matching entries (may be multiple drivers for multi-van jobs).
 * Enabled only when a valid job number is provided.
 */
export function useDriverHireForms(hireHopJobNumber: string | null) {
  return useQuery<DriverHireForm[]>({
    queryKey: ['driver-hire-forms', hireHopJobNumber],
    queryFn: () => fetchHireFormsByJobNumber(hireHopJobNumber!),
    enabled: !!hireHopJobNumber,
    staleTime: 5 * 60 * 1000,    // 5 minutes
    gcTime: 15 * 60 * 1000,      // 15 minutes
  })
}
