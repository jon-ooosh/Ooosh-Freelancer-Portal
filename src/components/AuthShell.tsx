/**
 * The frame shared by the signed-out pages (register, forgotten password, reset
 * password) so they read like the login page (Oct 2026 refresh, design 1a):
 * logo, title, an optional line under it, one white card, a footer link.
 */

import Image from 'next/image'
import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'

export function AuthShell({ title, subtitle, children, footer }: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="min-h-screen bg-hf-page flex flex-col safe-top safe-bottom">
      <div className="flex-1 w-full max-w-md mx-auto flex flex-col px-5 pt-16 pb-7 gap-7">
        <div className="flex flex-col items-center gap-4 pt-6 text-center">
          <Image src="/ooosh-tours-logo-small.png" alt="Ooosh Tours" width={64} height={64} className="object-contain" priority />
          <div className="flex flex-col items-center gap-1.5">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] text-hf-ink">{title}</h1>
            {subtitle && <p className="text-[15px] text-hf-muted">{subtitle}</p>}
          </div>
        </div>
        <div className="bg-white border border-hf-border rounded-[18px] p-5 flex flex-col gap-4">
          {children}
        </div>
        <div className="flex-1" />
        {footer && <div className="text-center text-[15px] text-hf-muted">{footer}</div>}
      </div>
    </div>
  )
}

/** "Check your email" / "Link expired": a round tick or cross, a heading, words, an action. */
export function AuthResult({ tone, title, children, action }: {
  tone: 'success' | 'error'
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="text-center flex flex-col items-center gap-3 py-2">
      <div className={`w-12 h-12 rounded-full flex items-center justify-center ${tone === 'success' ? 'bg-hf-green-tint text-hf-green-text' : 'bg-red-50 text-hf-error'}`}>
        {tone === 'success' ? <Check size={24} strokeWidth={2.2} /> : <X size={24} strokeWidth={2.2} />}
      </div>
      <h2 className="text-[18px] font-semibold text-hf-ink">{title}</h2>
      <div className="text-[15px] text-hf-body leading-[1.5] flex flex-col gap-2">{children}</div>
      {action && <div className="w-full mt-2">{action}</div>}
    </div>
  )
}

/** Input height used on the signed-out pages (design 1a: 52px, 17px text). */
export const authInput = 'h-[52px] !text-[17px]'
export const authLabel = 'text-[14px] font-semibold text-hf-body'

/**
 * "Remember this phone for 90 days" (two-step sign-in, FREELANCER-PORTAL-SPEC §7).
 * Ticked by default and always shown, never assumed (jon, Oct 2026): on the
 * login code step, the last step of sign-up and the reset form. A remembered
 * phone skips the emailed code; the password is still needed.
 */
export function RememberPhone({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <span aria-hidden className={`mt-px flex-none w-[26px] h-[26px] rounded-lg flex items-center justify-center peer-focus-visible:ring-4 peer-focus-visible:ring-hf-tint ${
        checked ? 'bg-hf-accent text-white' : 'bg-white border-2 border-hf-control'}`}>
        {checked && <Check size={16} strokeWidth={3} />}
      </span>
      <span className="flex flex-col gap-0.5">
        <span className="text-[15px] font-semibold text-hf-ink">Remember this phone for 90 days</span>
        <span className="text-[13px] leading-[1.4] text-hf-muted">Skips the emailed sign-in code on this phone. Untick it on a shared or borrowed phone.</span>
      </span>
    </label>
  )
}
