import { useState, useRef, useCallback, useEffect } from 'react'
import { REQUIRED_PHOTOS } from '../../types/vehicle-event'
import type { CapturedPhoto, PhotoAngle } from '../../types/vehicle-event'
import { getPhotoGuide, PHOTO_GUIDE_TIPS } from '../photo/PhotoGuides'
import { compressImageWithThumb } from '../../lib/image-utils'

type ExtendedAngle = CapturedPhoto['angle']

interface PhotoCaptureProps {
  photos: CapturedPhoto[]
  onCapture: (photo: CapturedPhoto) => void
  onRemove: (angle: string) => void
  /** Optional — update a photo's metadata (currently used for editing extras' labels). */
  onUpdate?: (angle: string, partial: Partial<Pick<CapturedPhoto, 'label'>>) => void
}

const GUIDES_KEY = 'ooosh_photo_guides_enabled'

function getGuidesEnabled(): boolean {
  try {
    const val = localStorage.getItem(GUIDES_KEY)
    // Default to enabled if no preference saved
    return val === null ? true : val === 'true'
  } catch {
    return true
  }
}

/**
 * Photo capture grid with optional framing guides.
 *
 * When guides are enabled (default), tapping an empty photo slot shows a
 * full-screen guide overlay with a van diagram and framing instructions
 * before opening the camera. Experienced users can toggle guides off.
 */
export function PhotoCapture({ photos, onCapture, onRemove, onUpdate }: PhotoCaptureProps) {
  const [activeAngle, setActiveAngle] = useState<ExtendedAngle | null>(null)
  const [activeLabel, setActiveLabel] = useState<string | null>(null)
  const [showGuide, setShowGuide] = useState<PhotoAngle | null>(null)
  const [guidesEnabled, setGuidesEnabled] = useState(getGuidesEnabled)
  /**
   * Inline label-edit state for extras. When non-null, the matching extra
   * card renders a text input in place of its caption. Mobile-friendly:
   * no modal, no prompt() — just a tap-to-edit affordance.
   */
  const [editingLabelFor, setEditingLabelFor] = useState<string | null>(null)
  const [editingLabelValue, setEditingLabelValue] = useState('')
  /**
   * Angle currently being compressed after the camera returned a file.
   * Compression of a high-megapixel original takes several seconds on a
   * phone — without visible feedback users assume the photo "didn't take"
   * and retake it (validated against the 10 Jun 2026 book-out).
   */
  const [processingAngle, setProcessingAngle] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Persist guide preference
  useEffect(() => {
    try { localStorage.setItem(GUIDES_KEY, String(guidesEnabled)) } catch {}
  }, [guidesEnabled])

  const capturedMap = new Map(photos.map(p => [p.angle, p]))
  const requiredAngles = new Set(REQUIRED_PHOTOS.map(r => r.angle))
  const extraPhotos = photos.filter(p => !requiredAngles.has(p.angle as PhotoAngle))

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !activeAngle) return

      setProcessingAngle(String(activeAngle))
      try {
        // Compress for storage AND generate the ~800px PDF thumbnail in one
        // decode pass — submit no longer has to re-decode every photo.
        const { blob: compressed, pdfBase64 } = await compressImageWithThumb(file, 2048, 0.85)
        const blobUrl = URL.createObjectURL(compressed)
        const label = activeLabel || REQUIRED_PHOTOS.find(r => r.angle === activeAngle)?.label || activeAngle

        onCapture({
          angle: activeAngle,
          label,
          blobUrl,
          blob: compressed,
          timestamp: Date.now(),
          pdfBase64,
        })
      } catch (err) {
        console.error('[PhotoCapture] Failed to process photo:', err)
      } finally {
        setProcessingAngle(null)
      }

      setActiveAngle(null)
      setActiveLabel(null)
      setShowGuide(null)
      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [activeAngle, activeLabel, onCapture],
  )

  const openCamera = (angle: ExtendedAngle, label?: string) => {
    setActiveAngle(angle)
    setActiveLabel(label || null)
    setTimeout(() => fileInputRef.current?.click(), 50)
  }

  const triggerCapture = (angle: ExtendedAngle, label?: string) => {
    // If guides enabled and this is a required angle, show guide first
    const isRequired = REQUIRED_PHOTOS.some(r => r.angle === angle)
    if (guidesEnabled && isRequired) {
      setActiveAngle(angle)
      setActiveLabel(label || null)
      setShowGuide(angle as PhotoAngle)
    } else {
      openCamera(angle, label)
    }
  }

  return (
    <div>
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Guides toggle */}
      <div className="mb-3 flex items-center justify-end gap-2">
        <span className="text-xs text-gray-400">Photo guides</span>
        <button
          onClick={() => setGuidesEnabled(!guidesEnabled)}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
            guidesEnabled ? 'bg-ooosh-navy' : 'bg-gray-300'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
              guidesEnabled ? 'translate-x-4' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* Photo grid */}
      <div className="grid grid-cols-2 gap-3">
        {REQUIRED_PHOTOS.map(({ angle, label }) => {
          const captured = capturedMap.get(angle)
          const isProcessing = processingAngle === angle

          if (isProcessing) {
            return (
              <div
                key={angle}
                className="flex aspect-[4/3] w-full flex-col items-center justify-center rounded-lg border-2 border-ooosh-navy/40 bg-ooosh-navy/5"
              >
                <svg className="mb-2 h-6 w-6 animate-spin text-ooosh-navy" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                <span className="text-xs font-medium text-ooosh-navy">Processing…</span>
                <span className="mt-0.5 text-[10px] text-gray-500">{label}</span>
              </div>
            )
          }

          return (
            <div key={angle} className="relative">
              {captured ? (
                <div className="group relative aspect-[4/3] overflow-hidden rounded-lg border-2 border-green-300">
                  <img
                    src={captured.blobUrl}
                    alt={label}
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 opacity-0 transition-all group-active:bg-black/40 group-active:opacity-100">
                    <button
                      onClick={() => triggerCapture(angle)}
                      className="rounded-full bg-white/90 px-3 py-1 text-xs font-medium text-gray-800"
                    >
                      Retake
                    </button>
                    <button
                      onClick={() => onRemove(angle)}
                      className="rounded-full bg-red-500/90 px-3 py-1 text-xs font-medium text-white"
                    >
                      Remove
                    </button>
                  </div>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-2 pb-1.5 pt-4">
                    <p className="text-xs font-medium text-white">{label}</p>
                  </div>
                  <div className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
                    <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => triggerCapture(angle)}
                  className="flex aspect-[4/3] w-full flex-col items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 transition-colors active:border-ooosh-navy active:bg-ooosh-navy/5"
                >
                  {guidesEnabled ? (
                    // Show mini guide preview in the slot
                    <div className="relative flex h-full w-full flex-col items-center justify-center">
                      {(() => {
                        const GuideComponent = getPhotoGuide(angle)
                        return GuideComponent ? (
                          <div className="absolute inset-1 opacity-20">
                            <GuideComponent className="h-full w-full" />
                          </div>
                        ) : null
                      })()}
                      <svg
                        className="relative mb-1 h-5 w-5 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      <span className="relative text-xs font-medium text-gray-500">{label}</span>
                    </div>
                  ) : (
                    <>
                      <svg
                        className="mb-1 h-6 w-6 text-gray-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
                        />
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
                        />
                      </svg>
                      <span className="text-xs font-medium text-gray-500">{label}</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Extra / damage photos */}
      {extraPhotos.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-gray-600">Extra Photos ({extraPhotos.length})</p>
          <p className="mb-2 text-[10px] text-gray-400">
            Tap a label to add a description (optional) — e.g. "Pre-existing chip — driver side"
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {extraPhotos.map(photo => {
              const isEditing = editingLabelFor === photo.angle
              const placeholder = 'Add label (optional)'
              const hasCustomLabel =
                photo.label && !/^Extra Photo \d+$/i.test(photo.label) && photo.label.trim() !== ''
              const displayLabel = hasCustomLabel ? photo.label : placeholder

              return (
                <div
                  key={photo.angle}
                  className="group relative aspect-[4/3] overflow-hidden rounded-lg border-2 border-amber-300"
                >
                  <img src={photo.blobUrl} alt={photo.label} className="h-full w-full object-cover" />
                  <button
                    onClick={() => onRemove(photo.angle)}
                    className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-white"
                    aria-label="Remove photo"
                  >
                    <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  </button>
                  <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1.5 pt-3">
                    {isEditing && onUpdate ? (
                      <input
                        autoFocus
                        type="text"
                        maxLength={60}
                        value={editingLabelValue}
                        onChange={(e) => setEditingLabelValue(e.target.value)}
                        onBlur={() => {
                          const next = editingLabelValue.trim()
                          if (next && next !== photo.label) onUpdate(photo.angle, { label: next })
                          setEditingLabelFor(null)
                          setEditingLabelValue('')
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            ;(e.target as HTMLInputElement).blur()
                          } else if (e.key === 'Escape') {
                            setEditingLabelFor(null)
                            setEditingLabelValue('')
                          }
                        }}
                        className="w-full rounded bg-white/95 px-1.5 py-0.5 text-[11px] text-gray-900 outline-none ring-1 ring-amber-400"
                        placeholder={placeholder}
                      />
                    ) : (
                      <button
                        onClick={() => {
                          if (!onUpdate) return
                          setEditingLabelFor(photo.angle)
                          setEditingLabelValue(hasCustomLabel ? photo.label : '')
                        }}
                        className={`w-full truncate text-left text-[11px] font-medium ${
                          hasCustomLabel ? 'text-white' : 'italic text-white/70'
                        }`}
                        title="Tap to edit label"
                      >
                        {displayLabel}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Add an extra photo (e.g. pre-existing damage, close-up, additional angle) */}
      <button
        onClick={() => {
          if (processingAngle) return
          // Unique angle per capture so check-in can match retakes 1:1 against
          // the right book-out extra without colliding with siblings.
          const angle = `extra_${Date.now()}` as CapturedPhoto['angle']
          const label = `Extra Photo ${extraPhotos.length + 1}`
          openCamera(angle, label)
        }}
        disabled={!!processingAngle}
        className="mt-3 w-full rounded-lg border border-dashed border-gray-300 py-2.5 text-center text-xs font-medium text-gray-500 active:bg-gray-50 disabled:opacity-60"
      >
        {processingAngle?.startsWith('extra_') ? 'Processing photo…' : '+ Add extra photo (optional)'}
      </button>

      {/* Full-screen guide overlay */}
      {showGuide && (
        <PhotoGuideOverlay
          angle={showGuide}
          onTakePhoto={() => {
            setShowGuide(null)
            // Open camera after overlay dismisses
            setTimeout(() => fileInputRef.current?.click(), 100)
          }}
          onSkip={() => {
            setShowGuide(null)
            setTimeout(() => fileInputRef.current?.click(), 100)
          }}
          onClose={() => {
            setShowGuide(null)
            setActiveAngle(null)
            setActiveLabel(null)
          }}
        />
      )}
    </div>
  )
}

// ── Full-screen guide overlay ──

function PhotoGuideOverlay({
  angle,
  onTakePhoto,
  onSkip,
  onClose,
}: {
  angle: PhotoAngle
  onTakePhoto: () => void
  onSkip: () => void
  onClose: () => void
}) {
  const GuideComponent = getPhotoGuide(angle)
  const tip = PHOTO_GUIDE_TIPS[angle]
  const label = REQUIRED_PHOTOS.find(r => r.angle === angle)?.label || angle

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={onClose}
          className="rounded-full p-1 text-white/70 active:text-white"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <h3 className="text-base font-semibold text-white">{label}</h3>
        <button
          onClick={onSkip}
          className="text-xs text-white/50 active:text-white/80"
        >
          Skip
        </button>
      </div>

      {/* Guide illustration */}
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {GuideComponent && (
          <div className="w-full max-w-sm">
            <GuideComponent className="w-full" />
          </div>
        )}

        {/* Tip text */}
        <p className="mt-6 max-w-xs text-center text-sm leading-relaxed text-white/70">
          {tip}
        </p>
      </div>

      {/* Action button */}
      <div className="px-6 pb-8 pt-4">
        <button
          onClick={onTakePhoto}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-white py-4 text-base font-semibold text-gray-900 active:bg-gray-100"
        >
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
          Take Photo
        </button>
      </div>
    </div>
  )
}

// compressImage moved to ../../lib/image-utils (compressImageWithThumb) so the
// capture-time PDF-thumbnail pass is shared with the check-in PhotoComparison.
