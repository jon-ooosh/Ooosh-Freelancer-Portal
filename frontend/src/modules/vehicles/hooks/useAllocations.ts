/**
 * React Query hooks for van allocations.
 *
 * Allocations are persisted to vehicle_hire_assignments via the OP
 * compat endpoint. 30-second stale time — allocations change frequently
 * during planning.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAllocations, saveAllocations } from '../lib/allocations-api'
import type { VanAllocation } from '../types/hirehop'

/** Fetch all active van allocations */
export function useAllocations(options?: { enabled?: boolean }) {
  return useQuery<VanAllocation[]>({
    queryKey: ['allocations'],
    queryFn: getAllocations,
    staleTime: 30 * 1000,       // 30 seconds — allocations change frequently
    gcTime: 5 * 60 * 1000,      // 5 minutes GC
    enabled: options?.enabled ?? true,
  })
}

/** Mutation hook for saving allocations (replaces full array) */
export function useSaveAllocations(managedJobIds?: number[]) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (allocations: VanAllocation[]) => saveAllocations(allocations, managedJobIds),
    // Optimistic update — immediately reflect changes in the UI
    onMutate: async (newAllocations) => {
      await queryClient.cancelQueries({ queryKey: ['allocations'] })
      const previous = queryClient.getQueryData<VanAllocation[]>(['allocations'])
      queryClient.setQueryData(['allocations'], newAllocations)
      return { previous }
    },
    onError: (err, _new, context) => {
      // Revert on error
      console.error('[allocations] Save failed, reverting:', err)
      if (context?.previous) {
        queryClient.setQueryData(['allocations'], context.previous)
      }
    },
    onSuccess: (result) => {
      // Surface per-allocation overlap conflicts — the backend rejects any
      // allocation that would put the same van on overlapping jobs. Normally
      // the picker filters these out (useAvailability) so users can't pick
      // them, but a stale UI or race can still produce one.
      if (result.conflicts && result.conflicts.length > 0) {
        const msg = result.conflicts.map(c => {
          const reg = c.vehicleReg || c.conflict.vehicleReg || 'Van'
          const where = c.conflict.hhJobNumber
            ? `job #${c.conflict.hhJobNumber}`
            : c.conflict.jobName || 'another hire'
          const window = c.conflict.effectiveStart && c.conflict.effectiveEnd
            ? ` (${c.conflict.effectiveStart} → ${c.conflict.effectiveEnd})`
            : ''
          return `• ${reg} is already allocated to ${where}${window}`
        }).join('\n')
        alert(
          `Some allocations couldn't be saved — overlapping dates:\n\n${msg}\n\nPick a different van or unallocate the conflicting hire first.`
        )
      }
    },
    onSettled: () => {
      // Refetch after mutation settles to sync with server
      queryClient.invalidateQueries({ queryKey: ['allocations'] })
    },
  })
}
