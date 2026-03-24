/**
 * React Query hooks for van allocations.
 *
 * Allocations are stored in R2 (allocations/_index.json).
 * 30-second stale time — allocations change frequently during planning.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAllocations, saveAllocations } from '../lib/allocations-api'
import type { VanAllocation } from '../types/hirehop'

/** Fetch all active van allocations */
export function useAllocations() {
  return useQuery<VanAllocation[]>({
    queryKey: ['allocations'],
    queryFn: getAllocations,
    staleTime: 30 * 1000,       // 30 seconds — allocations change frequently
    gcTime: 5 * 60 * 1000,      // 5 minutes GC
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
    onError: (_err, _new, context) => {
      // Revert on error
      if (context?.previous) {
        queryClient.setQueryData(['allocations'], context.previous)
      }
    },
    onSettled: () => {
      // Refetch after mutation settles to sync with server
      queryClient.invalidateQueries({ queryKey: ['allocations'] })
    },
  })
}
