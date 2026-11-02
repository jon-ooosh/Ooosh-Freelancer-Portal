'use client'

/**
 * The "View all" lists behind the dashboard's Completed and Cancelled rows
 * (Oct 2026: both links used to lead to pages that didn't exist).
 *
 * Completed is every kind of finished work in one list (FREELANCER-PORTAL-SPEC
 * §10): deliveries and collections, crew, studio nights and yard days, newest
 * first under month headings. Cancelled is jobs only. Both go back to the 1st
 * of last month (lib/history.ts), and "Show older" on Completed goes to six
 * months. Until Oct 2026 Completed only knew about jobs, so a sitter's nights
 * vanished from the portal 14 days after them.
 *
 * The dashboard's counts read the same window, so its numbers match these lists.
 */

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { ReactNode } from 'react'
import BottomNav from '@/components/BottomNav'
import { cls, BackLink, Banner, Chevron, SectionLabel } from '@/components/ui'
import type { PortalDayBooking, SitterShift } from '@/lib/op-api'
import { historyStart, historyStartOlder } from '@/lib/history'
import { shortUkDate, ukToday } from '@/lib/ukDate'
import { formatFee, shiftEnvelope, yardFee, yardHours } from '@/lib/work-labels'

interface HistoryJob {
  id: string
  board?: 'dc' | 'crew'
  type?: 'delivery' | 'collection'
  date?: string
  venueName?: string
  name?: string
  driverPay?: number
  freelancerFee?: number
  completedAtDate?: string
  workType?: string
}

type Item = (HistoryJob & { isGrouped: false }) | { isGrouped: true; jobs: HistoryJob[] }

/** One row: a job (or one stop of a run), a studio night or a yard day. */
type Entry =
  | { kind: 'job'; date: string; job: HistoryJob }
  | { kind: 'shift'; date: string; shift: SitterShift }
  | { kind: 'yard'; date: string; day: PortalDayBooking }

const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function formatDate(dateStr?: string): string {
  return dateStr ? shortUkDate(dateStr.slice(0, 10)) : ''
}

/** "September", or "December 2025" when it isn't this year. */
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  const name = MONTHS_LONG[(m || 1) - 1] || ym
  return String(y) === ukToday().slice(0, 4) ? name : `${name} ${y}`
}

function title(job: HistoryJob): string {
  const kind = job.board === 'crew'
    ? (job.workType || 'Crew')
    : job.type === 'collection' ? 'Collection' : 'Delivery'
  const place = job.venueName || job.name || ''
  return place ? `${kind} - ${place}` : kind
}

const entryKey = (e: Entry) =>
  e.kind === 'job' ? `j-${e.job.id}` : e.kind === 'shift' ? `s-${e.shift.date}` : `y-${e.day.id}`

/** A list row. With `href` the whole row opens and carries a chevron; without, it is just a record. */
function Row({ href, rowTitle, sub, fee }: { href?: string; rowTitle: string; sub: string; fee?: string | null }) {
  const inner = (
    <>
      <span className="min-w-0">
        <span className="block truncate text-[16px] font-semibold text-hf-ink">{rowTitle}</span>
        <span className="block text-[14px] text-hf-muted">{sub}</span>
      </span>
      <span className="flex items-center gap-1.5 shrink-0">
        {fee ? <span className={cls.money}>{fee}</span> : null}
        {/* The spacer keeps the fees in line with the rows that have a chevron. */}
        {href ? <Chevron /> : <span className="w-[18px]" aria-hidden />}
      </span>
    </>
  )
  const c = 'flex items-center justify-between gap-3 px-4 py-3.5'
  return href
    ? <Link href={href} className={`${c} hover:bg-hf-inset`}>{inner}</Link>
    : <div className={c}>{inner}</div>
}

function EntryRow({ entry, which }: { entry: Entry; which: 'completed' | 'cancelled' }): ReactNode {
  if (entry.kind === 'shift') {
    const s = entry.shift
    return (
      <Row href={`/shift/${s.date}`} rowTitle="Studio sitter"
        sub={`${formatDate(s.date)} · ${shiftEnvelope(s)}${s.report_submitted_at ? ' · Locked up' : ''}`}
        fee={formatFee(s.fee)} />
    )
  }
  if (entry.kind === 'yard') {
    const d = entry.day
    return <Row rowTitle="Ooosh yard day" sub={`${formatDate(d.date)} · ${yardHours(d)}`} fee={yardFee(d)} />
  }
  const job = entry.job
  const fee = job.freelancerFee ?? job.driverPay
  return (
    <Row href={job.board === 'crew' ? `/job/${job.id}?board=crew` : `/job/${job.id}`} rowTitle={title(job)}
      sub={`${formatDate(job.date)}${which === 'completed' && job.completedAtDate ? ` · completed ${formatDate(job.completedAtDate)}` : ''}`}
      fee={fee ? `£${Math.round(fee)}` : null} />
  )
}

export default function JobHistoryList({ which }: { which: 'completed' | 'cancelled' }) {
  const router = useRouter()
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Nights or yard days that would not load: said so, never shown as "nothing there".
  const [partError, setPartError] = useState(false)
  const [showOlder, setShowOlder] = useState(false)

  useEffect(() => {
    // Completed reads six months once and shows the default window until
    // "Show older" is pressed; Cancelled only ever needs the default.
    const since = which === 'completed' ? historyStartOlder() : historyStart()

    async function loadJobs(): Promise<Entry[]> {
      const res = await fetch(`/api/jobs?since=${since}`)
      const data = await res.json()
      if (!res.ok) {
        if (res.status === 401) { router.push('/login'); return [] }
        throw new Error(data.error || 'Failed to load jobs')
      }
      const items: Item[] = data[which] || []
      // A multi-drop run is one row per stop here: each stop is its own job page.
      return items
        .flatMap((it) => (it.isGrouped ? it.jobs : [it]))
        .map((job) => ({ kind: 'job' as const, date: (job.date || '').slice(0, 10), job }))
    }

    async function loadShifts(): Promise<Entry[]> {
      const res = await fetch(`/api/studio-sitter/shifts?since=${since}`)
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error('shifts')
      return ((data.past || []) as SitterShift[]).map((shift) => ({ kind: 'shift' as const, date: shift.date, shift }))
    }

    async function loadYardDays(): Promise<Entry[]> {
      const res = await fetch(`/api/day-bookings?since=${since}`)
      const data = await res.json()
      if (!res.ok || !data.success) throw new Error('yard days')
      return ((data.done || []) as PortalDayBooking[]).map((day) => ({ kind: 'yard' as const, date: day.date, day }))
    }

    async function load() {
      const [jobs, shifts, yard] = await Promise.allSettled(
        which === 'completed' ? [loadJobs(), loadShifts(), loadYardDays()] : [loadJobs()],
      )
      if (jobs.status === 'rejected') {
        setError(jobs.reason instanceof Error ? jobs.reason.message : 'Failed to load jobs')
      }
      setPartError(shifts?.status === 'rejected' || yard?.status === 'rejected')
      const all = [jobs, shifts, yard]
        .flatMap((r) => (r && r.status === 'fulfilled' ? r.value : []))
        .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)) // OP dates every finished row; a stray one has no month
      // Newest first. The sort is stable, so one day's jobs keep OP's order.
      all.sort((a, b) => b.date.localeCompare(a.date))
      setEntries(all)
      setLoading(false)
    }
    load()
  }, [router, which])

  const start = historyStart()
  const shown = showOlder ? entries : entries.filter((e) => e.date >= start)
  const olderCount = entries.length - entries.filter((e) => e.date >= start).length

  // Month by month, newest first (the entries are already in that order).
  const months: { ym: string; rows: Entry[] }[] = []
  for (const e of shown) {
    const ym = e.date.slice(0, 7)
    const last = months[months.length - 1]
    if (last && last.ym === ym) last.rows.push(e)
    else months.push({ ym, rows: [e] })
  }

  const heading = which === 'completed' ? 'Completed' : 'Cancelled jobs'
  const span = showOlder ? 'The last 6 months' : 'This month and last'
  const empty = which === 'completed'
    ? (showOlder ? 'Nothing completed in the last 6 months.' : 'Nothing completed this month or last.')
    : 'No cancelled jobs this month or last.'

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      <header className="max-w-lg mx-auto px-5 pt-3 flex flex-col gap-1">
        <BackLink href="/dashboard" label="Jobs" />
        <h1 className={cls.pageTitle}>{heading}</h1>
        <p className="text-[16px] text-hf-muted">{span}</p>
      </header>

      <main className="max-w-lg mx-auto px-4 pt-4 flex flex-col gap-5">
        {error && <Banner tone="error">{error}</Banner>}
        {partError && (
          <Banner tone="warning">Your studio nights or yard days could not be loaded just now. Please try again in a moment.</Banner>
        )}
        {loading ? (
          <div className={`${cls.card} p-4 animate-pulse flex flex-col gap-3`}>
            <div className="h-4 bg-hf-track rounded w-2/3" />
            <div className="h-4 bg-hf-track rounded w-1/2" />
          </div>
        ) : months.length === 0 ? (
          // A failed load says so above; it never reads as "nothing there".
          !error && !partError && <div className={`${cls.card} p-6 text-center text-[15px] text-hf-muted`}>{empty}</div>
        ) : (
          months.map(({ ym, rows }) => (
            <section key={ym} className="flex flex-col gap-2.5">
              <SectionLabel count={rows.length}>{monthLabel(ym)}</SectionLabel>
              <ul className={`${cls.card} overflow-hidden`}>
                {rows.map((entry, i) => (
                  <li key={entryKey(entry)}>
                    {i > 0 && <div className="h-px bg-hf-divider ml-4" />}
                    <EntryRow entry={entry} which={which} />
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
        {!loading && which === 'completed' && !showOlder && olderCount > 0 && (
          <button type="button" onClick={() => setShowOlder(true)} className={`${cls.btnSecondary} w-full`}>
            Show the last 6 months
          </button>
        )}
      </main>
      <BottomNav active="jobs" />
    </div>
  )
}
