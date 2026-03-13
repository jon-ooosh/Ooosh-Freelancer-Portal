/**
 * React Query hook for the fleet-wide issues index.
 */

import { useQuery } from '@tanstack/react-query'
import { getAllIssues } from '../lib/issues-r2-api'
import type { IssueIndexEntry } from '../types/issue'

/**
 * Fetch all issues across the fleet (lightweight index entries).
 * Used by the IssuesPage list and the dashboard counter.
 */
export function useAllIssues() {
  return useQuery<IssueIndexEntry[]>({
    queryKey: ['all-issues'],
    queryFn: getAllIssues,
    staleTime: 60 * 1000,       // 1 minute
    gcTime: 5 * 60 * 1000,     // 5 minutes
  })
}
