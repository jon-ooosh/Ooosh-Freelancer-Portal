/**
 * React Query hooks for HireHop job data.
 *
 * All data reads from the OP backend's jobs table via /api/vehicles/jobs/*.
 * The OP backend syncs jobs AND line items from HireHop every 30 minutes.
 *
 * Line items are stored in the jobs.line_items JSONB column, so the
 * Allocations page loads instantly (single DB query) with no per-job
 * HireHop API calls.
 *
 * "Refresh from HireHop" button triggers on-demand item sync for
 * visible jobs via POST /api/vehicles/jobs/refresh-items.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../config/api-config'
import type { HireHopJob } from '../types/hirehop'
import { useState, useCallback } from 'react'

/** Fetch jobs from the OP backend */
async function fetchJobsFromOP(endpoint: string): Promise<HireHopJob[]> {
  const response = await apiFetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.status}`)
  }
  return response.json() as Promise<HireHopJob[]>
}

/**
 * Fetch jobs from OP backend. Line items are now stored locally in the
 * jobs table (synced from HireHop every 30 min). No per-job HireHop
 * API calls needed — the Allocations page loads instantly.
 *
 * Jobs with empty line_items (not yet synced) are returned as-is.
 * Use the "Refresh from HireHop" button to trigger an on-demand sync.
 */
async function fetchJobsWithItems(endpoint: string): Promise<HireHopJob[]> {
  return fetchJobsFromOP(endpoint)
}

/**
 * Fetch jobs going out today and tomorrow.
 */
export function useGoingOutJobs() {
  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-going-out'],
    queryFn: () => fetchJobsFromOP('/jobs/going-out'),
    staleTime: 2 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch jobs due back today and tomorrow.
 */
export function useDueBackJobs() {
  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-due-back'],
    queryFn: () => fetchJobsFromOP('/jobs/due-back'),
    staleTime: 2 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch upcoming jobs for a configurable number of days ahead.
 * Used by Allocations page.
 */
export function useUpcomingJobs(daysAhead: number = 7) {
  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-upcoming', daysAhead],
    queryFn: () => fetchJobsWithItems(`/jobs/upcoming?days=${daysAhead}`),
    staleTime: 2 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch upcoming due-back jobs for planning.
 * Used by Allocations page.
 */
export function useUpcomingDueBackJobs(daysAhead: number = 7) {
  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-upcoming-due-back', daysAhead],
    queryFn: () => fetchJobsWithItems(`/jobs/upcoming-due-back?days=${daysAhead}`),
    staleTime: 2 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch a single job by HireHop job number.
 * Reads from OP database first. Falls back to HireHop API via proxy
 * for fresh data or if the job isn't synced yet.
 */
export function useHireHopJob(jobId: number | null) {
  return useQuery<HireHopJob>({
    queryKey: ['hirehop-job', jobId],
    queryFn: async () => {
      // Try OP database first
      const response = await apiFetch(`/jobs/${jobId}`)
      if (response.ok) {
        return response.json() as Promise<HireHopJob>
      }

      // Fall back to HireHop API via proxy (for unsynced jobs)
      const { fetchJob } = await import('../lib/hirehop-api')
      return fetchJob(jobId!)
    },
    enabled: jobId != null,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })
}

/**
 * Hook for the cache sync timestamp — tells the UI how fresh the data is.
 * Now reads from the OP's sync_log instead of R2 cache metadata.
 */
export function useHireHopCacheMeta() {
  const meta = useQuery<{ syncedAt: string | null; source: string }>({
    queryKey: ['hirehop-cache-meta'],
    queryFn: async () => {
      const response = await apiFetch('/jobs/cache-meta')
      if (!response.ok) return { syncedAt: null, source: 'op-database' }
      return response.json() as Promise<{ syncedAt: string | null; source: string }>
    },
    staleTime: 5 * 60 * 1000,
  })

  return {
    syncedAt: meta.data?.syncedAt ?? null,
    isLoading: meta.isLoading,
    hasCache: Boolean(meta.data?.syncedAt),
  }
}

/**
 * Hook for triggering a data refresh.
 * Optionally triggers an on-demand HireHop item sync for visible jobs,
 * then invalidates all job queries so they re-fetch from the OP backend.
 */
export function useRefreshHireHopCache() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = useCallback(async (jobNumbers?: number[]) => {
    setIsRefreshing(true)
    setError(null)
    try {
      // If job numbers provided, trigger on-demand item sync from HireHop
      if (jobNumbers && jobNumbers.length > 0) {
        const response = await apiFetch('/jobs/refresh-items', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobNumbers }),
        })
        if (!response.ok) {
          const err = await response.json().catch(() => ({})) as { error?: string }
          throw new Error(err.error || `Refresh failed: ${response.status}`)
        }
      }

      // Invalidate all job queries — they'll re-fetch from OP backend
      await queryClient.invalidateQueries({ queryKey: ['hirehop-going-out'] })
      await queryClient.invalidateQueries({ queryKey: ['hirehop-due-back'] })
      await queryClient.invalidateQueries({ queryKey: ['hirehop-upcoming'] })
      await queryClient.invalidateQueries({ queryKey: ['hirehop-upcoming-due-back'] })
      await queryClient.invalidateQueries({ queryKey: ['hirehop-cache-meta'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }, [queryClient])

  return { refresh, isRefreshing, error }
}
