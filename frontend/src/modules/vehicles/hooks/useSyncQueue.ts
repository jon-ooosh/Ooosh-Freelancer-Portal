/**
 * React hook for monitoring and processing the offline submission queue.
 *
 * - Polls queue count periodically
 * - On reconnect, auto-processes pending submissions
 * - Provides manual trigger for retry
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useOnlineStatus } from './useOnlineStatus'
import {
  getPendingQueue,
  getFailedQueue,
  markProcessing,
  markFailed,
  removeFromQueue,
  retrySubmission,
} from '../lib/offline-queue'
import type { PendingSubmission } from '../lib/db'
import { processBookOutSubmission } from '../lib/sync-processors'
import { processCollectionSubmission } from '../lib/sync-processors'
import { processCheckInSubmission } from '../lib/sync-processors'

interface SyncQueueState {
  pendingCount: number
  failedCount: number
  isProcessing: boolean
  currentItem: string | null // vehicleReg of item being processed
  progress: string | null
}

export function useSyncQueue() {
  const isOnline = useOnlineStatus()
  const [state, setState] = useState<SyncQueueState>({
    pendingCount: 0,
    failedCount: 0,
    isProcessing: false,
    currentItem: null,
    progress: null,
  })
  const processingRef = useRef(false)
  const wasOfflineRef = useRef(false)

  // Refresh counts
  const refreshCounts = useCallback(async () => {
    try {
      const pending = await getPendingQueue()
      const failed = await getFailedQueue()
      setState(s => ({
        ...s,
        pendingCount: pending.length,
        failedCount: failed.length,
      }))
    } catch {
      // IDB may not be available
    }
  }, [])

  // Process a single submission
  const processSubmission = useCallback(async (submission: PendingSubmission): Promise<boolean> => {
    try {
      await markProcessing(submission)

      setState(s => ({
        ...s,
        currentItem: submission.vehicleReg,
        progress: `Syncing ${submission.vehicleReg} (${submission.flowType})...`,
      }))

      // Reconstruct CapturedPhoto objects from stored blobs
      const photos = submission.photos.map(p => ({
        angle: p.angle as import('../types/vehicle-event').CapturedPhoto['angle'],
        label: p.label,
        blob: p.blob,
        blobUrl: URL.createObjectURL(p.blob),
        timestamp: p.timestamp,
      }))

      let success = false

      switch (submission.flowType) {
        case 'book-out':
          success = await processBookOutSubmission(submission.formData, photos, submission.signatureBlob)
          break
        case 'collection':
          success = await processCollectionSubmission(submission.formData, photos, submission.signatureBlob)
          break
        case 'check-in':
          success = await processCheckInSubmission(submission.formData, photos, submission.signatureBlob)
          break
      }

      // Clean up object URLs
      photos.forEach(p => URL.revokeObjectURL(p.blobUrl))

      if (success) {
        await removeFromQueue(submission.id)
        return true
      } else {
        await markFailed(submission, 'Processing failed — will retry')
        return false
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error'
      await markFailed(submission, errorMsg)
      return false
    }
  }, [])

  // Process all pending submissions
  const processQueue = useCallback(async () => {
    if (processingRef.current || !navigator.onLine) return

    processingRef.current = true
    setState(s => ({ ...s, isProcessing: true }))

    try {
      const pending = await getPendingQueue()
      for (const submission of pending) {
        if (!navigator.onLine) break // Stop if we go offline
        await processSubmission(submission)
      }
    } finally {
      processingRef.current = false
      setState(s => ({
        ...s,
        isProcessing: false,
        currentItem: null,
        progress: null,
      }))
      await refreshCounts()
    }
  }, [processSubmission, refreshCounts])

  // Retry all failed submissions
  const retryFailed = useCallback(async () => {
    try {
      const failed = await getFailedQueue()
      for (const submission of failed) {
        await retrySubmission(submission)
      }
      await refreshCounts()
      // Then process the queue
      await processQueue()
    } catch (err) {
      console.warn('[sync-queue] Failed to retry:', err)
    }
  }, [refreshCounts, processQueue])

  // Poll counts
  useEffect(() => {
    refreshCounts()
    const interval = setInterval(refreshCounts, 10000) // Every 10s
    return () => clearInterval(interval)
  }, [refreshCounts])

  // Auto-process when coming back online
  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true
      return
    }

    if (wasOfflineRef.current) {
      wasOfflineRef.current = false
      // Small delay to let connection stabilize
      const timer = setTimeout(() => {
        processQueue()
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [isOnline, processQueue])

  return {
    ...state,
    totalQueued: state.pendingCount + state.failedCount,
    processQueue,
    retryFailed,
    refreshCounts,
  }
}
