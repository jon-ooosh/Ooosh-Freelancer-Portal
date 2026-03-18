/**
 * Banner shown when there are pending offline submissions waiting to sync.
 * Displays in the AppShell above the main content.
 */

import { useSyncQueue } from '../../hooks/useSyncQueue'
import { useOnlineStatus } from '../../hooks/useOnlineStatus'

export function SyncQueueBanner() {
  const isOnline = useOnlineStatus()
  const { totalQueued, pendingCount, failedCount, isProcessing, progress, retryFailed } = useSyncQueue()

  if (totalQueued === 0 && !isProcessing) return null

  // Currently processing
  if (isProcessing) {
    return (
      <div className="bg-blue-500 px-4 py-2 text-center text-sm font-medium text-white">
        <div className="flex items-center justify-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span>{progress || 'Syncing offline submissions...'}</span>
        </div>
      </div>
    )
  }

  // Has failed items
  if (failedCount > 0 && isOnline) {
    return (
      <div className="bg-red-500 px-4 py-2 text-center text-sm font-medium text-white">
        <div className="flex items-center justify-center gap-2">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{failedCount} submission{failedCount > 1 ? 's' : ''} failed to sync</span>
          <button
            onClick={retryFailed}
            className="ml-2 rounded bg-white/20 px-2 py-0.5 text-xs font-bold hover:bg-white/30"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Has pending items but offline
  if (pendingCount > 0 && !isOnline) {
    return (
      <div className="bg-amber-500 px-4 py-2 text-center text-sm font-medium text-white">
        <div className="flex items-center justify-center gap-2">
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
          </svg>
          <span>{pendingCount} submission{pendingCount > 1 ? 's' : ''} queued — will sync when online</span>
        </div>
      </div>
    )
  }

  // Has pending items and is online (will auto-process shortly)
  if (pendingCount > 0 && isOnline) {
    return (
      <div className="bg-blue-500 px-4 py-2 text-center text-sm font-medium text-white">
        <div className="flex items-center justify-center gap-2">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <span>{pendingCount} submission{pendingCount > 1 ? 's' : ''} waiting to sync...</span>
        </div>
      </div>
    )
  }

  return null
}
