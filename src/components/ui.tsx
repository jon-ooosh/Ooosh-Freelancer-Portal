/**
 * The portal's shared look (Oct 2026 refresh, docs/design/freelancer-portal-refresh/).
 * Small on purpose: class strings for the buttons and inputs, and the handful of
 * pieces every page repeats. Colours are the `hf` / `kind` tokens in
 * tailwind.config.js. Never below 12px; money is tabular.
 */

import Link from 'next/link'
import type { ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// ── Class strings ────────────────────────────────────────────────────────────

const btnBase =
  'inline-flex items-center justify-center gap-2 font-semibold transition-colors disabled:cursor-not-allowed select-none'

export const cls = {
  /** White card, 1px warm border, r16. No shadow. */
  card: 'bg-white border border-hf-border rounded-2xl',
  /** Primary action: plum. 54px tall at full width. */
  btnPrimary: `${btnBase} h-[54px] rounded-[14px] bg-hf-accent text-white text-[17px] hover:bg-hf-accent-pressed active:bg-hf-accent-pressed disabled:bg-hf-disabled`,
  /** Confirm / finish: green (Complete delivery, Yes I can do it...). */
  btnGreen: `${btnBase} h-[54px] rounded-[14px] bg-hf-green text-white text-[17px] hover:brightness-95 disabled:bg-hf-disabled`,
  /** Dark: lock-up actions. */
  btnDark: `${btnBase} h-[54px] rounded-[14px] bg-hf-ink text-white text-[17px] hover:bg-black disabled:bg-hf-disabled`,
  /** Secondary: white with a control border. */
  btnSecondary: `${btnBase} h-[50px] rounded-xl bg-white border-[1.5px] border-hf-control text-hf-body text-[16px] hover:bg-hf-inset disabled:opacity-50`,
  /** In-card full-width action (Start delivery, Lock up), 52px. Add a colour. */
  btnInCard: `${btnBase} w-full h-[52px] rounded-xl text-white text-[16px]`,
  /** Text inputs and textareas. */
  input:
    'w-full rounded-xl border-[1.5px] border-hf-control bg-white px-3.5 py-3 text-[16px] text-hf-ink placeholder:text-hf-placeholder outline-none transition focus:border-hf-accent focus:ring-4 focus:ring-hf-tint',
  label: 'block text-[15px] font-semibold text-hf-body mb-2',
  /** Section label: 13 / 700 / uppercase / 0.07em / muted. */
  sectionLabel: 'text-[13px] font-bold uppercase tracking-[0.07em] text-hf-muted',
  /** Kind label above a title: 12 / 700 / uppercase / 0.06em, coloured by kind. */
  kindLabel: 'text-[12px] font-bold uppercase tracking-[0.06em]',
  pageTitle: 'text-[28px] font-bold tracking-[-0.02em] leading-[1.15] text-hf-ink',
  money: 'tabular text-[16px] font-semibold text-hf-ink',
  link: 'text-hf-link hover:text-hf-link-hover font-semibold',
}

// ── Job kinds ────────────────────────────────────────────────────────────────

export type Kind = 'backline' | 'van' | 'crew' | 'studio' | 'yard'

export const KIND_TILE: Record<Kind, string> = {
  backline: 'bg-kind-backline-bg text-kind-backline',
  van: 'bg-kind-van-bg text-kind-van',
  crew: 'bg-kind-crew-bg text-kind-crew',
  studio: 'bg-kind-studio-bg text-kind-studio',
  yard: 'bg-kind-yard-bg text-kind-yard',
}

export const KIND_TEXT: Record<Kind, string> = {
  backline: 'text-kind-backline',
  van: 'text-kind-van',
  crew: 'text-kind-crew',
  studio: 'text-kind-studio',
  yard: 'text-kind-yard',
}

/** 40×40 (or 44) rounded tile holding a 20px stroke icon. Replaces the old emoji. */
export function IconTile({ kind, children, size = 40 }: { kind: Kind | 'neutral'; children: ReactNode; size?: 40 | 44 }) {
  const tone = kind === 'neutral' ? 'bg-hf-track text-hf-body' : KIND_TILE[kind]
  const dims = size === 44 ? 'w-11 h-11 rounded-xl' : 'w-10 h-10 rounded-[11px]'
  return <div className={`${dims} ${tone} flex-none flex items-center justify-center`}>{children}</div>
}

/** Icon props the design uses: 20px, 1.8 stroke, round. */
export const ICON = { size: 20, strokeWidth: 1.8 } as const

// ── Layout pieces ────────────────────────────────────────────────────────────

/** "‹ Jobs" back link at the top of a page. */
export function BackLink({ href, label, onClick }: { href?: string; label: string; onClick?: () => void }) {
  const inner = (
    <>
      <ChevronLeft size={20} strokeWidth={2.2} />
      {label}
    </>
  )
  const c = 'inline-flex items-center gap-1 h-11 -ml-1.5 px-1.5 text-hf-link hover:text-hf-link-hover text-[16px] font-semibold'
  if (onClick) return <button type="button" onClick={onClick} className={c}>{inner}</button>
  return <Link href={href || '/dashboard'} className={c}>{inner}</Link>
}

/** The grey chevron that says "this whole row opens". */
export function Chevron({ className = '' }: { className?: string }) {
  return <ChevronRight size={18} strokeWidth={2} className={`text-hf-chevron flex-none ${className}`} />
}

/** Section heading with an optional count bubble. */
export function SectionLabel({ children, count, tone = 'muted' }: { children: ReactNode; count?: number; tone?: 'muted' | 'amber' }) {
  return (
    <div className="flex items-center gap-2 px-1">
      <span className={`${cls.sectionLabel} ${tone === 'amber' ? '!text-hf-amber-text' : ''}`}>{children}</span>
      {count != null && (
        <span className="text-[12px] font-bold bg-hf-tint text-hf-tint-text rounded-full px-2 py-0.5 tabular">{count}</span>
      )}
    </div>
  )
}

/** Info / warning / success / error banner. r14, no side stripe. */
export function Banner({ tone = 'info', children, className = '' }: { tone?: 'info' | 'warning' | 'success' | 'error'; children: ReactNode; className?: string }) {
  const t = {
    info: 'bg-hf-tint text-hf-tint-strong',
    warning: 'bg-hf-amber-bg border border-hf-amber-border text-hf-amber-text',
    success: 'bg-hf-green-tint text-hf-green-text',
    error: 'bg-red-50 border border-red-200 text-hf-error',
  }[tone]
  return <div className={`rounded-[14px] px-4 py-3 text-[15px] leading-[1.45] ${t} ${className}`}>{children}</div>
}

/** Two-option segmented control (By date | By type). */
export function Segmented<T extends string>({ options, value, onChange, className = '' }: {
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`bg-hf-seg rounded-xl p-1 grid gap-1 ${className}`} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }} role="tablist">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={`h-[38px] rounded-[9px] text-[15px] transition-colors ${on ? 'bg-white font-semibold text-hf-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]' : 'font-medium text-hf-muted'}`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** Small rounded status chip. */
export function Chip({ tone = 'neutral', children }: { tone?: 'neutral' | 'green' | 'amber' | 'plum' | 'red' | 'dark'; children: ReactNode }) {
  const t = {
    neutral: 'bg-hf-track text-hf-body',
    green: 'bg-hf-green-tint text-hf-green-text',
    amber: 'bg-hf-amber-bg text-hf-amber-text',
    plum: 'bg-hf-tint text-hf-tint-text',
    red: 'bg-red-50 text-hf-error',
    dark: 'bg-hf-ink text-white',
  }[tone]
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-px text-[12px] font-semibold ${t}`}>{children}</span>
}

/** Centred spinner for whole-page loading. */
export function PageSpinner({ label = 'Loading...' }: { label?: string }) {
  return (
    <div className="min-h-screen bg-hf-page flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 border-[3px] border-hf-tint border-t-hf-accent rounded-full animate-spin mx-auto mb-3" />
        <p className="text-hf-muted text-[15px]">{label}</p>
      </div>
    </div>
  )
}
