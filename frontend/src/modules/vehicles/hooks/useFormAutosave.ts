/**
 * Generic form autosave hook using IndexedDB.
 *
 * Saves wizard form state (including photo Blobs) to IndexedDB on every change.
 * On page return, offers to resume from the saved draft.
 *
 * Unlike localStorage-based prep autosave, this uses IDB which natively supports
 * Blob storage via structured cloning — so photos and signatures survive.
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import { saveDraft, loadDraft, clearDraft, type DraftFlowType, type FormDraft } from '../lib/db'
import type { CapturedPhoto } from '../types/vehicle-event'

const DEBOUNCE_MS = 800

interface AutosaveOptions {
  flowType: DraftFlowType
  /** Don't save drafts when in this state (e.g. already submitted) */
  disabled?: boolean
}

interface DraftData {
  step: number
  formData: Record<string, unknown>
  photos: CapturedPhoto[]
  signatureBlob: Blob | null
  vehicleReg: string
  savedAt: string
}

export function useFormAutosave({ flowType, disabled }: AutosaveOptions) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [draftLoaded, setDraftLoaded] = useState<DraftData | null>(null)
  const [draftChecked, setDraftChecked] = useState(false)

  // Check for existing draft on mount
  useEffect(() => {
    if (disabled) {
      setDraftChecked(true)
      return
    }

    loadDraft(flowType)
      .then(draft => {
        if (draft) {
          // Reconstruct CapturedPhoto objects from stored blobs
          const photos: CapturedPhoto[] = draft.photos.map(p => ({
            angle: p.angle as CapturedPhoto['angle'],
            label: p.label,
            blob: p.blob,
            blobUrl: URL.createObjectURL(p.blob),
            timestamp: p.timestamp,
          }))

          setDraftLoaded({
            step: draft.step,
            formData: draft.formData,
            photos,
            signatureBlob: draft.signatureBlob,
            vehicleReg: draft.vehicleReg,
            savedAt: draft.savedAt,
          })
        }
        setDraftChecked(true)
      })
      .catch(err => {
        console.warn('[autosave] Failed to load draft:', err)
        setDraftChecked(true)
      })
  }, [flowType, disabled])

  // Save form state (debounced)
  const save = useCallback(
    (data: {
      step: number
      formData: Record<string, unknown>
      photos: CapturedPhoto[]
      signatureBlob: Blob | null
      vehicleReg: string
    }) => {
      if (disabled) return

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        const draft: FormDraft = {
          id: flowType,
          flowType,
          step: data.step,
          formData: data.formData,
          photos: data.photos.map(p => ({
            angle: p.angle,
            label: p.label,
            blob: p.blob,
            timestamp: p.timestamp,
          })),
          signatureBlob: data.signatureBlob,
          savedAt: new Date().toISOString(),
          vehicleReg: data.vehicleReg,
        }

        saveDraft(draft).catch(err => {
          console.warn('[autosave] Failed to save draft:', err)
        })
      }, DEBOUNCE_MS)
    },
    [flowType, disabled],
  )

  // Clear draft (call on successful submit)
  const clear = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    clearDraft(flowType).catch(err => {
      console.warn('[autosave] Failed to clear draft:', err)
    })
    setDraftLoaded(null)
  }, [flowType])

  // Dismiss draft without restoring
  const dismissDraft = useCallback(() => {
    clear()
  }, [clear])

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return {
    /** Debounced save of current form state */
    save,
    /** Clear saved draft (call on successful submit) */
    clear,
    /** Loaded draft data (null if no draft or already dismissed) */
    draftLoaded,
    /** Whether initial draft check is complete */
    draftChecked,
    /** Dismiss the draft prompt without restoring */
    dismissDraft,
  }
}
