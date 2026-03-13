/**
 * Offline submission queue.
 *
 * When a form submission fails due to no connectivity, the entire form state
 * (including photo blobs) is saved to IndexedDB. When the user comes back
 * online, the sync processor replays each submission.
 */

import {
  addPendingSubmission,
  getPendingByStatus,
  updatePendingSubmission,
  removePendingSubmission,
  getPendingSubmissionCount,
  type PendingSubmission,
  type DraftFlowType,
} from './db'
import type { CapturedPhoto } from '../types/vehicle-event'

export interface QueuedFormData {
  flowType: DraftFlowType
  formData: Record<string, unknown>
  photos: CapturedPhoto[]
  signatureBlob: Blob | null
  vehicleReg: string
}

/**
 * Queue a form submission for later processing.
 * Called when the user submits while offline or when critical operations fail.
 */
export async function queueSubmission(data: QueuedFormData): Promise<PendingSubmission> {
  return addPendingSubmission({
    flowType: data.flowType,
    formData: data.formData,
    photos: data.photos.map(p => ({
      angle: p.angle,
      label: p.label,
      blob: p.blob,
      timestamp: p.timestamp,
    })),
    signatureBlob: data.signatureBlob,
    vehicleReg: data.vehicleReg,
  })
}

/**
 * Get count of pending submissions.
 */
export async function getQueueCount(): Promise<number> {
  return getPendingSubmissionCount()
}

/**
 * Get all pending submissions.
 */
export async function getPendingQueue(): Promise<PendingSubmission[]> {
  return getPendingByStatus('pending')
}

/**
 * Get failed submissions.
 */
export async function getFailedQueue(): Promise<PendingSubmission[]> {
  return getPendingByStatus('failed')
}

/**
 * Mark a submission as processing (prevents double-processing).
 */
export async function markProcessing(submission: PendingSubmission): Promise<void> {
  await updatePendingSubmission({
    ...submission,
    status: 'processing',
  })
}

/**
 * Mark a submission as failed after a processing attempt.
 */
export async function markFailed(submission: PendingSubmission, error: string): Promise<void> {
  await updatePendingSubmission({
    ...submission,
    status: 'failed',
    retryCount: submission.retryCount + 1,
    lastError: error,
  })
}

/**
 * Reset a failed submission back to pending for retry.
 */
export async function retrySubmission(submission: PendingSubmission): Promise<void> {
  await updatePendingSubmission({
    ...submission,
    status: 'pending',
  })
}

/**
 * Remove a completed submission from the queue.
 */
export async function removeFromQueue(id: string): Promise<void> {
  await removePendingSubmission(id)
}
