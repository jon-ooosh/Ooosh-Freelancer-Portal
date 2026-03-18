/**
 * React Query hooks for HireHop job data.
 *
 * Previously: Cache-first from R2, fallback to live HireHop API.
 * Now: Reads from the OP backend's jobs table via /api/vehicles/jobs/*.
 *
 * The OP backend syncs jobs from HireHop every 30 minutes, so data
 * is always reasonably fresh without any direct HireHop API calls.
 *
 * For line items (van requirements on allocations page), we still
 * fetch from HireHop via the proxy at /api/vehicles/hirehop since
 * the OP doesn't store line items.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../config/api-config'
import type { HireHopJob } from '../types/hirehop'
import { useState, useCallback } from 'react'
import { fetchJobItemsQueued } from '../lib/hirehop-api'

/** Fetch jobs from the OP backend */
async function fetchJobsFromOP(endpoint: string): Promise<HireHopJob[]> {
  const response = await apiFetch(endpoint)
  if (!response.ok) {
    throw new Error(`Failed to fetch jobs: ${response.status}`)
  }
  return response.json() as Promise<HireHopJob[]>
}

/**
 * Fetch jobs from OP backend, then enrich with HireHop line items.
 * Items are needed by the Allocations page to extract van requirements.
 */
async function fetchAndEnrichJobs(endpoint: string): Promise<HireHopJob[]> {
  const jobs = await fetchJobsFromOP(endpoint)
  if (jobs.length === 0) return jobs

  // Enrich each job with items from HireHop via the throttled queue
  const enriched = await Promise.all(
    jobs.map(async (job) => {
      if (job.id <= 0) return job
      try {
        const items = await fetchJobItemsQueued(job.id)
        return { ...job, items }
      } catch (err) {
        console.warn(`[useHireHopJobs] Failed to fetch items for job ${job.id}:`, err)
        return { ...job, itemsFetchFailed: true }
      }
    })
  )
  return enriched
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
    queryFn: () => fetchAndEnrichJobs(`/jobs/upcoming?days=${daysAhead}`),
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
    queryFn: () => fetchAndEnrichJobs(`/jobs/upcoming-due-back?days=${daysAhead}`),
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
 * Invalidates all job queries so they re-fetch from the OP backend.
 */
export function useRefreshHireHopCache() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    setError(null)
    try {
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
