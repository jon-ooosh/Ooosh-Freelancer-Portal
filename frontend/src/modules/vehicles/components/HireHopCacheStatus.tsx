/**
 * HireHop cache status indicator + refresh button.
 * Shows when data was last synced and lets users trigger a manual refresh.
 *
 * When jobNumbers are provided (e.g. from Allocations page), the refresh
 * button triggers an on-demand HireHop sync for those specific jobs,
 * pulling fresh line items from HireHop into the OP database.
 */

import { useHireHopCacheMeta, useRefreshHireHopCache } from '../hooks/useHireHopJobs'

function formatAge(syncedAt: string): string {
  const diff = Date.now() - new Date(syncedAt).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

interface HireHopCacheStatusProps {
  /** Pass visible job numbers to trigger on-demand item sync on refresh */
  jobNumbers?: number[]
}

export function HireHopCacheStatus({ jobNumbers }: HireHopCacheStatusProps) {
  const { syncedAt, hasCache } = useHireHopCacheMeta()
  const { refresh, isRefreshing, error } = useRefreshHireHopCache()

  return (
    <div className="flex items-center gap-2 text-xs text-gray-400">
      {hasCache && syncedAt ? (
        <span>
          HireHop data: {formatAge(syncedAt)}
        </span>
      ) : (
        <span>HireHop: live</span>
      )}

      <button
        onClick={() => refresh(jobNumbers)}
        disabled={isRefreshing}
        className="rounded border border-gray-200 px-2 py-0.5 text-xs font-medium text-gray-500 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
        title={jobNumbers?.length ? `Refresh ${jobNumbers.length} jobs from HireHop` : 'Refresh from database'}
      >
        {isRefreshing ? 'Syncing from HireHop...' : 'Refresh from HireHop'}
      </button>

      {error && (
        <span className="text-red-500">{error}</span>
      )}
    </div>
  )
}
