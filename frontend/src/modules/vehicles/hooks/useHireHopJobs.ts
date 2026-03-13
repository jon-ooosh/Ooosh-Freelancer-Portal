/**
 * React Query hooks for HireHop job data.
 *
 * CACHE-FIRST strategy:
 * 1. Read from R2 cache (instant, populated by scheduled sync)
 * 2. Fall back to live HireHop API if cache is empty/missing
 *
 * The cache is refreshed by:
 * - Scheduled Netlify function (5am + 12pm UTC)
 * - Manual "Refresh" button (triggers sync-hirehop-cache)
 *
 * IMPORTANT: Each queryFn fetches the cache directly via getHireHopCache()
 * rather than reading from a React state closure. This avoids a timing
 * issue where cache.data could be stale/undefined when the queryFn fires.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { searchJobsWithItems, fetchJob } from '../lib/hirehop-api'
import { getHireHopCache, filterCachedJobs, refreshHireHopCache } from '../lib/hirehop-cache-api'
import type { HireHopJob } from '../types/hirehop'
import type { HireHopCache } from '../lib/hirehop-cache-api'
import { ACTIVE_JOB_STATUSES, RETURN_JOB_STATUSES } from '../types/hirehop'
import { useState, useCallback } from 'react'

/** Format a Date as YYYY-MM-DD */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0]!
}

/** Add days to a date */
function addDays(date: Date, days: number): Date {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/**
 * Shared cache query — used for cache metadata (syncedAt display).
 * Individual job hooks fetch the cache directly inside their queryFn
 * to avoid closure timing issues.
 */
const CACHE_QUERY_KEY = ['hirehop-cache']

function useHireHopCacheQuery() {
  return useQuery<HireHopCache>({
    queryKey: CACHE_QUERY_KEY,
    queryFn: getHireHopCache,
    staleTime: 2 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })
}

/**
 * Helper: fetch cache and try to use it, with live API fallback.
 * Called inside each hook's queryFn to avoid React closure issues.
 */
async function fetchFromCacheOrLive(
  jobType: 'active' | 'return',
  filter: { dateFrom: string; dateTo: string; dateField?: 'out' | 'return' },
  liveParams: { status: string; dateFrom: string; dateTo: string; dateField?: 'out' | 'return' },
  hookName: string,
): Promise<HireHopJob[]> {
  try {
    const cached = await getHireHopCache()
    const jobs = jobType === 'active' ? cached.activeJobs : cached.returnJobs
    if (cached.syncedAt && jobs.length > 0) {
      console.log(`[${hookName}] Using cache (synced ${cached.syncedAt}, ${jobs.length} ${jobType} jobs)`)
      return filterCachedJobs(jobs, filter)
    }
    // Cache exists but empty — could be genuinely no jobs, or cache not yet populated
    if (cached.syncedAt) {
      console.log(`[${hookName}] Cache synced but no ${jobType} jobs in cache — returning empty`)
      return []
    }
  } catch (err) {
    console.warn(`[${hookName}] Cache fetch failed, falling back to live API:`, err)
  }

  // No cache at all — fall back to live API
  console.log(`[${hookName}] No cache (syncedAt=null), falling back to live HireHop API`)
  return searchJobsWithItems(liveParams)
}

/**
 * Fetch jobs going out today and tomorrow.
 * Cache-first: reads from R2 cache, falls back to live API if cache not populated.
 */
export function useGoingOutJobs() {
  const today = formatDate(new Date())
  const tomorrow = formatDate(addDays(new Date(), 1))

  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-going-out', today],
    queryFn: () => fetchFromCacheOrLive(
      'active',
      { dateFrom: today, dateTo: tomorrow, dateField: 'out' },
      { status: ACTIVE_JOB_STATUSES.join(','), dateFrom: today, dateTo: tomorrow, dateField: 'out' },
      'useGoingOutJobs',
    ),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch jobs due back today and tomorrow.
 * Cache-first: reads from R2 cache, falls back to live API if cache not populated.
 */
export function useDueBackJobs() {
  const today = formatDate(new Date())
  const tomorrow = formatDate(addDays(new Date(), 1))

  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-due-back', today],
    queryFn: () => fetchFromCacheOrLive(
      'return',
      { dateFrom: today, dateTo: tomorrow, dateField: 'return' },
      { status: RETURN_JOB_STATUSES.join(','), dateFrom: today, dateTo: tomorrow, dateField: 'return' },
      'useDueBackJobs',
    ),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch upcoming jobs for a configurable number of days ahead.
 * Used by Allocations page. Cache-first.
 */
export function useUpcomingJobs(daysAhead: number = 7) {
  const today = formatDate(new Date())
  const endDate = formatDate(addDays(new Date(), daysAhead))

  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-upcoming', today, daysAhead],
    queryFn: () => fetchFromCacheOrLive(
      'active',
      { dateFrom: today, dateTo: endDate },
      { status: ACTIVE_JOB_STATUSES.join(','), dateFrom: today, dateTo: endDate },
      'useUpcomingJobs',
    ),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch upcoming due-back jobs for planning.
 * Used by Allocations page. Cache-first.
 */
export function useUpcomingDueBackJobs(daysAhead: number = 7) {
  const today = formatDate(new Date())
  const endDate = formatDate(addDays(new Date(), daysAhead))

  return useQuery<HireHopJob[]>({
    queryKey: ['hirehop-upcoming-due-back', today, daysAhead],
    queryFn: () => fetchFromCacheOrLive(
      'return',
      { dateFrom: today, dateTo: endDate },
      { status: RETURN_JOB_STATUSES.join(','), dateFrom: today, dateTo: endDate },
      'useUpcomingDueBackJobs',
    ),
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
  })
}

/**
 * Fetch a single job by ID.
 * Always goes live — individual job lookups are fast (2 API calls).
 */
export function useHireHopJob(jobId: number | null) {
  return useQuery<HireHopJob>({
    queryKey: ['hirehop-job', jobId],
    queryFn: () => fetchJob(jobId!),
    enabled: jobId != null,
    staleTime: 2 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
  })
}

/**
 * Hook for the cache sync timestamp — tells the UI how fresh the data is.
 */
export function useHireHopCacheMeta() {
  const cache = useHireHopCacheQuery()
  return {
    syncedAt: cache.data?.syncedAt ?? null,
    isLoading: cache.isLoading,
    hasCache: Boolean(cache.data?.syncedAt),
  }
}

/**
 * Hook for triggering a manual cache refresh.
 * Returns a refresh function + loading state.
 */
export function useRefreshHireHopCache() {
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const refresh = useCallback(async () => {
    setIsRefreshing(true)
    setError(null)
    try {
      const result = await refreshHireHopCache()
      if (!result.success) {
        setError(result.error || 'Sync failed')
      } else {
        // Invalidate all HireHop queries so they re-read from updated cache
        await queryClient.invalidateQueries({ queryKey: CACHE_QUERY_KEY })
        await queryClient.invalidateQueries({ queryKey: ['hirehop-going-out'] })
        await queryClient.invalidateQueries({ queryKey: ['hirehop-due-back'] })
        await queryClient.invalidateQueries({ queryKey: ['hirehop-upcoming'] })
        await queryClient.invalidateQueries({ queryKey: ['hirehop-upcoming-due-back'] })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Refresh failed')
    } finally {
      setIsRefreshing(false)
    }
  }, [queryClient])

  return { refresh, isRefreshing, error }
}
