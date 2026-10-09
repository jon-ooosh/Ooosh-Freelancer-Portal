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
    <div className="mx-auto max-w-md space-y-4 px-4 py-8">
      <div className="text-center">
        <h1 className="text-xl font-bold text-gray-900">
          Which van are you {isCheckin ? 'collecting' : 'taking'}?
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          This job has {candidates.length} vans. Check the number plate on the van in front of
          you and tap it below.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}

      <div className="space-y-3">
        {ordered.map(c => {
          const done = c.alreadyDoneAt ? formatDoneAt(c.alreadyDoneAt) : null
          const isBusy = busyAssignmentId === c.assignmentId
          return (
            <button
              key={c.assignmentId}
              onClick={() => onSelect(c)}
              disabled={busy}
              className={`w-full rounded-xl border-2 p-4 text-left transition-colors disabled:cursor-not-allowed ${
                done
                  ? 'border-amber-200 bg-amber-50/60'
                  : 'border-gray-200 bg-white active:border-ooosh-navy active:bg-gray-50'
              } ${busy && !isBusy ? 'opacity-40' : ''}`}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-2xl font-bold tracking-wide text-gray-900">
                    {c.registration || 'Unknown reg'}
                  </p>
                  <p className="mt-0.5 truncate text-sm text-gray-600">
                    {[c.makeModel, c.vehicleType].filter(Boolean).join(' — ') || 'Vehicle details unavailable'}
                  </p>
                  {c.customerDriverName && (
                    <p className="mt-1 truncate text-xs text-gray-500">Hirer: {c.customerDriverName}</p>
                  )}
                </div>
                {isBusy ? (
                  <div className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-ooosh-navy border-t-transparent" />
                ) : (
                  <svg className="h-5 w-5 shrink-0 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                )}
              </div>
              {done && (
                <p className="mt-2 rounded bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">
                  {doneVerb} at {done} — only pick this one if you&apos;re sure
                </p>
              )}
            </button>
          )
        })}
      </div>

      <p className="text-center text-xs text-gray-500">
        Not sure? Call the office on{' '}
        <a href="tel:+441273911382" className="font-medium text-ooosh-navy">
          01273 911382
        </a>{' '}
        before you start.
      </p>
    </div>
  )
}
