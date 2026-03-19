/**
 * React Query hooks for Driver Hire Form data.
 *
 * Fetches driver details from the OP backend (vehicle_hire_assignments + drivers),
 * matched by HireHop job number. Used to auto-populate book-out forms
 * and show driver info on allocations.
 */

import { useQuery } from '@tanstack/react-query'
import { fetchHireFormsByJobNumber, fetchActiveHireForms } from '../lib/driver-hire-api'
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

/**
 * Fetch all active hire forms with linked drivers (cross-job fallback).
 * Used when no hire forms found for the selected job.
 */
export function useActiveHireForms(enabled: boolean) {
  return useQuery<DriverHireForm[]>({
    queryKey: ['active-hire-forms'],
    queryFn: fetchActiveHireForms,
    enabled,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}
