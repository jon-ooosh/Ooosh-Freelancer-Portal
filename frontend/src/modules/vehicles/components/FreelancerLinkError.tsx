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
}: {
  message: string
  returnUrl?: string | null
  startUrl?: string | null
  code?: string
  action?: 'book-out' | 'check-in'
}) {
  // On failure the URL is kept intact (token + returnUrl still present), so a
  // reload re-attempts the exchange — useful for a transient backend blip.
  const retry = () => window.location.reload()
  const params = new URLSearchParams(window.location.search)
  const portalUrl = returnUrl || params.get('returnUrl')
  const wizardUrl = startUrl || params.get('startUrl')
  // Lead with the wizard when retrying is pointless. Older portal builds don't
  // send startUrl, so fall back to the existing buttons rather than stranding.
  const wrongLeg = !!wizardUrl && WRONG_LEG_CODES.includes(code || '')

  return (
    <div className="mx-auto max-w-md space-y-5 px-4 py-8">
      <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-6 text-center">
        <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100">
          <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-amber-900">
          {wrongLeg
            ? "Looks like there's no van on this job"
            : "We couldn't link your van automatically"}
        </h2>
        <p className="mt-2 text-sm text-amber-800">{message}</p>
        <p className="mt-3 text-xs text-amber-700">
          {wrongLeg ? (
            <>
              Don&apos;t worry — nothing is lost. Go back, pick what you&apos;re really{' '}
              {action === 'check-in' ? 'collecting' : 'delivering'}, and carry on. Call the
              office if you&apos;re not sure.
            </>
          ) : (
            <>
              Don&apos;t worry — you can still{' '}
              {action === 'check-in' ? 'check the van in' : 'take the van out'}. Give the
              office a call and we&apos;ll sort it while you&apos;re on the phone.
            </>
          )}
        </p>
      </div>

      <div className="space-y-3">
        {wrongLeg && (
          <a
            href={wizardUrl!}
            className="block w-full rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white"
          >
            Change what I&apos;m {action === 'check-in' ? 'collecting' : 'delivering'}
          </a>
        )}
        <button
          onClick={retry}
          className={
            wrongLeg
              ? 'w-full rounded-lg border border-gray-300 bg-white py-3 text-center font-semibold text-gray-700'
              : 'w-full rounded-lg bg-ooosh-navy py-3 text-center font-semibold text-white'
          }
        >
          Try again
        </button>
        {portalUrl && (
          <a
            href={portalUrl}
            className="block w-full rounded-lg border border-gray-300 bg-white py-3 text-center font-semibold text-gray-700"
          >
            Back to the portal
          </a>
        )}
      </div>

      <div className="rounded-lg bg-gray-50 p-4 text-center text-sm text-gray-600">
        <p className="font-medium text-gray-700">Call the office</p>
        <a href={`tel:${OFFICE_PHONE.replace(/[^\d+]/g, '')}`} className="mt-1 block text-base font-semibold text-ooosh-navy">
          {OFFICE_PHONE}
        </a>
        <a href={`mailto:${OFFICE_EMAIL}`} className="mt-1 block text-xs text-gray-500">
          {OFFICE_EMAIL}
        </a>
      </div>
    </div>
  )
}
