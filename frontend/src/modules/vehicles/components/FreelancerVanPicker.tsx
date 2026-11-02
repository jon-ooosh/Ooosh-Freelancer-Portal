/**
 * FreelancerVanPicker
 *
 * "Which van are you standing in front of?" — shown when a job has more than
 * one van out (collection) or allocated (delivery).
 *
 * Before this, both resolvers answered "THE van on this job" with a LIMIT 1, so
 * every freelancer on the job got the same one. HH 15307, 8 Sep: Charlie
 * collected RX24SZG from Press Play at 09:53; fifteen minutes later Lewis
 * opened his collection at Lordship Lane, was shown RX24SZG — Charlie's van —
 * and had no way to change it, so DE21FBF never got collected on the system.
 *
 * The list is one card per REGISTRATION, not per assignment row: a single van
 * routinely has several live rows on a job (HH 15307 carried three for
 * RX24SZG) and the freelancer is reading a number plate, not a database.
 *
 * A van whose leg is already done is badged and sorted to the bottom, but
 * stays selectable — warnings, not gates. Someone occasionally has to redo one.
 */

import type { FreelancerVanCandidate } from '../adapters/freelancer-session'
import { ChevronRight, LoaderCircle } from 'lucide-react'
import { Banner, fl, plateText, OFFICE_PHONE_DISPLAY, OFFICE_PHONE_TEL } from './freelancer/ui'

function formatDoneAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const today = new Date()
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate()
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  return sameDay ? time : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, ${time}`
}

export function FreelancerVanPicker({
  candidates,
  action,
  busyAssignmentId,
  error,
  onSelect,
}: {
  candidates: FreelancerVanCandidate[]
  action: 'book-out' | 'check-in'
  /** Assignment currently being claimed — disables the list while in flight */
  busyAssignmentId?: string | null
  error?: string | null
  onSelect: (candidate: FreelancerVanCandidate) => void
}) {
  const isCheckin = action === 'check-in'
  const doneVerb = isCheckin ? 'Already collected' : 'Already booked out'

  // Not-yet-done vans first — the one they want is almost always in that group.
  const ordered = [...candidates].sort((a, b) => {
    const ad = a.alreadyDoneAt ? 1 : 0
    const bd = b.alreadyDoneAt ? 1 : 0
    if (ad !== bd) return ad - bd
    return (a.registration || '').localeCompare(b.registration || '')
  })

  const busy = !!busyAssignmentId

  return (
    <div className="mx-auto flex max-w-lg flex-col gap-4 px-4 py-10">
      <div className="flex flex-col gap-1.5 px-1">
        <div className={`${fl.kindLabel} text-kind-van`}>
          {isCheckin ? 'Van collection' : 'Van delivery'} · {candidates.length} vans
        </div>
        <h1 className={fl.pageTitle}>
          Which van are you {isCheckin ? 'collecting' : 'taking'}?
        </h1>
        <p className="text-[16px] leading-[1.5] text-hf-body">
          Check the number plate on the van in front of you and tap it below.
        </p>
      </div>

      {error && <Banner tone="error">{error}</Banner>}

      <div className="flex flex-col gap-2.5">
        {ordered.map(c => {
          const done = c.alreadyDoneAt ? formatDoneAt(c.alreadyDoneAt) : null
          const isBusy = busyAssignmentId === c.assignmentId
          return (
            <button
              key={c.assignmentId}
              type="button"
              onClick={() => onSelect(c)}
              disabled={busy}
              className={`${fl.card} w-full p-4 text-left transition-colors disabled:cursor-not-allowed ${
                done ? '!border-hf-amber-border !bg-hf-amber-bg' : 'hover:bg-hf-inset'
              } ${busy && !isBusy ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-col items-start gap-2">
                  <span className="rounded-md border-2 border-hf-ink bg-[#f7d11e] px-2.5 py-0.5 text-[20px] font-bold tracking-[0.06em] text-hf-ink">
                    {plateText(c.registration) || 'Unknown reg'}
                  </span>
                  <span className="truncate text-[15px] text-hf-body">
                    {[c.makeModel, c.vehicleType].filter(Boolean).join(' · ') || 'Van details not available'}
                  </span>
                  {c.customerDriverName && (
                    <span className="truncate text-[14px] text-hf-muted">Hirer: {c.customerDriverName}</span>
                  )}
                </div>
                {isBusy ? (
                  <LoaderCircle size={22} className="shrink-0 animate-spin text-hf-accent" />
                ) : (
                  <ChevronRight size={20} strokeWidth={2} className="shrink-0 text-hf-chevron" />
                )}
              </div>
              {done && (
                <p className="mt-3 rounded-lg bg-hf-amber-tile px-2.5 py-1.5 text-[14px] font-medium text-hf-amber-text">
                  {doneVerb} at {done}. Only pick this one if you&apos;re sure.
                </p>
              )}
            </button>
          )
        })}
      </div>

      <p className="px-1 text-center text-[14px] text-hf-muted">
        Not sure? Call the office on{' '}
        <a href={OFFICE_PHONE_TEL} className={fl.link}>
          {OFFICE_PHONE_DISPLAY}
        </a>{' '}
        before you start.
      </p>
    </div>
  )
}
