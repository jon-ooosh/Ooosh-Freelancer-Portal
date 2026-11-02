/**
 * FreelancerLinkError
 *
 * Friendly fallback shown when a freelancer's book-out / check-in token fails
 * to resolve against an assignment (bad/expired token, not on the crew, no van
 * allocated, hire form not received, etc.). Replaces the old dead-end where the
 * freelancer landed on a blank page or the staff login screen (Lewis, HH 15933,
 * 2 Jul — bounced off the handoff twice with nowhere to go).
 *
 * Never a hard error page: shows the specific reason, a "try again", a way back
 * to the portal, and the office number so the freelancer can always get moving.
 *
 * When the reason is "there's no van for this leg" (`no_out_vehicle` /
 * `no_allocation`), the useful action isn't "try again" — reloading won't
 * conjure a van. It's going back to the /start wizard to re-pick what they're
 * actually delivering. That ALSO rewrites the job's leg declaration: HH 16448
 * (12 Sep) was a backline collection started as "Both", and because the only
 * route out of this page led to /complete, requires_van_leg stayed true and the
 * quote couldn't auto-close for three days.
 */

import { safeReturnUrl, portalJobUrl } from '../lib/safe-url'
import { Phone, TriangleAlert } from 'lucide-react'
import { fl } from './freelancer/ui'

const OFFICE_PHONE = '+44 (0) 1273 911382'
const OFFICE_EMAIL = 'info@oooshtours.co.uk'

/** Failures a reload can never fix — they picked the wrong leg, or no van exists. */
const WRONG_LEG_CODES = ['no_out_vehicle', 'no_allocation']

export function FreelancerLinkError({
  message,
  returnUrl,
  startUrl,
  code,
  action = 'book-out',
  staffLoginHref,
}: {
  message: string
  returnUrl?: string | null
  startUrl?: string | null
  code?: string
  action?: 'book-out' | 'check-in'
  /**
   * Only on the "no session" screen, which is also what a logged-out STAFF
   * member now sees on the bare book-out / check-in URL (App.tsx) — a
   * freelancer must never be sent to the staff login (HH 16714).
   */
  staffLoginHref?: string
}) {
  // On failure the URL is kept intact (token + returnUrl still present), so a
  // reload re-attempts the exchange — useful for a transient backend blip.
  const retry = () => window.location.reload()
  const params = new URLSearchParams(window.location.search)
  // Never trusted as-is — each becomes a link (lib/safe-url.ts).
  // "Back to the portal" means the job page, never the completion screen.
  const portalUrl = portalJobUrl(returnUrl || params.get('returnUrl'))
  const wizardUrl = safeReturnUrl(startUrl || params.get('startUrl'))
  // Lead with the wizard when retrying is pointless. Older portal builds don't
  // send startUrl, so fall back to the existing buttons rather than stranding.
  const wrongLeg = !!wizardUrl && WRONG_LEG_CODES.includes(code || '')

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-5 px-4 py-10">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-hf-amber-tile text-hf-amber-text">
          <TriangleAlert size={34} strokeWidth={2.2} />
        </div>
        <h1 className={fl.pageTitle}>
          {wrongLeg
            ? "Looks like there's no van on this job"
            : "We couldn't link your van automatically"}
        </h1>
        <p className="text-[16px] leading-[1.5] text-hf-body">{message}</p>
        <p className="text-[15px] leading-[1.5] text-hf-muted">
          {wrongLeg ? (
            <>
              Don&apos;t worry, nothing is lost. Go back, pick what you&apos;re really{' '}
              {action === 'check-in' ? 'collecting' : 'delivering'}, and carry on. Call the
              office if you&apos;re not sure.
            </>
          ) : (
            <>
              Don&apos;t worry, you can still{' '}
              {action === 'check-in' ? 'check the van in' : 'take the van out'}. Give the
              office a call and we&apos;ll sort it while you&apos;re on the phone.
            </>
          )}
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        {wrongLeg && (
          <a href={wizardUrl!} className={`${fl.btnPrimary} w-full`}>
            Change what I&apos;m {action === 'check-in' ? 'collecting' : 'delivering'}
          </a>
        )}
        <button
          type="button"
          onClick={retry}
          className={`${wrongLeg ? fl.btnSecondary : fl.btnPrimary} w-full`}
        >
          Try again
        </button>
        {portalUrl && (
          <a href={portalUrl} className={`${fl.btnSecondary} w-full`}>
            Back to the portal
          </a>
        )}
      </div>

      <div className={`${fl.card} flex flex-col items-center gap-1 p-4 text-center`}>
        <p className="text-[14px] font-semibold text-hf-body">Call the office</p>
        <a href={`tel:${OFFICE_PHONE.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-2 text-[20px] font-bold text-hf-link">
          <Phone size={18} strokeWidth={2.2} />
          {OFFICE_PHONE}
        </a>
        <a href={`mailto:${OFFICE_EMAIL}`} className="text-[14px] text-hf-muted">
          {OFFICE_EMAIL}
        </a>
      </div>

      {staffLoginHref && (
        <p className="text-center text-[13px] text-hf-muted">
          Ooosh staff?{' '}
          <a href={staffLoginHref} className="underline">
            Log in to OP
          </a>
        </p>
      )}
    </div>
  )
}
