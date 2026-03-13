import { useState, useRef, useCallback } from 'react'
import { REQUIRED_PHOTOS } from '../../types/vehicle-event'
import { compressImage } from '../../lib/image-utils'
import { PhotoLightbox } from '../shared/PhotoLightbox'
import type { CapturedPhoto, PhotoAngle } from '../../types/vehicle-event'

interface PhotoComparisonProps {
  /** Book-out photos: angle -> R2 URL */
  bookOutPhotos: Map<string, string>
  /** Current check-in photos */
  currentPhotos: CapturedPhoto[]
  onCapture: (photo: CapturedPhoto) => void
  onRemove: (angle: string) => void
  onFlagDamage: (angle: string) => void
}

/**
 * Side-by-side photo comparison for check-in.
 * Shows each required angle with the book-out photo alongside a capture slot.
 * Mobile-optimised: stacked vertically per angle.
 */
export function PhotoComparison({
  bookOutPhotos,
  currentPhotos,
  onCapture,
  onRemove,
  onFlagDamage,
}: PhotoComparisonProps) {
  const [activeAngle, setActiveAngle] = useState<PhotoAngle | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const capturedMap = new Map(currentPhotos.map(p => [p.angle, p]))

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !activeAngle) return

      const compressed = await compressImage(file, 2048, 0.85)
      const blobUrl = URL.createObjectURL(compressed)
      const label = REQUIRED_PHOTOS.find(r => r.angle === activeAngle)?.label || activeAngle

      onCapture({
        angle: activeAngle,
        label,
        blobUrl,
        blob: compressed,
        timestamp: Date.now(),
      })

      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [activeAngle, onCapture],
  )

  const triggerCapture = (angle: PhotoAngle) => {
    setActiveAngle(angle)
    setTimeout(() => fileInputRef.current?.click(), 50)
  }

  const capturedCount = currentPhotos.filter(p =>
    REQUIRED_PHOTOS.some(r => r.angle === p.angle),
  ).length

  return (
    <div className="space-y-4">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Progress */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">Condition Photos</p>
        <span className={`text-xs font-medium ${
          capturedCount >= REQUIRED_PHOTOS.length ? 'text-green-600' : 'text-amber-600'
        }`}>
          {capturedCount} / {REQUIRED_PHOTOS.length} captured
        </span>
      </div>

      {/* Comparison grid — one card per angle */}
      {REQUIRED_PHOTOS.map(({ angle, label }) => {
        const bookOutUrl = bookOutPhotos.get(angle)
        const captured = capturedMap.get(angle)

        return (
          <div key={angle} className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            {/* Angle header */}
            <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5">
              <span className="text-xs font-semibold text-gray-700">{label}</span>
              {captured && (
                <button
                  onClick={() => onFlagDamage(angle)}
                  className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 active:bg-red-100"
                >
                  Flag Damage
                </button>
              )}
            </div>

            {/* Photo pair */}
            <div className="grid grid-cols-2 gap-px bg-gray-100">
              {/* Book-out photo (left) */}
              <div className="bg-white p-1.5">
                <p className="mb-1 text-center text-[10px] font-medium text-gray-400 uppercase tracking-wide">Book-Out</p>
                {bookOutUrl ? (
                  <div
                    className="aspect-[4/3] cursor-pointer overflow-hidden rounded border border-gray-200"
                    onClick={() => setLightbox({ src: bookOutUrl, alt: `Book-out ${label}` })}
                  >
                    <img
                      src={bookOutUrl}
                      alt={`Book-out ${label}`}
                      className="h-full w-full object-cover"
                      loading="lazy"
                    />
                  </div>
                ) : (
                  <div className="flex aspect-[4/3] items-center justify-center rounded border border-dashed border-gray-200 bg-gray-50">
                    <span className="text-[10px] text-gray-300">No photo</span>
                  </div>
                )}
              </div>

              {/* Current photo (right) — capture slot */}
              <div className="bg-white p-1.5">
                <p className="mb-1 text-center text-[10px] font-medium text-ooosh-navy uppercase tracking-wide">Now</p>
                {captured ? (
                  <div className="group relative aspect-[4/3] overflow-hidden rounded border-2 border-green-300">
                    <img
                      src={captured.blobUrl}
                      alt={`Check-in ${label}`}
                      className="h-full w-full cursor-pointer object-cover"
                      onClick={() => setLightbox({ src: captured.blobUrl, alt: `Check-in ${label}` })}
                    />
                    {/* Overlay on tap */}
                    <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/0 opacity-0 transition-all group-active:bg-black/40 group-active:opacity-100">
                      <button
                        onClick={() => triggerCapture(angle)}
                        className="rounded bg-white/90 px-2.5 py-1 text-xs font-medium text-gray-700"
                      >
                        Retake
                      </button>
                      <button
                        onClick={() => onRemove(angle)}
                        className="rounded bg-white/90 px-2.5 py-1 text-xs font-medium text-red-600"
                      >
                        Remove
                      </button>
                    </div>
                    {/* Green tick */}
                    <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
                      <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => triggerCapture(angle)}
                    className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded border-2 border-dashed border-gray-300 bg-gray-50 active:bg-gray-100"
                  >
                    <svg className="h-6 w-6 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    <span className="text-[10px] font-medium text-gray-400">Capture</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}

      {/* Lightbox */}
      {lightbox && (
        <PhotoLightbox
          src={lightbox.src}
          alt={lightbox.alt}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  )
}
