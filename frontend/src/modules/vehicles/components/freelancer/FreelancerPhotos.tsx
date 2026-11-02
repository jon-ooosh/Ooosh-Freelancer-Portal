/**
 * The walk-around photos for a freelancer (design 3c, jon's calls, Oct 2026).
 *
 * Only the layout is new. PhotoCapture still owns the camera input, the
 * one-pass compression and the memory rules (vehicles-bookout.md "Photos");
 * this draws the 18 angles and calls back into it.
 *
 * - "Next up" is the first angle not yet taken, or the tile they tapped.
 * - "Take photo" opens the camera straight away: the framing guide and its tip
 *   are already in the card, so the full-screen guide (one more tap per photo,
 *   18 per van) isn't used here, and nor is the "Photo guides" switch.
 * - All 18 tiles show, so any photo can be retaken.
 * - Tapping a taken photo offers Retake or Remove (the staff grid's buttons only
 *   appear while a finger is on the photo, which won't do four across).
 */

import { useEffect, useState } from 'react'
import { Camera, Check, LoaderCircle, Plus, RotateCcw, X } from 'lucide-react'
import { REQUIRED_PHOTOS } from '../../types/vehicle-event'
import type { CapturedPhoto, PhotoAngle } from '../../types/vehicle-event'
import { getPhotoGuide, PHOTO_GUIDE_TIPS } from '../photo/PhotoGuides'
import { fl, noEmDash } from './ui'

/** Four across leaves room for a few characters, so the tiles use short names (jon, Oct 2026). */
const SHORT: Record<PhotoAngle, string> = {
  front: 'Front', front_right: 'Front R', passenger_door: 'Pass door', interior_front: 'Int front',
  sliding_door: 'Sliding', interior_rear: 'Int rear', right_panel: 'Right panel', rear_right: 'Rear R',
  rear_doors: 'Rear door S', rear_door_driver: 'Rear door D', rear_left: 'Rear L', left_panel: 'Left panel',
  driver_door: 'Driver door', front_left: 'Front L', windscreen_left: 'Screen D', windscreen_middle: 'Screen C',
  windscreen_right: 'Screen P', dashboard: 'Dashboard',
}

/**
 * "Rear Door — Sliding-Door Side" → "Rear door, sliding-door side". On screen only:
 * the stored label (and so the condition report) keeps REQUIRED_PHOTOS' wording.
 */
export function freelancerPhotoName(label: string): string {
  const s = noEmDash(label)
  return s.charAt(0) + s.slice(1).toLowerCase()
}

type Sheet =
  | { kind: 'required'; angle: PhotoAngle; label: string }
  | { kind: 'extra'; photo: CapturedPhoto }

export function FreelancerPhotos({ photos, processingAngle, onTake, onRemove, onUpdate }: {
  photos: CapturedPhoto[]
  /** The angle PhotoCapture is compressing right now. */
  processingAngle: string | null
  /** Open the camera for this angle (PhotoCapture's own openCamera). */
  onTake: (angle: CapturedPhoto['angle'], label?: string) => void
  onRemove: (angle: string) => void
  /** Book-out lets an extra photo carry a label; collection doesn't pass this. */
  onUpdate?: (angle: string, partial: Partial<Pick<CapturedPhoto, 'label'>>) => void
}) {
  const captured = new Map(photos.map(p => [p.angle, p]))
  const requiredAngles = new Set<string>(REQUIRED_PHOTOS.map(r => r.angle))
  const extras = photos.filter(p => !requiredAngles.has(p.angle))
  const missing = REQUIRED_PHOTOS.filter(r => !captured.has(r.angle))

  // The tile they chose, else the first one still to take.
  const [chosen, setChosen] = useState<PhotoAngle | null>(null)
  const current = (chosen && !captured.has(chosen) ? REQUIRED_PHOTOS.find(r => r.angle === chosen) : null) ?? missing[0] ?? null
  useEffect(() => {
    if (chosen && captured.has(chosen)) setChosen(null)
  }, [chosen, photos]) // eslint-disable-line react-hooks/exhaustive-deps

  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [labelDraft, setLabelDraft] = useState('')
  const busy = !!processingAngle

  const position = current ? REQUIRED_PHOTOS.findIndex(r => r.angle === current.angle) + 1 : 0
  const Guide = current ? getPhotoGuide(current.angle) : null

  return (
    <div className="flex flex-col gap-3.5">
      {current ? (
        <div className="flex flex-col gap-3 rounded-[18px] bg-hf-ink p-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-semibold text-hf-disabled">Next up · {position} of {REQUIRED_PHOTOS.length}</span>
              <span className="text-[19px] font-bold text-white">{freelancerPhotoName(current.label)}</span>
            </div>
            <span className="pt-0.5 text-[13px] font-semibold text-hf-disabled">Walk clockwise</span>
          </div>
          <div className="flex flex-col items-center gap-2 rounded-xl border-[1.5px] border-dashed border-hf-muted px-3 py-3">
            {Guide && <Guide className="h-[120px] w-full max-w-[260px]" />}
            <p className="text-center text-[13px] leading-[1.4] text-hf-disabled">{PHOTO_GUIDE_TIPS[current.angle]}</p>
          </div>
          <button
            type="button"
            onClick={() => onTake(current.angle)}
            disabled={busy}
            className="inline-flex h-[54px] items-center justify-center gap-2 rounded-[14px] bg-white text-[17px] font-semibold text-hf-ink disabled:opacity-70"
          >
            {processingAngle === current.angle
              ? <><LoaderCircle size={20} className="animate-spin" />Saving the photo…</>
              : <><Camera size={20} strokeWidth={2} />Take photo</>}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-[18px] bg-hf-green-tint px-4 py-3.5 text-hf-green-text">
          <Check size={22} strokeWidth={2.6} />
          <span className="text-[16px] font-semibold">All {REQUIRED_PHOTOS.length} photos taken. Tap any one to retake it.</span>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1.5">
        {REQUIRED_PHOTOS.map(({ angle, label }) => {
          const photo = captured.get(angle)
          const isCurrent = current?.angle === angle
          const isBusy = processingAngle === angle
          const base = 'relative aspect-square overflow-hidden rounded-[10px] text-left'
          if (isBusy) {
            return (
              <div key={angle} className={`${base} flex items-center justify-center border-[1.5px] border-hf-accent bg-hf-tint`}>
                <LoaderCircle size={20} className="animate-spin text-hf-accent" />
              </div>
            )
          }
          if (photo) {
            return (
              <button key={angle} type="button" disabled={busy} onClick={() => setSheet({ kind: 'required', angle, label })} className={`${base} bg-hf-toggle-off`} aria-label={`${freelancerPhotoName(label)}, taken`}>
                <img src={photo.blobUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                <span className="absolute right-[5px] top-[5px] flex h-4 w-4 items-center justify-center rounded-full bg-hf-green text-white"><Check size={10} strokeWidth={3.5} /></span>
                <span className="absolute bottom-[5px] left-[5px] rounded bg-[rgba(29,26,28,0.6)] px-1 py-px text-[10px] font-bold leading-tight text-white">{SHORT[angle]}</span>
              </button>
            )
          }
          return (
            <button
              key={angle}
              type="button"
              disabled={busy}
              onClick={() => (isCurrent ? onTake(angle) : setChosen(angle))}
              aria-label={`${freelancerPhotoName(label)}, not taken`}
              className={`${base} flex items-end p-[5px] ${isCurrent ? 'border-[1.5px] border-hf-accent bg-hf-tint' : 'border-[1.5px] border-dashed border-hf-dashed'}`}
            >
              <span className={`text-[12px] font-semibold leading-tight ${isCurrent ? 'text-hf-link' : 'text-hf-muted'}`}>{SHORT[angle]}</span>
            </button>
          )
        })}
        {extras.map((photo, i) => (
          <button key={photo.angle} type="button" disabled={busy} onClick={() => { setLabelDraft(isCustomLabel(photo.label) ? photo.label : ''); setSheet({ kind: 'extra', photo }) }} className="relative aspect-square overflow-hidden rounded-[10px] border-[1.5px] border-hf-amber-border bg-hf-toggle-off text-left">
            <img src={photo.blobUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
            <span className="absolute bottom-[5px] left-[5px] max-w-[calc(100%-10px)] truncate rounded bg-[rgba(29,26,28,0.6)] px-1 py-px text-[10px] font-bold text-white">{isCustomLabel(photo.label) ? photo.label : `Extra ${i + 1}`}</span>
          </button>
        ))}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={() => onTake(`extra_${Date.now()}` as CapturedPhoto['angle'], `Extra Photo ${extras.length + 1}`)}
        className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border-[1.5px] border-hf-control bg-white text-[15px] font-semibold text-hf-body disabled:opacity-60"
      >
        {processingAngle?.startsWith('extra_') ? <><LoaderCircle size={16} className="animate-spin" />Saving the photo…</> : <><Plus size={16} strokeWidth={2.4} />Add an extra photo</>}
      </button>

      {sheet && (
        <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={() => setSheet(null)}>
          <div className="mx-auto w-full max-w-lg rounded-t-[22px] bg-white px-4 pt-4 pb-[max(24px,env(safe-area-inset-bottom))]" onClick={e => e.stopPropagation()}>
            {sheet.kind === 'required' ? (
              <div className="flex flex-col gap-2.5">
                <p className="px-1 text-[17px] font-semibold">{freelancerPhotoName(sheet.label)}</p>
                <button type="button" className={`${fl.btnPrimary} w-full`} onClick={() => { const a = sheet.angle; setSheet(null); onTake(a) }}>
                  <RotateCcw size={18} strokeWidth={2.2} />Retake this photo
                </button>
                <button type="button" className={`${fl.btnSecondary} w-full !text-hf-error`} onClick={() => { onRemove(sheet.angle); setSheet(null) }}>
                  <X size={18} strokeWidth={2.2} />Remove it
                </button>
                <button type="button" className="h-11 text-[15px] font-semibold text-hf-muted" onClick={() => setSheet(null)}>Cancel</button>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <img src={sheet.photo.blobUrl} alt="" className="max-h-48 w-full rounded-xl object-cover" />
                {onUpdate && (
                  <label className="flex flex-col gap-1.5">
                    <span className={fl.label}>What does it show? (optional)</span>
                    <input
                      type="text"
                      maxLength={60}
                      value={labelDraft}
                      onChange={e => setLabelDraft(e.target.value)}
                      placeholder="e.g. Chip on the driver-side windscreen"
                      className={fl.input}
                    />
                  </label>
                )}
                {onUpdate && (
                  <button
                    type="button"
                    className={`${fl.btnPrimary} w-full`}
                    onClick={() => {
                      const next = labelDraft.trim()
                      if (next && next !== sheet.photo.label) onUpdate(sheet.photo.angle, { label: next })
                      setSheet(null)
                    }}
                  >
                    Save
                  </button>
                )}
                <button type="button" className={`${fl.btnSecondary} w-full !text-hf-error`} onClick={() => { onRemove(sheet.photo.angle); setSheet(null) }}>
                  <X size={18} strokeWidth={2.2} />Remove it
                </button>
                <button type="button" className="h-11 text-[15px] font-semibold text-hf-muted" onClick={() => setSheet(null)}>Cancel</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** An extra photo still called "Extra Photo 3" hasn't been given a label. Same test as the staff grid. */
function isCustomLabel(label: string | undefined): label is string {
  return !!label && !/^Extra Photo \d+$/i.test(label) && label.trim() !== ''
}
