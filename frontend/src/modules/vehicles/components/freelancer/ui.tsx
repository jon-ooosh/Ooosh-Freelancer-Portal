/**
 * The freelancer look for the van screens (FREELANCER-PORTAL-SPEC §11): the
 * portal's design (docs/design/freelancer-portal-refresh/, screens 13-19) in
 * the staff app. Used ONLY inside FreelancerBookoutShell / FreelancerCheckinShell
 * and the freelancer branches of BookOutPage / CollectionPage. Staff screens
 * never import this file, so the staff navy UI cannot change through it.
 *
 * The class strings mirror the portal's src/components/ui.tsx, so a freelancer
 * moving from the portal to the van screens sees one app. Colours are the
 * shared `hf` tokens (shared/design/freelancer-tokens.cjs). Copy is British
 * English with no em dashes.
 */

import '@fontsource-variable/dm-sans/opsz.css'
import type { ReactNode } from 'react'
import { ChevronLeft, LoaderCircle } from 'lucide-react'
import { FUEL_LEVELS } from '../../types/vehicle-event'
import type { FuelLevel } from '../../types/vehicle-event'

const btnBase =
  'inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:cursor-not-allowed select-none'

export const fl = {
  /** White card, 1px warm border, r16. No shadow. */
  card: 'bg-white border border-hf-border rounded-2xl',
  /** Primary action: plum. */
  btnPrimary: `${btnBase} h-[54px] rounded-[14px] bg-hf-accent text-white text-[17px] hover:bg-hf-accent-pressed active:bg-hf-accent-pressed disabled:bg-hf-disabled`,
  /** Confirm / finish: green (Book out van, Van collected). */
  btnGreen: `${btnBase} h-[54px] rounded-[14px] bg-hf-green text-white text-[17px] hover:brightness-95 disabled:bg-hf-disabled`,
  /** Secondary: white with a control border. */
  btnSecondary: `${btnBase} h-[52px] rounded-[14px] bg-white border-[1.5px] border-hf-control text-hf-body text-[16px] hover:bg-hf-inset disabled:opacity-50`,
  input:
    'w-full rounded-xl border-[1.5px] border-hf-control bg-white px-3.5 py-3 text-[16px] text-hf-ink placeholder:text-hf-placeholder outline-none transition focus:border-hf-accent focus:ring-4 focus:ring-hf-tint',
  label: 'block text-[14px] font-semibold text-hf-body',
  pageTitle: 'text-[26px] font-bold tracking-[-0.02em] leading-[1.2] text-hf-ink',
  kindLabel: 'text-[12px] font-bold uppercase tracking-[0.06em]',
  link: 'text-hf-link hover:text-hf-link-hover font-semibold',
}

/**
 * Text shared with the staff screens, shown to a freelancer: no em dashes (the
 * portal's copy rule). "… (48,100 mi) — more than …" → "… (48,100 mi), more than …".
 */
export function noEmDash(text: string): string {
  return text.replace(/\s*—\s*/g, ', ')
}

/** The office, for "call the office" (same number as FreelancerLinkError). */
export const OFFICE_PHONE_DISPLAY = '01273 911382'
export const OFFICE_PHONE_TEL = 'tel:+441273911382'

/** The page every freelancer van screen sits in: DM Sans, warm page colour. */
export function FreelancerTheme({ children }: { children: ReactNode }) {
  return (
    <div data-theme="freelancer" className="min-h-screen bg-hf-page font-freelancer text-hf-ink antialiased">
      {children}
    </div>
  )
}

/** "RX24KHV" → "RX24 KHV": a current UK plate reads as two groups. */
export function plateText(reg: string | null | undefined): string {
  const r = (reg || '').replace(/\s+/g, '').toUpperCase()
  return /^[A-Z]{2}\d{2}[A-Z]{3}$/.test(r) ? `${r.slice(0, 4)} ${r.slice(4)}` : r
}

/** The yellow rear plate, so the freelancer can match it to the van in front of them. */
export function NumberPlate({ reg }: { reg: string }) {
  return (
    <div className="rounded-lg border-2 border-hf-ink bg-[#f7d11e] px-[18px] py-2 text-[30px] font-bold tracking-[0.06em] text-hf-ink tabular-nums">
      {plateText(reg) || '…'}
    </div>
  )
}

/** "‹ Exit · Book out · RX24 KHV · 1 of 4" and the segmented progress bar. */
export function StepHeader({ exitHref, title, step, total }: {
  exitHref: string | null
  title: string
  step: number
  total: number
}) {
  return (
    <header className="sticky top-0 z-10 bg-hf-page px-4 pt-3 pb-1">
      <div className="mx-auto flex max-w-lg flex-col gap-2.5">
        <div className="grid h-11 grid-cols-[auto_1fr_auto] items-center gap-3">
          {exitHref ? (
            <a href={exitHref} className={`inline-flex items-center gap-1 text-[16px] ${fl.link} -ml-1.5 px-1.5 h-11`}>
              <ChevronLeft size={20} strokeWidth={2.2} />
              Exit
            </a>
          ) : <span />}
          <span className="truncate text-center text-[15px] font-semibold">{title}</span>
          <span className="text-[14px] text-hf-muted tabular-nums">{step} of {total}</span>
        </div>
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}>
          {Array.from({ length: total }, (_, i) => (
            <div key={i} className={`h-1 rounded-full ${i < step ? 'bg-hf-accent' : 'bg-hf-control'}`} />
          ))}
        </div>
      </div>
    </header>
  )
}

/** A step's own heading: "Photos" with an optional right-hand note ("6 of 18"). */
export function StepTitle({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 px-1">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className={fl.pageTitle}>{title}</h1>
        {right}
      </div>
      {sub && <p className="text-[15px] text-hf-muted">{sub}</p>}
    </div>
  )
}

/**
 * Back + the step's action, fixed to the foot of the phone (the design's
 * sticky footer). The scroll area above needs `pb-36` so nothing hides under it.
 */
export function StepFooter({ onBack, backDisabled, primary }: {
  onBack: () => void
  backDisabled?: boolean
  primary: { label: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'accent' | 'green'; busy?: boolean }
}) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t border-hf-border bg-white px-4 pt-3 pb-[max(20px,env(safe-area-inset-bottom))]">
      <div className="mx-auto grid max-w-lg grid-cols-[1fr_2fr] gap-2.5">
        <button type="button" onClick={onBack} disabled={backDisabled} className={`${fl.btnSecondary} !h-[54px]`}>
          Back
        </button>
        <button
          type="button"
          onClick={primary.onClick}
          disabled={primary.disabled}
          className={primary.tone === 'green' ? fl.btnGreen : fl.btnPrimary}
        >
          {primary.busy && <LoaderCircle size={18} className="animate-spin" />}
          {primary.label}
        </button>
      </div>
    </div>
  )
}

/** Info / warning / success / error banner. r14, no side stripe. */
export function Banner({ tone = 'info', title, children, className = '' }: {
  tone?: 'info' | 'warning' | 'success' | 'error'
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const t = {
    info: 'bg-hf-tint text-hf-tint-strong',
    warning: 'bg-hf-amber-bg border border-hf-amber-border text-hf-amber-text',
    success: 'bg-hf-green-tint text-hf-green-text',
    error: 'bg-[#fbeeea] border border-[#ecbcae] text-hf-error',
  }[tone]
  return (
    <div className={`flex flex-col gap-0.5 rounded-[14px] px-4 py-3 text-[15px] leading-[1.45] ${t} ${className}`}>
      {title && <span className="font-bold">{title}</span>}
      {children && <span>{children}</span>}
    </div>
  )
}

/** One card of "label ... value" rows with inset dividers (Check & sign). */
export function SummaryRows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <div className={fl.card}>
      {rows.map(([label, value], i) => (
        <div key={label}>
          {i > 0 && <div className="mx-4 h-px bg-hf-divider" />}
          <div className="flex min-h-12 items-center justify-between gap-4 px-4 py-2.5">
            <span className="text-[15px] text-hf-muted">{label}</span>
            <span className="text-right text-[16px] font-semibold tabular-nums">{value}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Centred spinner with a line of text (loading screens). */
export function CentredSpinner({ text }: { text: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center">
      <LoaderCircle size={36} className="animate-spin text-hf-accent" />
      <p className="text-[15px] text-hf-muted">{text}</p>
    </div>
  )
}

// ── Fuel & mileage (book-out and collection) ─────────────────────────────────

/** The fuel buttons read as the gauge does: E, 1 to 7, F. The stored values are unchanged ('Empty', '1/8' … 'Full'). */
function fuelKey(level: FuelLevel): string {
  return level === 'Empty' ? 'E' : level === 'Full' ? 'F' : level.split('/')[0]
}

/** "6/8", "Empty", "Full". */
export function fuelShort(level: string | null | undefined): string {
  return level || '-'
}

/**
 * Mileage and fuel, as one step. Every rule stays with the page (canAdvance and
 * the messages it passes in); this only draws them. The gauge keeps its colour
 * by level, red when low (jon, Oct 2026), rather than the mock's fixed green.
 */
export function FuelMileageStep({ title, mileage, onMileage, fuel, onFuel, mileageError, mileageWarning, mileageNote, reference, autoFocus }: {
  title: string
  mileage: string
  onMileage: (value: string) => void
  fuel: FuelLevel | null
  onFuel: (level: FuelLevel) => void
  /** Blocks Next (the page decides): shown in red under the box. */
  mileageError?: string | null
  /** A warning only (a big jump): shown in amber. */
  mileageWarning?: string | null
  /** e.g. "Last recorded: 48,100 mi" */
  mileageNote?: string | null
  /** Collection: what it went out with. */
  reference?: ReactNode
  /** Book-out puts the cursor in the mileage box, as it always has. */
  autoFocus?: boolean
}) {
  const idx = fuel ? FUEL_LEVELS.indexOf(fuel) : -1
  const pct = idx >= 0 ? (idx / (FUEL_LEVELS.length - 1)) * 100 : 0
  const gauge = idx <= 2 ? '#a2341f' : idx <= 4 ? '#c48a1f' : '#3f9b6b'
  return (
    <div className="flex flex-col gap-4">
      <StepTitle title={title} />
      {reference}
      <div className={`${fl.card} flex flex-col gap-1.5 p-4`}>
        <label htmlFor="fl-mileage" className={fl.label}>Mileage</label>
        <div className={`flex h-[60px] items-center gap-2 rounded-xl border-[1.5px] bg-white px-3.5 transition focus-within:ring-4 ${
          mileageError ? 'border-hf-error focus-within:ring-[#fbeeea]' : 'border-hf-control focus-within:border-hf-accent focus-within:ring-hf-tint'
        }`}>
          <input
            id="fl-mileage"
            type="number"
            inputMode="numeric"
            value={mileage}
            onChange={e => onMileage(e.target.value)}
            placeholder="0"
            autoFocus={autoFocus}
            className="min-w-0 flex-1 bg-transparent text-[26px] font-semibold tracking-[0.02em] tabular-nums text-hf-ink outline-none placeholder:text-hf-placeholder [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="text-[16px] font-medium text-hf-muted">mi</span>
        </div>
        <p className="text-[14px] text-hf-muted">Read it off the dashboard display{mileageNote ? `. ${mileageNote}` : ''}</p>
        {mileageError && <p className="text-[14px] font-medium text-hf-error">{mileageError}</p>}
        {mileageWarning && <p className="text-[14px] font-medium text-hf-amber-text">{mileageWarning}</p>}
      </div>
      <div className={`${fl.card} flex flex-col gap-3 p-4`}>
        <div className="flex items-baseline justify-between">
          <span className={fl.label}>Fuel</span>
          <span className="text-[20px] font-bold tabular-nums">{fuel ?? ''}</span>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-hf-track">
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, backgroundColor: gauge }} />
        </div>
        <div className="grid grid-cols-9 gap-1">
          {FUEL_LEVELS.map(level => {
            const on = fuel === level
            return (
              <button
                key={level}
                type="button"
                onClick={() => onFuel(level)}
                aria-label={level}
                aria-pressed={on}
                className={`h-11 rounded-[9px] text-[13px] font-semibold transition-colors ${
                  on ? 'bg-hf-ink font-bold text-white' : 'border-[1.5px] border-hf-control bg-white text-hf-ink'
                }`}
              >
                {fuelKey(level)}
              </button>
            )
          })}
        </div>
        <p className="text-[14px] text-hf-muted">Eighths, as on the gauge</p>
      </div>
    </div>
  )
}
