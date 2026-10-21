'use client'

/**
 * Delivery/Collection Start Page
 *
 * Quick wizard that asks "What are you delivering/collecting today?"
 * and routes the driver to the right flow.
 *
 * Picking a van option here declares requires_van_leg=true on the quote BEFORE
 * the redirect, and that declaration is what the server waits on before it can
 * close the job. So a mis-pick on a backline job doesn't just show an error —
 * it leaves the quote unclosable (HH 16448, 12 Sep: three days open, closed by
 * hand in the end). Hence the steer below when the job is booked as backline.
 *
 * Routes:
 * - People (only on a job booked as People in OP) → short completion
 *   (/job/[id]/complete?mode=people: notes, optional photo; Oct 2026)
 * - Van only → vehicle book-out (vehicle management app)
 * - Backline only → equipment checklist (/job/[id]/complete)
 * - Both → vehicle book-out first, then returns to /job/[id]/complete
 *
 * If the job has no HireHop reference, skips straight to /job/[id]/complete.
 *
 * Route: /job/[id]/start
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { AlertTriangle, Speaker, Truck, Users, Shapes } from 'lucide-react'
import { cls, IconTile, BackLink, Banner, PageSpinner, ICON } from '@/components/ui'

// =============================================================================
// TYPES
// =============================================================================

interface JobSummary {
  id: string
  name: string
  type: 'delivery' | 'collection'
  hhRef?: string
  venueName?: string
  date?: string
  time?: string
  // What the job is booked as in OP. Used to order the options below — a
  // backline job shouldn't lead with the van. Often null, so only ever a
  // steer, never a gate.
  whatIsIt?: 'equipment' | 'vehicle' | 'people'
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

export default function StartDeliveryPage() {
  const params = useParams()
  const router = useRouter()
  const jobId = params.id as string

  const [job, setJob] = useState<JobSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [bookoutLoading, setBookoutLoading] = useState(false)
  const [bookoutError, setBookoutError] = useState<string | null>(null)

  // Fetch job summary
  useEffect(() => {
    async function fetchJob() {
      try {
        const res = await fetch(`/api/jobs/${jobId}`)
        const data = await res.json()

        if (!res.ok) {
          if (res.status === 401) {
            router.push('/login')
            return
          }
          throw new Error(data.error || 'Failed to fetch job')
        }

        const fetchedJob = data.job as JobSummary

        // If no HireHop reference, skip wizard and go straight to completion
        if (!fetchedJob?.hhRef) {
          router.replace(`/job/${jobId}/complete`)
          return
        }

        setJob(fetchedJob)
      } catch (err) {
        console.error('Error fetching job:', err)
        setError(err instanceof Error ? err.message : 'Failed to load job')
      } finally {
        setLoading(false)
      }
    }

    if (jobId) {
      fetchJob()
    }
  }, [jobId, router])

  // Declare which legs this job involves so OP can close the quote server-side
  // when the last required leg lands (no cross-domain return hop needed).
  // Best-effort: never block the freelancer starting if this call fails — the
  // legacy return-hop flow still works, we just lose the server-close safety net.
  const declareLegs = async (van: boolean, equipment: boolean) => {
    try {
      await fetch(`/api/jobs/${jobId}/legs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ van, equipment }),
      })
    } catch (err) {
      console.warn('Declare legs failed (non-blocking):', err)
    }
  }

  // Backline only → equipment leg, no van. Declare then go to the checklist.
  // mode=dc so a People job whose driver picks this gets the full hand-over.
  const handleBacklineOnly = async () => {
    await declareLegs(false, true)
    router.push(`/job/${jobId}/complete?mode=dc`)
  }

  // People → no van leg and no equipment hand-over to wait for: declare neither,
  // so the short completion closes the job on its own.
  const handlePeople = async () => {
    await declareLegs(false, false)
    router.push(`/job/${jobId}/complete?mode=people`)
  }

  // Handle the VAN leg. For a delivery this is a book-out; for a collection
  // it's a check-in / return (the Lewis mis-route fix — collections used to be
  // sent through book-out). vanOnly=true → van only; vanOnly=false → "both"
  // (van leg first, then equipment checklist).
  const handleVanLeg = async (vanOnly: boolean) => {
    setBookoutLoading(true)
    setBookoutError(null)
    try {
      await declareLegs(true, !vanOnly)
      const isCollection = job?.type === 'collection'
      const endpoint = isCollection ? 'checkin-token' : 'bookout-token'
      const res = await fetch(`/api/jobs/${jobId}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vanOnly }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed to start ${isCollection ? 'check-in' : 'book-out'}`)
      }
      window.location.href = isCollection ? data.checkinUrl : data.bookoutUrl
    } catch (err) {
      console.error('Van leg error:', err)
      setBookoutError(err instanceof Error ? err.message : 'Failed to start')
      setBookoutLoading(false)
    }
  }

  if (loading) {
    return <PageSpinner />
  }

  if (error || !job) {
    return (
      <div className="min-h-screen bg-hf-page p-4">
        <div className="max-w-md mx-auto mt-20">
          <div className={`${cls.card} p-6 text-center`}>
            <AlertTriangle size={36} strokeWidth={1.8} className="mx-auto mb-3 text-hf-error" />
            <p className="text-hf-body text-[15px] mb-4">{error || 'Job not found'}</p>
            <Link href="/dashboard" className={`${cls.btnPrimary} w-full`}>
              Back to jobs
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const isDelivery = job.type === 'delivery'
  const verb = isDelivery ? 'delivering' : 'collecting'
  // Booked as backline in OP. Lead with the backline option and say so —
  // picking a van leg here is what left HH 16448 unclosable. A steer only:
  // what_is_it is null on roughly a third of jobs, and a backline job can
  // legitimately involve a hire van, so all three options stay live.
  const expectsBackline = job.whatIsIt === 'equipment'
  // Booked as People (driver + van with passengers). The People option only
  // exists for these jobs, first and marked Expected; the rest stay below.
  const isPeopleJob = job.whatIsIt === 'people'

  // One definition, two positions — top of the list on a backline job,
  // otherwise its usual middle slot.
  const backlineButton = (
    <OptionCard
      onClick={handleBacklineOnly}
      disabled={bookoutLoading}
      expected={expectsBackline}
      tile={<IconTile kind="backline" size={44}><Speaker {...ICON} /></IconTile>}
      title="Backline only"
      sub="Equipment checklist & sign-off"
    />
  )

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-10">
      <header className="max-w-md mx-auto px-2 pt-2">
        <div className="px-2.5">
          <BackLink href={`/job/${jobId}`} label={job.venueName || 'Job'} />
        </div>
      </header>

      <main className="max-w-md mx-auto px-4 pt-2 flex flex-col gap-4">
        <h1 className="px-1 text-[26px] font-bold tracking-[-0.02em] leading-[1.2] text-hf-ink">
          What are you {isDelivery ? 'delivering' : 'collecting'} today?
        </h1>

        {expectsBackline && (
          <Banner tone="info">
            <strong className="font-bold">This job is booked as backline.</strong>{' '}
            Only pick a van option if you&apos;re also {verb} an Ooosh hire van for the
            customer.
          </Banner>
        )}

        {isPeopleJob && (
          <Banner tone="info">
            <strong className="font-bold">This job is booked as People.</strong>{' '}
            Only pick another option if you&apos;re also {verb} a hire van or equipment.
          </Banner>
        )}

        <div className="flex flex-col gap-2.5">
          {/* People — only on a job booked as People */}
          {isPeopleJob && (
            <OptionCard
              onClick={handlePeople}
              disabled={bookoutLoading}
              expected
              tile={<IconTile kind="crew" size={44}><Users {...ICON} /></IconTile>}
              title="People"
              sub="Passengers: a quick note and you're done"
            />
          )}

          {/* Backline only — first when the job is booked as backline */}
          {expectsBackline && backlineButton}

          {/* Van only */}
          <OptionCard
            onClick={() => handleVanLeg(true)}
            disabled={bookoutLoading}
            busy={bookoutLoading}
            tile={<IconTile kind="van" size={44}><Truck {...ICON} /></IconTile>}
            title="Van only"
            sub={isDelivery ? 'Vehicle book-out' : 'Vehicle check-in / return'}
          />

          {/* Backline only — normal position when we can't tell */}
          {!expectsBackline && backlineButton}

          {/* Both */}
          <OptionCard
            onClick={() => handleVanLeg(false)}
            disabled={bookoutLoading}
            busy={bookoutLoading}
            tile={<IconTile kind="neutral" size={44}><Shapes {...ICON} /></IconTile>}
            title="Both"
            sub={isDelivery ? 'Vehicle book-out, then equipment checklist' : 'Vehicle check-in, then equipment checklist'}
          />
        </div>

        {bookoutError && <Banner tone="error" className="text-center">{bookoutError}</Banner>}

        <Link
          href={`/job/${jobId}`}
          className="h-12 flex items-center justify-center text-[16px] font-semibold text-hf-muted hover:text-hf-body transition-colors"
        >
          Cancel
        </Link>
      </main>
    </div>
  )
}

/**
 * One choice on the Start page (design 2b): icon tile, title, one line of
 * what happens next. The option the job is booked as is outlined in plum and
 * marked Expected — a steer, never a gate.
 */
function OptionCard({ onClick, disabled, expected = false, busy = false, tile, title, sub }: {
  onClick: () => void
  disabled?: boolean
  expected?: boolean
  busy?: boolean
  tile: ReactNode
  title: string
  sub: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`w-full min-h-[80px] flex items-center gap-3.5 p-4 rounded-2xl bg-white text-left transition-colors hover:bg-hf-inset disabled:opacity-50 disabled:cursor-not-allowed ${
        expected ? 'border-2 border-hf-accent' : 'border-[1.5px] border-hf-control'
      }`}
    >
      {tile}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[17px] font-semibold text-hf-ink">{title}</span>
          {expected && (
            <span className="text-[12px] font-bold bg-hf-accent text-white rounded-full px-2 py-0.5">Expected</span>
          )}
        </div>
        <div className="text-[14px] text-hf-muted">{sub}</div>
      </div>
      {busy && (
        <div className="w-5 h-5 border-2 border-hf-accent border-t-transparent rounded-full animate-spin flex-none" />
      )}
    </button>
  )
}
