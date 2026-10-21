/**
 * "Is this the van in front of you?" (design 3a), the first thing a freelancer
 * sees on a book-out or a collection.
 *
 * "No, call the office" dials the office (jon, Oct 2026: they're on a phone,
 * mobile first). "‹ Portal" at the top still goes back to the job page, never
 * the completion screen (lib/safe-url.ts portalJobUrl). Saying yes is the only
 * way forward, as before; nothing here writes anything.
 */

import type { ReactNode } from 'react'
import { ChevronLeft, Phone } from 'lucide-react'
import { fl, NumberPlate, OFFICE_PHONE_TEL } from './ui'

export function VanConfirm({ kindLabel, reg, title, sub, backHref, onYes, yesDisabled, yesLabel = "Yes, that's the van", children }: {
  /** "Van delivery · Fontaines D.C." */
  kindLabel: string
  reg: string
  /** "Ford Transit Custom" */
  title?: string | null
  /** "Auto gearbox · 9 seats" */
  sub?: string | null
  /** The portal job page; null hides the link. */
  backHref: string | null
  onYes: () => void
  yesDisabled?: boolean
  yesLabel?: string
  /** Anything the step still needs (e.g. a name the session didn't carry). */
  children?: ReactNode
}) {
  return (
    <div className="mx-auto flex max-w-lg flex-col gap-[18px] px-4 pt-3 pb-10">
      <div className="h-11">
        {backHref && (
          <a href={backHref} className={`inline-flex h-11 items-center gap-1 text-[16px] ${fl.link} -ml-1.5 px-1.5`}>
            <ChevronLeft size={20} strokeWidth={2.2} />
            Portal
          </a>
        )}
      </div>
      <div className="flex flex-col gap-1.5 px-1">
        <div className={`${fl.kindLabel} text-kind-van`}>{kindLabel}</div>
        <h1 className={fl.pageTitle}>Is this the van in front of you?</h1>
      </div>
      <div className={`${fl.card} flex flex-col items-center gap-3.5 !rounded-[18px] px-5 py-[22px] text-center`}>
        <NumberPlate reg={reg} />
        {(title || sub) && (
          <div className="flex flex-col items-center gap-0.5">
            {title && <div className="text-[17px] font-semibold">{title}</div>}
            {sub && <div className="text-[15px] text-hf-muted">{sub}</div>}
          </div>
        )}
      </div>
      {children}
      <div className="flex flex-col gap-2.5">
        <button type="button" onClick={onYes} disabled={yesDisabled} className={`${fl.btnPrimary} !h-14`}>
          {yesLabel}
        </button>
        <a href={OFFICE_PHONE_TEL} className={fl.btnSecondary}>
          <Phone size={18} strokeWidth={2} />
          No, call the office
        </a>
      </div>
    </div>
  )
}

/** "Auto gearbox · 9 seats" from a fleet record, or null when we know neither. */
export function vanSubLine(v: { gearbox?: 'auto' | 'manual' | null; seats?: number | null } | null | undefined): string | null {
  if (!v) return null
  const parts = [
    v.gearbox === 'auto' ? 'Auto gearbox' : v.gearbox === 'manual' ? 'Manual gearbox' : null,
    v.seats ? `${v.seats} seats` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}
