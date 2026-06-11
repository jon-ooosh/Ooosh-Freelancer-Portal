import { useState, useRef, useCallback } from 'react'
import { LEGACY_WINDSCREEN_ANGLE, REQUIRED_PHOTOS } from '../../types/vehicle-event'
import { compressImageWithThumb } from '../../lib/image-utils'
import { PhotoLightbox } from '../shared/PhotoLightbox'
import { AuthImage } from '../shared/AuthImage'
import type { CapturedPhoto, PhotoAngle } from '../../types/vehicle-event'

/**
 * Capture-slot angle — anything that can drive a check-in photo capture.
 * Mirrors `CapturedPhoto.angle`: required angles plus the runtime tags
 * for damage and book-out extras.
 */
type CaptureAngle = CapturedPhoto['angle']

interface PhotoComparisonProps {
  /** Book-out photos: angle -> R2 URL */
  bookOutPhotos: Map<string, string>
  /**
   * Book-out photo labels: angle -> human label, recovered from the
   * book-out event's `photoMeta` field. Empty for legacy events.
   */
  bookOutPhotoLabels?: Map<string, string>
  /** Current check-in photos */
  currentPhotos: CapturedPhoto[]
  /**
   * Angles that already have a damage item flagged from them. The flag
   * button on those angles renders as "Edit damage" so a second click
   * re-opens the existing item instead of feeling like a fresh log.
   */
  damageFlaggedAngles?: Set<string>
  onCapture: (photo: CapturedPhoto) => void
  onRemove: (angle: string) => void
  onFlagDamage: (angle: string) => void
}

/**
 * Side-by-side photo comparison for check-in.
 * Shows each required angle with the book-out photo alongside a capture
 * slot. Below the required angles, surfaces any book-out "extras"
 * (optional photos staff took at book-out — e.g. pre-existing chips,
 * damage close-ups) so they can be retaken or flagged 1:1 at check-in.
 *
 * Legacy compat: book-outs saved before the windscreen split carry a
 * single `'windscreen'` photo. We alias it onto the `windscreen_left`
 * slot — the centre and right slots show "No photo" honestly rather
 * than pretending the legacy single shot covers all three zones.
 */
export function PhotoComparison({
  bookOutPhotos,
  bookOutPhotoLabels,
  currentPhotos,
  damageFlaggedAngles,
  onCapture,
  onRemove,
  onFlagDamage,
}: PhotoComparisonProps) {
  const [activeAngle, setActiveAngle] = useState<CaptureAngle | null>(null)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  /**
   * Angle currently being compressed after the camera returned a file.
   * Without visible feedback during the multi-second compression, users
   * assume the photo "didn't take" and retake it.
   */
  const [processingAngle, setProcessingAngle] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const capturedMap = new Map(currentPhotos.map(p => [p.angle, p]))

  /**
   * Resolve a book-out photo URL for a required-angle slot, with the
   * legacy windscreen shim: if `windscreen_left` is missing but the
   * legacy `'windscreen'` key exists, surface the legacy photo on the
   * Driver Side card only.
   */
  const resolveRequiredBookOutUrl = (angle: PhotoAngle): string | undefined => {
    const direct = bookOutPhotos.get(angle)
    if (direct) return direct
    if (angle === 'windscreen_left') return bookOutPhotos.get(LEGACY_WINDSCREEN_ANGLE)
    return undefined
  }

  /**
   * Book-out extras = anything in the photo map that isn't (a) a current
   * required angle and isn't (b) the legacy windscreen key already
   * aliased into the `windscreen_left` slot. Sorted by angle so the
   * order is stable across renders (extras carry timestamp-based slugs
   * like `extra_1715512345678`).
   */
  const requiredAngleSet = new Set(REQUIRED_PHOTOS.map(r => r.angle as string))
  const legacyWindscreenAliased =
    bookOutPhotos.has(LEGACY_WINDSCREEN_ANGLE) && !bookOutPhotos.has('windscreen_left')
  const extraAngles = Array.from(bookOutPhotos.keys())
    .filter(angle => {
      if (requiredAngleSet.has(angle)) return false
      if (angle === LEGACY_WINDSCREEN_ANGLE && legacyWindscreenAliased) return false
      return true
    })
    .sort()

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
        // Prefer the explicit required-angle label, otherwise the book-out
        // label from the event's photoMeta, otherwise the angle slug.
        const requiredLabel = REQUIRED_PHOTOS.find(r => r.angle === activeAngle)?.label
        const extraLabel = bookOutPhotoLabels?.get(String(activeAngle))
        const label = requiredLabel || extraLabel || String(activeAngle)

        onCapture({
          angle: activeAngle,
          label,
          blobUrl,
          blob: compressed,
          timestamp: Date.now(),
          pdfBase64,
        })
      } catch (err) {
        console.error('[PhotoComparison] Failed to process photo:', err)
      } finally {
        setProcessingAngle(null)
      }

      if (fileInputRef.current) fileInputRef.current.value = ''
    },
    [activeAngle, onCapture, bookOutPhotoLabels],
  )

  const triggerCapture = (angle: CaptureAngle) => {
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

      {/* Progress — required-angle counter only; extras + damage are optional */}
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-700">Condition Photos</p>
        <span className={`text-xs font-medium ${
          capturedCount >= REQUIRED_PHOTOS.length ? 'text-green-600' : 'text-gray-500'
        }`}>
          {capturedCount} / {REQUIRED_PHOTOS.length} retaken (optional)
        </span>
      </div>

      {/* Required-angle comparison grid */}
      {REQUIRED_PHOTOS.map(({ angle, label }) => (
        <ComparisonCard
          key={angle}
          angle={angle}
          label={label}
          bookOutUrl={resolveRequiredBookOutUrl(angle)}
          captured={capturedMap.get(angle)}
          processing={processingAngle === angle}
          damageFlagged={damageFlaggedAngles?.has(angle) ?? false}
          onCapture={triggerCapture}
          onRemove={onRemove}
          onFlagDamage={onFlagDamage}
          onLightbox={setLightbox}
          useAuthImageForBookOut
        />
      ))}

      {/* Additional book-out photos — extras taken at book-out, plus
          legacy `'damage'` / `'other'` buckets for older data. Same card
          shape so retake + flag damage feel familiar. */}
      {extraAngles.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 px-3 py-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-amber-800">
            Additional Book-Out Photos ({extraAngles.length})
          </p>
          <p className="mb-3 text-[11px] text-amber-700/80">
            Optional shots from book-out (e.g. pre-existing chips). Retake or flag damage as needed.
          </p>
          <div className="space-y-3">
            {extraAngles.map((angle, idx) => {
              const persistedLabel = bookOutPhotoLabels?.get(angle)
              const fallback = `Extra ${idx + 1}`
              const label =
                persistedLabel && persistedLabel.trim() !== '' && persistedLabel !== `Extra Photo ${idx + 1}`
                  ? persistedLabel
                  : fallback
              const bookOutUrl = bookOutPhotos.get(angle)
              return (
                <ComparisonCard
                  key={angle}
                  angle={angle as CaptureAngle}
                  label={label}
                  bookOutUrl={bookOutUrl}
                  captured={capturedMap.get(angle as CaptureAngle)}
                  processing={processingAngle === angle}
                  damageFlagged={damageFlaggedAngles?.has(angle) ?? false}
                  onCapture={triggerCapture}
                  onRemove={onRemove}
                  onFlagDamage={onFlagDamage}
                  onLightbox={setLightbox}
                  useAuthImageForBookOut
                />
              )
            })}
          </div>
        </div>
      )}

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

/* ──────────────────────────────────────────────
 * Per-angle comparison card
 * ────────────────────────────────────────────── */

interface ComparisonCardProps {
  angle: CaptureAngle
  label: string
  bookOutUrl: string | undefined
  captured: CapturedPhoto | undefined
  /** True while the freshly-captured file for this angle is compressing */
  processing?: boolean
  damageFlagged: boolean
  onCapture: (angle: CaptureAngle) => void
  onRemove: (angle: string) => void
  onFlagDamage: (angle: string) => void
  onLightbox: (state: { src: string; alt: string }) => void
  useAuthImageForBookOut: boolean
}

function ComparisonCard({
  angle,
  label,
  bookOutUrl,
  captured,
  processing,
  damageFlagged,
  onCapture,
  onRemove,
  onFlagDamage,
  onLightbox,
  useAuthImageForBookOut,
}: ComparisonCardProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Angle header */}
      <div className="flex items-center justify-between gap-2 bg-gray-50 px-3 py-1.5">
        <span className="truncate text-xs font-semibold text-gray-700">{label}</span>
        {captured && (
          <button
            onClick={() => onFlagDamage(String(angle))}
            className={
              damageFlagged
                ? 'shrink-0 rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 active:bg-amber-100'
                : 'shrink-0 rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-600 active:bg-red-100'
            }
            title={damageFlagged ? 'Edit the damage you flagged from this photo' : 'Flag damage on this photo'}
          >
            {damageFlagged ? '✓ Edit Damage' : 'Flag Damage'}
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
              onClick={() => onLightbox({ src: bookOutUrl, alt: `Book-out ${label}` })}
            >
              {useAuthImageForBookOut ? (
                <AuthImage
                  src={bookOutUrl}
                  alt={`Book-out ${label}`}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              ) : (
                <img
                  src={bookOutUrl}
                  alt={`Book-out ${label}`}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              )}
            </div>
          ) : (
            <div className="flex aspect-[4/3] items-center justify-center rounded border border-dashed border-gray-200 bg-gray-50">
              <span className="text-[10px] text-gray-300">No book-out photo</span>
            </div>
          )}
        </div>

        {/* Current photo (right) — capture slot */}
        <div className="bg-white p-1.5">
          <p className="mb-1 text-center text-[10px] font-medium text-ooosh-navy uppercase tracking-wide">Now</p>
          {processing ? (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-1 rounded border-2 border-ooosh-navy/40 bg-ooosh-navy/5">
              <svg className="h-5 w-5 animate-spin text-ooosh-navy" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span className="text-[10px] font-medium text-ooosh-navy">Processing…</span>
            </div>
          ) : captured ? (
            <div className="group relative aspect-[4/3] overflow-hidden rounded border-2 border-green-300">
              <img
                src={captured.blobUrl}
                alt={`Check-in ${label}`}
                className="h-full w-full cursor-pointer object-cover"
                onClick={() => onLightbox({ src: captured.blobUrl, alt: `Check-in ${label}` })}
              />
              {/* The Retake/Remove overlay covers the whole image even when
                  invisible (opacity-0 still captures pointer events), which
                  swallowed taps meant for the lightbox — the img onClick
                  above never fired. Clicking the overlay itself now opens
                  the lightbox; the buttons stopPropagation. */}
              <div
                className="absolute inset-0 flex cursor-pointer items-center justify-center gap-2 bg-black/0 opacity-0 transition-all group-active:bg-black/40 group-active:opacity-100"
                onClick={() => onLightbox({ src: captured.blobUrl, alt: `Check-in ${label}` })}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); onCapture(angle) }}
                  className="rounded bg-white/90 px-2.5 py-1 text-xs font-medium text-gray-700"
                >
                  Retake
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(String(angle)) }}
                  className="rounded bg-white/90 px-2.5 py-1 text-xs font-medium text-red-600"
                >
                  Remove
                </button>
              </div>
              <div className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-green-500">
                <svg className="h-3 w-3 text-white" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
              </div>
            </div>
          ) : (
            <button
              onClick={() => onCapture(angle)}
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
}
