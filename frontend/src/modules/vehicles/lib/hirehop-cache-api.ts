/**
 * Client-side API for the HireHop R2 cache.
 *
 * Reads pre-fetched job data from R2 (instant) instead of hitting HireHop
 * directly (slow, rate-limited). The cache is populated by a scheduled
 * Netlify function and can be refreshed on-demand via the sync endpoint.
 */

import type { HireHopJob } from '../types/hirehop'
import { apiFetch } from '../config/api-config'

export interface HireHopCache {
  activeJobs: HireHopJob[]
  returnJobs: HireHopJob[]
  syncedAt: string | null
  dateRange?: { from: string; to: string }
}

/** Fetch the cached HireHop job data from R2 */
export async function getHireHopCache(): Promise<HireHopCache> {
  const response = await apiFetch('/get-hirehop-cache')
  if (!response.ok) {
    throw new Error(`Failed to fetch HireHop cache: ${response.status}`)
  }
  return response.json() as Promise<HireHopCache>
}

/**
 * Trigger a manual cache refresh (re-syncs from HireHop → R2).
 * This is the "Refresh" button action. Takes 30-60s to complete
 * since it fetches all jobs + items from HireHop.
 */
export async function refreshHireHopCache(): Promise<{
  success: boolean
  activeJobs?: number
  returnJobs?: number
  syncedAt?: string
  error?: string
}> {
  const response = await apiFetch('/sync-hirehop-cache', { method: 'POST' })
  return response.json() as Promise<{
    success: boolean
    activeJobs?: number
    returnJobs?: number
    syncedAt?: string
    error?: string
  }>
}

/**
 * Filter cached jobs by date range (client-side).
 * Replicates the same logic as searchJobs in hirehop-api.ts.
 */
export function filterCachedJobs(
  jobs: HireHopJob[],
  params: {
    dateFrom?: string
    dateTo?: string
    dateField?: 'out' | 'return'
  },
): HireHopJob[] {
  if (!params.dateFrom && !params.dateTo) return jobs

  const isValidDate = (d: string) => /^\d{4}-\d{2}-\d{2}/.test(d)

  return jobs.filter(job => {
    if (params.dateField === 'out') {
      const outDate = isValidDate(job.outDate) ? job.outDate.slice(0, 10) :
                      isValidDate(job.jobDate) ? job.jobDate.slice(0, 10) : ''
      if (!outDate) return true
      if (params.dateFrom && outDate < params.dateFrom) return false
      if (params.dateTo && outDate > params.dateTo) return false
      return true
    }

    if (params.dateField === 'return') {
      const returnDate = isValidDate(job.returnDate) ? job.returnDate.slice(0, 10) :
                         isValidDate(job.jobEndDate) ? job.jobEndDate.slice(0, 10) : ''
      if (!returnDate) return true
      if (params.dateFrom && returnDate < params.dateFrom) return false
      if (params.dateTo && returnDate > params.dateTo) return false
      return true
    }

    // Default: overlap matching
    const start = isValidDate(job.outDate) ? job.outDate.slice(0, 10) :
                   isValidDate(job.jobDate) ? job.jobDate.slice(0, 10) : ''
    const end = isValidDate(job.returnDate) ? job.returnDate.slice(0, 10) :
                isValidDate(job.jobEndDate) ? job.jobEndDate.slice(0, 10) : ''

    if (!start && !end) return true
    if (params.dateTo && start && start > params.dateTo) return false
    if (params.dateFrom && end && end < params.dateFrom) return false

    return true
  })
}
