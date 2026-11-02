'use client'

/**
 * Jobs: the portal's home (Oct 2026 refresh, design 2a).
 *
 * Two views of the same data, chosen with a toggle and remembered on the phone
 * (`ooosh_portal_jobs_sort`):
 *   - By date (default): Today · Tomorrow · Later (next 30 days), plus Earlier
 *     for a recent shift or yard day.
 *   - By type: Deliveries & collections · Studio shifts · Crew · Ooosh work.
 * In both, yard days still waiting for an answer are pinned on top, and
 * Completed / Cancelled are two rows at the bottom.
 *
 * Whole cards open the job. Only on Today does a job get an in-card action:
 * Start (deliveries, collections, runs) or Lock up (tonight's studio shift).
 * Crew jobs never get Start (unchanged rule).
 */

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  RefreshCw, LogOut, Play, Lock, Speaker, Truck, Users, Mic, Wrench, Route,
  ArrowLeftRight, TrainFront, Check, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { PortalDayBooking, DayBookingsResponse } from '@/lib/op-api'
import FreelancerTaskList from '@/components/FreelancerTaskList'
import BottomNav from '@/components/BottomNav'
import { cls, IconTile, Chevron, SectionLabel, Segmented, Banner, Chip, KIND_TEXT, ICON } from '@/components/ui'
import type { Kind } from '@/components/ui'
import { ukToday, ukDatePlus, ukHour } from '@/lib/ukDate'
import { historyStart } from '@/lib/history'
import { shiftEnvelope, formatFee, yardHours, yardFee } from '@/lib/work-labels'

// =============================================================================
// TYPES (matching API response)
// =============================================================================

interface OrganisedJob {
  id: string
  name: string
  board: 'dc' | 'crew'
  type: 'delivery' | 'collection'
  date: string
  finishDate?: string           // For multi-day crew jobs
  time?: string
  venueName?: string
  venueCity?: string | null
  driverPay?: number
  runGroup?: string
  hhRef?: string
  keyNotes?: string
  completedAtDate?: string
  whatIsIt?: string | null      // 'equipment' | 'vehicle' | 'people' | null
  // Crew job specific fields
  workType?: string             // e.g. "BACKLINE TECH"
  workDurationHours?: number
  numberOfDays?: number
  jobType?: string              // "Transport + Crew" or "Crew Only"
}

interface GroupedRun {
  isGrouped: true
  runGroup: string
  date: string
  jobs: OrganisedJob[]
  totalFee: number
  // When true, totalFee is the agreed combined fee for the run
  // (overrides summing individual per-stop fees).
  hasCombinedFee?: boolean
  standaloneTotalFee?: number
  runNotes?: string | null
  jobCount: number
}

interface SingleJob extends OrganisedJob {
  isGrouped: false
}

type DisplayItem = GroupedRun | SingleJob

interface JobsApiResponse {
  success: boolean
  user?: { id: string; name: string; email: string }
  today?: DisplayItem[]
  upcoming?: DisplayItem[]
  completed?: DisplayItem[]
  cancelled?: DisplayItem[]
  error?: string
}

// Studio sitter shifts (Rehearsals — Phase D portal surface)
interface ShiftJob {
  job_id: string
  hh_job_number: number | null
  label: string
  rooms: string[]
}

interface SitterShift {
  date: string
  planned_start: string | null
  planned_end: string | null
  status: string
  assignment_status: string
  fee: number | null
  report_submitted_at?: string | null
  jobs: ShiftJob[]
}

interface ShiftsApiResponse {
  success: boolean
  shifts?: SitterShift[]
  /** Nights gone by since `historyStart()`: only counted here, listed on Completed. */
  past?: SitterShift[]
  error?: string
}

type SortMode = 'date' | 'type'
const SORT_KEY = 'ooosh_portal_jobs_sort'

// =============================================================================
// FORMATTING
// =============================================================================

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** YYYY-MM-DD (or a longer ISO string) as a UTC date, or null. */
function parseYmd(s: string | undefined | null): Date | null {
  if (!s) return null
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return null
  const date = new Date(Date.UTC(y, m - 1, d))
  return Number.isNaN(date.getTime()) ? null : date
}
const ymdOf = (s: string | undefined | null) => (s ? s.slice(0, 10) : '')

/** "Tue 21 Oct" */
function shortDate(s: string | undefined | null): string {
  const d = parseYmd(s)
  return d ? `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : (s || '')
}
/** "Thursday 23 Oct" */
function longDate(s: string | undefined | null): string {
  const d = parseYmd(s)
  return d ? `${DAYS_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : (s || '')
}
/** "Wed 22" */
function dayAndNumber(s: string | undefined | null): string {
  const d = parseYmd(s)
  return d ? `${DAYS_SHORT[d.getUTCDay()]} ${d.getUTCDate()}` : (s || '')
}

/** "10:00 AM" (job arrival times). */
function formatTime(timeStr: string | undefined | null): string {
  if (!timeStr) return ''
  if (/[AP]M/i.test(timeStr)) return timeStr
  const match = timeStr.match(/(\d{1,2}):(\d{2})/)
  if (!match) return timeStr
  const hours = parseInt(match[1])
  return `${hours % 12 || 12}:${match[2]} ${hours >= 12 ? 'PM' : 'AM'}`
}

/** Strip DEL/COL prefix and get clean venue name */
function venueOf(job: OrganisedJob): string {
  if (job.venueName) return job.venueName
  return job.name.replace(/^(DEL|COL|CREW)\s*[-:]\s*/i, '').trim()
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
}

/** "3 days" / "8 hrs" / '' */
function crewDuration(job: OrganisedJob): string {
  if (job.numberOfDays && job.numberOfDays > 1) return `${job.numberOfDays} days`
  if (job.workDurationHours) return `${job.workDurationHours} hrs`
  return ''
}

// =============================================================================
// WHAT KIND OF JOB IS THIS?
// =============================================================================

/** Kind, label and icon for a single job (design 2a: label from `whatIsIt`). */
function describeJob(job: OrganisedJob): { kind: Kind; label: string; Icon: LucideIcon } {
  if (job.board === 'crew') {
    return { kind: 'crew', label: job.workType ? `Crew · ${titleCase(job.workType)}` : 'Crew', Icon: Users }
  }
  const leg = job.type === 'collection' ? 'collection' : 'delivery'
  if (job.whatIsIt === 'equipment') return { kind: 'backline', label: `Backline ${leg}`, Icon: Speaker }
  if (job.whatIsIt === 'vehicle') return { kind: 'van', label: `Van ${leg}`, Icon: Truck }
  // People: a delivery / collection of passengers (the Start page's People option).
  if (job.whatIsIt === 'people') return { kind: 'van', label: `People ${leg}`, Icon: Users }
  return { kind: 'backline', label: leg === 'delivery' ? 'Delivery' : 'Collection', Icon: Speaker }
}

/** A run's kind: backline unless every stop is a van. */
function describeRun(run: GroupedRun): { kind: Kind; label: string } {
  const allVan = run.jobs.every((j) => j.whatIsIt === 'vehicle')
  const allBackline = run.jobs.every((j) => j.whatIsIt === 'equipment')
  const word = allVan ? 'Van run' : allBackline ? 'Backline run' : 'Run'
  return { kind: allVan ? 'van' : 'backline', label: `${word} · ${run.jobCount} stops` }
}

/**
 * How they get there and back: a rule of thumb from what's being moved, not
 * stored data (design behaviour change 2). Null when we can't say.
 */
function travelOf(job: OrganisedJob): { long: string; short: string; tone: 'neutral' | 'van' } | null {
  if (job.board === 'crew') return null
  if (job.whatIsIt === 'equipment') return { long: 'Driving there & back', short: 'there & back', tone: 'neutral' }
  if (job.whatIsIt === 'vehicle') {
    return job.type === 'collection'
      ? { long: 'Train there · drive back', short: 'train there', tone: 'van' }
      : { long: 'One way · train back', short: 'train back', tone: 'van' }
  }
  return null
}

function TravelChip({ job }: { job: OrganisedJob }) {
  const t = travelOf(job)
  if (!t) return null
  const tone = t.tone === 'van' ? 'bg-kind-van-bg text-kind-van' : 'bg-hf-track text-hf-body'
  const Icon = t.tone === 'van' ? TrainFront : ArrowLeftRight
  return (
    <div className="flex mt-[5px]">
      <span className={`inline-flex items-center gap-1.5 text-[13px] font-semibold rounded-full pl-2 pr-2.5 py-[3px] ${tone}`}>
        <Icon size={14} strokeWidth={2} />
        {t.long}
      </span>
    </div>
  )
}

// =============================================================================
// SMALL PIECES
// =============================================================================

function Fee({ amount, strike }: { amount?: number | null; strike?: number | null }) {
  if (!amount || amount <= 0) return null
  return (
    <div className="text-right">
      <div className={cls.money}>{formatFee(amount)}</div>
      {strike && strike !== amount ? (
        <div className="tabular text-[13px] text-hf-muted line-through">{formatFee(strike)}</div>
      ) : null}
    </div>
  )
}

function DayGroup({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2 px-1">
        <span className="text-[17px] font-bold text-hf-ink">{title}</span>
        {sub && <span className="text-[15px] text-hf-muted">{sub}</span>}
      </div>
      {children}
    </section>
  )
}

/** One card per item: header that opens the job, then an optional in-card action. */
function BigCard({ href, kind, Icon, label, badge, title, meta, chip, fee, action, children }: {
  href: string
  kind: Kind
  Icon: LucideIcon
  label: string
  badge?: ReactNode
  title: string
  meta?: string
  chip?: ReactNode
  fee?: ReactNode
  action?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={`${cls.card} overflow-hidden`}>
      <Link href={href} className="p-4 flex gap-3 items-start hover:bg-hf-inset/60 transition-colors">
        <IconTile kind={kind}><Icon {...ICON} /></IconTile>
        <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
          <div className="flex items-center gap-2">
            <span className={`${cls.kindLabel} ${KIND_TEXT[kind]}`}>{label}</span>
            {badge}
          </div>
          <div className="text-[17px] font-semibold leading-[1.3] text-hf-ink line-clamp-2">{title}</div>
          {meta && <div className="text-[14px] text-hf-muted">{meta}</div>}
          {chip}
        </div>
        <div className="flex items-center gap-1.5">
          {fee}
          <Chevron />
        </div>
      </Link>
      {children && <div className="px-4 pb-4 -mt-1">{children}</div>}
      {action && <div className="px-4 pb-4">{action}</div>}
    </div>
  )
}

/** A compact row inside a grouped "Later" / "Earlier" card. */
function DateRow({ href, ymd, kind, label, title, meta, fee }: {
  href?: string
  ymd: string
  kind: Kind
  label: string
  title: string
  meta?: ReactNode
  fee?: ReactNode
}) {
  const d = parseYmd(ymd)
  const inner = (
    <>
      <div className="w-11 flex-none flex flex-col items-center leading-[1.1]">
        <span className="text-[12px] font-bold uppercase text-hf-muted">{d ? DAYS_SHORT[d.getUTCDay()] : ''}</span>
        <span className="text-[20px] font-bold text-hf-ink tabular">{d ? d.getUTCDate() : ''}</span>
      </div>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className={`${cls.kindLabel} ${KIND_TEXT[kind]}`}>{label}</div>
        <div className="text-[16px] font-semibold text-hf-ink truncate">{title}</div>
        {meta && <div className="text-[14px] text-hf-muted">{meta}</div>}
      </div>
      {fee}
      {href && <Chevron />}
    </>
  )
  const c = 'px-4 py-3.5 flex gap-3 items-center'
  return href
    ? <Link href={href} className={`${c} hover:bg-hf-inset/60 transition-colors`}>{inner}</Link>
    : <div className={c}>{inner}</div>
}

/** A row inside a "By type" group. */
function TypeRow({ href, kind, Icon, title, meta }: { href?: string; kind: Kind; Icon: LucideIcon; title: string; meta?: ReactNode }) {
  const inner = (
    <>
      <IconTile kind={kind}><Icon {...ICON} /></IconTile>
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="text-[16px] font-semibold text-hf-ink">{title}</div>
        {meta && <div className="text-[14px] text-hf-muted">{meta}</div>}
      </div>
    </>
  )
  const c = 'px-4 py-3.5 flex gap-3 items-center'
  return href
    ? <Link href={href} className={`${c} hover:bg-hf-inset/60 transition-colors`}>{inner}</Link>
    : <div className={c}>{inner}</div>
}

/** Rows in one card, with dividers inset to where the text starts. */
function Grouped({ inset = 72, children }: { inset?: number; children: ReactNode[] }) {
  const rows = children.filter(Boolean)
  return (
    <div className={`${cls.card} overflow-hidden flex flex-col`}>
      {rows.map((row, i) => (
        <div key={i}>
          {i > 0 && <div className="h-px bg-hf-divider" style={{ marginLeft: inset }} />}
          {row}
        </div>
      ))}
    </div>
  )
}

function EmptyCard({ children }: { children: ReactNode }) {
  return <div className={`${cls.card} px-4 py-5 text-center text-[15px] text-hf-muted`}>{children}</div>
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-2.5">
      {[1, 2].map((i) => (
        <div key={i} className={`${cls.card} p-4 animate-pulse flex gap-3`}>
          <div className="w-10 h-10 bg-hf-track rounded-[11px]" />
          <div className="flex-1">
            <div className="h-3 bg-hf-track rounded w-1/3 mb-2" />
            <div className="h-4 bg-hf-track rounded w-3/4 mb-2" />
            <div className="h-3 bg-hf-track rounded w-1/2" />
          </div>
        </div>
      ))}
    </div>
  )
}

// =============================================================================
// YARD DAYS
// =============================================================================

/**
 * An offered yard day still to come: the only thing on this screen that needs
 * them to do something, so it is pinned on top (spec §9.3). Read-only plus
 * accept / decline: no counter-offer (that happens in the WhatsApp group).
 */
function YardOfferCard({ day, busy, onAnswer }: {
  day: PortalDayBooking
  busy: boolean
  onAnswer: (response: 'accepted' | 'declined') => void
}) {
  const fee = yardFee(day)
  return (
    <div className="bg-white border-[1.5px] border-hf-amber-border rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex gap-3 items-start">
        <IconTile kind="yard"><Wrench {...ICON} /></IconTile>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className={`${cls.kindLabel} text-hf-body`}>Ooosh yard day</div>
          <div className="text-[16px] font-semibold text-hf-ink">{longDate(day.date)} · {yardHours(day)}</div>
        </div>
        {fee && <div className={cls.money}>{fee}</div>}
      </div>
      {day.notes && <p className="text-[15px] text-hf-body leading-[1.45]">{day.notes}</p>}
      {/* The live list of what they'd be doing (STAFF-CALENDAR-SPEC §21). */}
      {day.tasks && day.tasks.length > 0 && <FreelancerTaskList tasks={day.tasks} />}
      <div className="grid grid-cols-2 gap-2.5">
        <button type="button" disabled={busy} onClick={() => onAnswer('accepted')}
          className={`${cls.btnGreen} !h-[50px] !rounded-xl !text-[16px]`}>
          {busy ? 'Sending...' : 'Yes, I can do it'}
        </button>
        <button type="button" disabled={busy} onClick={() => onAnswer('declined')}
          className={cls.btnSecondary}>
          {busy ? '...' : "Sorry, I can't"}
        </button>
      </div>
    </div>
  )
}

/**
 * An accepted yard day (or one that has passed). No buttons: pulling out is a
 * phone call on purpose, and staff record it as `withdrew`.
 */
function YardDayCard({ day, isPast }: { day: PortalDayBooking; isPast: boolean }) {
  const fee = yardFee(day)
  const status = day.status === 'offered'
    ? 'That day has passed and we never heard back - get in touch if that is wrong'
    : isPast
      ? (day.invoiceReceived ? 'Done - we have your invoice' : 'Done - send us your invoice when you can')
      : 'Confirmed - we have you down for this one'
  return (
    <div className={`${cls.card} p-4 flex flex-col gap-2 ${isPast ? 'opacity-80' : ''}`}>
      <div className="flex gap-3 items-start">
        <IconTile kind="yard"><Wrench {...ICON} /></IconTile>
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          <div className={`${cls.kindLabel} text-hf-body`}>Ooosh yard day</div>
          <div className="text-[16px] font-semibold text-hf-ink">{longDate(day.date)} · {yardHours(day)}</div>
          <div className={`text-[14px] ${!isPast && day.status !== 'offered' ? 'text-hf-green-text font-medium' : 'text-hf-muted'}`}>{status}</div>
        </div>
        {fee && <div className={cls.money}>{fee}</div>}
      </div>
      {day.notes && <p className="text-[15px] text-hf-body leading-[1.45]">{day.notes}</p>}
      {!isPast && day.tasks && day.tasks.length > 0 && <FreelancerTaskList tasks={day.tasks} />}
    </div>
  )
}

// =============================================================================
// CARDS FOR JOBS AND SHIFTS
// =============================================================================

function jobHref(job: OrganisedJob): string {
  return job.board === 'crew' ? `/job/${job.id}?board=crew` : `/job/${job.id}`
}

/** "10:00 AM · Islington", or for crew "9:00 AM · 3 days · Transport + Crew". */
function jobMeta(job: OrganisedJob): string {
  const parts: string[] = []
  if (job.board === 'crew') {
    if (job.time) parts.push(formatTime(job.time))
    const dur = crewDuration(job)
    if (dur) parts.push(dur)
    if (job.jobType) parts.push(job.jobType)
    return parts.filter(Boolean).join(' · ')
  }
  if (job.time) parts.push(formatTime(job.time))
  if (job.venueCity) parts.push(job.venueCity)
  return parts.join(' · ')
}

/** Today / Tomorrow card for one job or run. `withAction` only on Today. */
function ItemCard({ item, withAction }: { item: DisplayItem; withAction: boolean }) {
  if (item.isGrouped) {
    const first = item.jobs[0]
    const { kind, label } = describeRun(item)
    const done = item.jobs.every((j) => j.completedAtDate)
    const more = item.jobCount - 1
    const travel = first ? travelOf(first) : null
    return (
      <BigCard
        href={`/job/${first?.id}?run=${item.runGroup}`}
        kind={kind}
        Icon={Route}
        label={label}
        title={first ? `${venueOf(first)}${more > 0 ? ` + ${more} more` : ''}` : 'Multi-drop run'}
        meta={[first?.time ? formatTime(first.time) : '', travel ? travel.short : ''].filter(Boolean).join(' · ') || undefined}
        chip={done ? <div className="flex mt-1"><Chip tone="green"><Check size={12} strokeWidth={3} />Done</Chip></div> : undefined}
        fee={<Fee amount={item.totalFee} strike={item.hasCombinedFee ? item.standaloneTotalFee : null} />}
        action={withAction && !done && first ? (
          <Link href={`/job/${first.id}/start`} className={`${cls.btnInCard} bg-hf-accent hover:bg-hf-accent-pressed`}>
            <Play size={16} fill="currentColor" strokeWidth={0} />Start run
          </Link>
        ) : undefined}
      />
    )
  }

  const { kind, label, Icon } = describeJob(item)
  const done = !!item.completedAtDate
  const isCrew = item.board === 'crew'
  const leg = item.type === 'collection' ? 'collection' : 'delivery'
  const crewDates = isCrew && item.finishDate && ymdOf(item.finishDate) !== ymdOf(item.date)
    ? `to ${shortDate(item.finishDate)}` : ''
  return (
    <BigCard
      href={jobHref(item)}
      kind={kind}
      Icon={Icon}
      label={label}
      title={venueOf(item)}
      meta={[crewDates, jobMeta(item)].filter(Boolean).join(' · ') || undefined}
      chip={done
        ? <div className="flex mt-1"><Chip tone="green"><Check size={12} strokeWidth={3} />Done</Chip></div>
        : <TravelChip job={item} />}
      fee={<Fee amount={item.driverPay} />}
      action={withAction && !done && !isCrew ? (
        <Link href={`/job/${item.id}/start`} className={`${cls.btnInCard} bg-hf-accent hover:bg-hf-accent-pressed`}>
          <Play size={16} fill="currentColor" strokeWidth={0} />Start {leg}
        </Link>
      ) : undefined}
    />
  )
}

function shiftBands(shift: SitterShift): string {
  return shift.jobs.map((j) => (j.rooms.length ? `${j.label} · ${j.rooms.join(', ')}` : j.label)).join('  ·  ')
}

/** Locked up / Assigned; nothing for a confirmed shift still to come. */
function shiftStatusChip(shift: SitterShift): ReactNode {
  if (shift.report_submitted_at) return <Chip tone="green"><Check size={12} strokeWidth={3} />Locked up</Chip>
  if (shift.assignment_status !== 'confirmed') return <Chip tone="amber">Assigned</Chip>
  return undefined
}

function ShiftCard({ shift, tonight }: { shift: SitterShift; tonight: boolean }) {
  const lockedUp = !!shift.report_submitted_at
  const status = shiftStatusChip(shift)
  return (
    <BigCard
      href={`/shift/${shift.date}`}
      kind="studio"
      Icon={Mic}
      label="Studio sitter"
      badge={tonight ? <span className="text-[11px] font-bold uppercase tracking-[0.05em] bg-hf-ink text-white rounded-md px-1.5 py-0.5">Tonight</span> : undefined}
      title={shiftEnvelope(shift)}
      meta={shift.jobs.length ? shiftBands(shift) : undefined}
      chip={status ? <div className="flex mt-1">{status}</div> : undefined}
      fee={<Fee amount={shift.fee} />}
      action={tonight && !lockedUp ? (
        <Link href={`/shift/${shift.date}/lockup`} className={`${cls.btnInCard} bg-hf-ink hover:bg-black`}>
          <Lock size={18} strokeWidth={2} />Lock up
        </Link>
      ) : undefined}
    />
  )
}

// =============================================================================
// MAIN PAGE
// =============================================================================

type DatedEntry =
  | { sortKey: string; kind: 'job'; item: DisplayItem }
  | { sortKey: string; kind: 'shift'; shift: SitterShift }
  | { sortKey: string; kind: 'yard'; day: PortalDayBooking }

const itemDate = (item: DisplayItem) => ymdOf(item.date)
const itemTime = (item: DisplayItem) => (item.isGrouped ? item.jobs[0]?.time : item.time) || ''
/** How many rows these make on the Completed / Cancelled list, where each stop of a run is its own row. */
const stopCount = (items: DisplayItem[]) => items.reduce((n, i) => n + (i.isGrouped ? i.jobs.length : 1), 0)

function readStoredSort(): SortMode {
  try {
    const v = window.localStorage.getItem(SORT_KEY)
    return v === 'type' ? 'type' : 'date'   // anything unexpected falls back to the default
  } catch {
    return 'date'
  }
}

function greeting(): string {
  const h = ukHour()
  return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'
}

export default function DashboardPage() {
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date())
  const [, setTick] = useState(0)
  const [sort, setSort] = useState<SortMode>('date')

  const [userName, setUserName] = useState<string>('')
  const [todayJobs, setTodayJobs] = useState<DisplayItem[]>([])
  const [upcomingJobs, setUpcomingJobs] = useState<DisplayItem[]>([])
  const [completedJobs, setCompletedJobs] = useState<DisplayItem[]>([])
  const [cancelledJobs, setCancelledJobs] = useState<DisplayItem[]>([])
  // The rest of what the Completed page lists, for its count (lib/history.ts).
  const [pastShiftCount, setPastShiftCount] = useState(0)
  const [yardDoneCount, setYardDoneCount] = useState(0)

  // Studio sitter shifts (only populated for freelancers rostered as sitters)
  const [sitterShifts, setSitterShifts] = useState<SitterShift[]>([])
  const [yardDays, setYardDays] = useState<PortalDayBooking[]>([])
  const [yardBusy, setYardBusy] = useState<string | null>(null)
  const [yardError, setYardError] = useState('')

  // The remembered view, read after mount (no localStorage on the server).
  useEffect(() => { setSort(readStoredSort()) }, [])
  function chooseSort(v: SortMode) {
    setSort(v)
    try { window.localStorage.setItem(SORT_KEY, v) } catch { /* private mode: just don't remember */ }
  }

  // Keep "Updated n mins ago" honest without a reload.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  /**
   * Yard days (spec §9.3). Independent of the jobs fetch: a failure here must
   * never break the jobs dashboard, and the section hides when there's nothing.
   */
  const fetchYardDays = useCallback(async () => {
    try {
      const res = await fetch(`/api/day-bookings?since=${historyStart()}`)
      const data: DayBookingsResponse = await res.json()
      setYardDays(res.ok && data.success ? [...(data.upcoming || []), ...(data.past || [])] : [])
      setYardDoneCount(res.ok && data.success ? (data.done || []).length : 0)
    } catch (err) {
      console.error('Failed to fetch yard days:', err)
      setYardDays([])
      setYardDoneCount(0)
    }
  }, [])

  async function answerYardDay(id: string, response: 'accepted' | 'declined') {
    setYardBusy(id)
    setYardError('')
    try {
      const res = await fetch(`/api/day-bookings/${id}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) {
        // A 409 is a real answer (already accepted, cancelled, passed): show
        // it and re-read rather than leaving a stale card.
        setYardError(data?.error || 'That did not save. Please try again.')
      }
      await fetchYardDays()
    } catch {
      setYardError('That did not save - you may have lost signal.')
    } finally {
      setYardBusy(null)
    }
  }

  /** The sitter's rostered shifts. Independent of the jobs fetch, like yard days. */
  const fetchShifts = useCallback(async () => {
    try {
      const response = await fetch(`/api/studio-sitter/shifts?since=${historyStart()}`)
      const data: ShiftsApiResponse = await response.json()
      setSitterShifts(response.ok && data.success ? (data.shifts || []) : [])
      setPastShiftCount(response.ok && data.success ? (data.past || []).length : 0)
    } catch (err) {
      console.error('Failed to fetch studio shifts:', err)
      setSitterShifts([])
      setPastShiftCount(0)
    }
  }, [])

  const fetchJobs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/jobs?since=${historyStart()}`)
      const data: JobsApiResponse = await response.json()
      if (!response.ok || !data.success) {
        if (response.status === 401) {
          router.push('/login')
          return
        }
        throw new Error(data.error || 'Failed to load jobs')
      }
      if (data.user) setUserName(data.user.name.split(' ')[0] || data.user.name)
      setTodayJobs(data.today || [])
      setUpcomingJobs(data.upcoming || [])
      setCompletedJobs(data.completed || [])
      setCancelledJobs(data.cancelled || [])
      setLastUpdated(new Date())
    } catch (err) {
      console.error('Failed to fetch jobs:', err)
      setError(err instanceof Error ? err.message : 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    fetchJobs()
    fetchShifts()
    fetchYardDays()
  }, [fetchJobs, fetchShifts, fetchYardDays])

  const handleRefresh = () => {
    fetchJobs()
    fetchShifts()
    fetchYardDays()
  }

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await fetch('/api/auth/logout', { method: 'POST' })
      router.push('/login')
    } catch (err) {
      console.error('Logout failed:', err)
      setLoggingOut(false)
    }
  }

  const updatedLabel = (() => {
    const mins = Math.floor((Date.now() - lastUpdated.getTime()) / 60000)
    if (mins < 1) return 'Updated just now'
    if (mins === 1) return 'Updated 1 min ago'
    return `Updated ${mins} mins ago`
  })()

  // ── Sorting the day's work into groups ────────────────────────────────────
  const today = ukToday()
  const tomorrow = ukDatePlus(1)

  const yardPending = yardDays.filter((d) => d.status === 'offered' && d.date >= today)
  const yardUpcoming = yardDays.filter((d) => d.status !== 'offered' && d.date >= today)
  const yardPast = yardDays.filter((d) => d.date < today)

  const tomorrowJobs = upcomingJobs.filter((i) => itemDate(i) === tomorrow)
  const laterJobs = upcomingJobs.filter((i) => itemDate(i) !== tomorrow)

  const shiftsToday = sitterShifts.filter((s) => s.date === today)
  const shiftsTomorrow = sitterShifts.filter((s) => s.date === tomorrow)
  const shiftsLater = sitterShifts.filter((s) => s.date > tomorrow)
  const shiftsEarlier = sitterShifts.filter((s) => s.date < today)

  const later: DatedEntry[] = [
    ...laterJobs.map((item) => ({ sortKey: `${itemDate(item)} ${itemTime(item)}`, kind: 'job' as const, item })),
    ...shiftsLater.map((shift) => ({ sortKey: `${shift.date} ${shift.planned_start || ''}`, kind: 'shift' as const, shift })),
    ...yardUpcoming.filter((d) => d.date > tomorrow).map((day) => ({ sortKey: `${day.date} ${day.startTime || ''}`, kind: 'yard' as const, day })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey))

  const showEarlier = shiftsEarlier.length > 0 || yardPast.length > 0

  function laterRow(e: DatedEntry) {
    if (e.kind === 'shift') {
      const s = e.shift
      return (
        <DateRow key={`s-${s.date}`} href={`/shift/${s.date}`} ymd={s.date} kind="studio" label="Studio sitter"
          title={shiftEnvelope(s)}
          meta={shiftStatusChip(s)}
          fee={<Fee amount={s.fee} />} />
      )
    }
    if (e.kind === 'yard') {
      const d = e.day
      return (
        <DateRow key={`y-${d.id}`} ymd={d.date} kind="yard" label="Ooosh yard day" title={yardHours(d)}
          meta={<Chip tone="green">Confirmed</Chip>}
          fee={yardFee(d) ? <div className={cls.money}>{yardFee(d)}</div> : undefined} />
      )
    }
    const item = e.item
    if (item.isGrouped) {
      const first = item.jobs[0]
      const { kind, label } = describeRun(item)
      const travel = first ? travelOf(first) : null
      return (
        <DateRow key={`r-${item.runGroup}-${item.date}`} href={`/job/${first?.id}?run=${item.runGroup}`} ymd={item.date}
          kind={kind} label={label}
          title={first ? `${venueOf(first)}${item.jobCount > 1 ? ` + ${item.jobCount - 1} more` : ''}` : 'Multi-drop run'}
          meta={[first?.time ? formatTime(first.time) : '', travel ? travel.long.toLowerCase() : ''].filter(Boolean).join(' · ') || undefined}
          fee={<Fee amount={item.totalFee} strike={item.hasCombinedFee ? item.standaloneTotalFee : null} />} />
      )
    }
    const { kind, label } = describeJob(item)
    const crewDates = item.board === 'crew' && item.finishDate && ymdOf(item.finishDate) !== ymdOf(item.date)
      ? `to ${dayAndNumber(item.finishDate)}` : ''
    const travel = travelOf(item)
    return (
      <DateRow key={item.id} href={jobHref(item)} ymd={item.date} kind={kind} label={label} title={venueOf(item)}
        meta={[crewDates, jobMeta(item), travel ? travel.long.toLowerCase() : ''].filter(Boolean).join(' · ') || undefined}
        fee={<Fee amount={item.driverPay} />} />
    )
  }

  // ── By type ───────────────────────────────────────────────────────────────
  const activeItems = [...todayJobs, ...upcomingJobs]
  const dcItems = activeItems.filter((i) => i.isGrouped || i.board !== 'crew')
  const crewItems = activeItems.filter((i) => !i.isGrouped && i.board === 'crew') as SingleJob[]
  const whenLabel = (ymd: string, time?: string | null) => {
    const day = ymd === today ? 'Today' : ymd === tomorrow ? 'Tomorrow' : dayAndNumber(ymd)
    return time ? `${day} ${formatTime(time)}` : day
  }

  function typeRowFor(item: DisplayItem) {
    if (item.isGrouped) {
      const first = item.jobs[0]
      const { kind, label } = describeRun(item)
      const travel = first ? travelOf(first) : null
      return (
        <TypeRow key={`r-${item.runGroup}-${item.date}`} href={`/job/${first?.id}?run=${item.runGroup}`} kind={kind} Icon={Route}
          title={label}
          meta={[whenLabel(itemDate(item), first?.time), travel?.short].filter(Boolean).join(' · ')} />
      )
    }
    const { kind, label, Icon } = describeJob(item)
    const travel = travelOf(item)
    if (item.board === 'crew') {
      const range = item.finishDate && ymdOf(item.finishDate) !== ymdOf(item.date)
        ? `${dayAndNumber(item.date)} – ${dayAndNumber(item.finishDate)}` : whenLabel(itemDate(item), item.time)
      return (
        <TypeRow key={item.id} href={jobHref(item)} kind={kind} Icon={Icon}
          title={`${item.workType ? titleCase(item.workType) : 'Crew'} · ${venueOf(item)}`}
          meta={[range, item.jobType].filter(Boolean).join(' · ')} />
      )
    }
    return (
      <TypeRow key={item.id} href={jobHref(item)} kind={kind} Icon={Icon}
        title={`${label} · ${venueOf(item)}`}
        meta={[whenLabel(itemDate(item), item.time), item.completedAtDate ? 'done' : travel?.short].filter(Boolean).join(' · ')} />
    )
  }

  const nothingAhead = !loading && activeItems.length === 0 && sitterShifts.length === 0 && yardUpcoming.length === 0

  return (
    <div className="min-h-screen bg-hf-page safe-top pb-32">
      {/* Header */}
      <header className="max-w-lg mx-auto px-5 pt-3.5">
        <div className="flex items-center justify-between pb-1.5">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/ooosh-tours-logo-small.png" alt="Ooosh Tours" className="w-10 h-10 object-contain flex-none" />
            <div className="min-w-0">
              <h1 className="text-[22px] font-bold tracking-[-0.02em] leading-[1.2] text-hf-ink truncate">
                {userName ? `${greeting()}, ${userName}` : 'Jobs'}
              </h1>
              <p className="text-[13px] text-hf-muted">{loading ? 'Updating...' : updatedLabel}</p>
            </div>
          </div>
          <div className="flex gap-1 flex-none">
            <button type="button" onClick={handleRefresh} disabled={loading} title="Refresh" aria-label="Refresh"
              className="w-11 h-11 flex items-center justify-center text-hf-body rounded-xl hover:bg-hf-track disabled:opacity-50">
              <RefreshCw size={22} strokeWidth={1.8} className={loading ? 'animate-spin' : ''} />
            </button>
            <button type="button" onClick={handleLogout} disabled={loggingOut} title="Log out" aria-label="Log out"
              className="w-11 h-11 flex items-center justify-center text-hf-body rounded-xl hover:bg-hf-track disabled:opacity-50">
              <LogOut size={22} strokeWidth={1.8} />
            </button>
          </div>
        </div>
        <Segmented
          className="mt-2.5"
          options={[{ value: 'date', label: 'By date' }, { value: 'type', label: 'By type' }]}
          value={sort}
          onChange={chooseSort}
        />
      </header>

      <main className="max-w-lg mx-auto px-4 pt-5 flex flex-col gap-[26px]">
        {error && (
          <Banner tone="error">
            {error}{' '}
            <button type="button" onClick={handleRefresh} className="underline font-semibold">Try again</button>
          </Banner>
        )}

        {/* Yard days still waiting for an answer: pinned on top in both views. */}
        {(yardPending.length > 0 || yardError) && (
          <section className="flex flex-col gap-2.5">
            <SectionLabel tone="amber">Needs your answer</SectionLabel>
            {yardError && <Banner tone="error">{yardError}</Banner>}
            {yardPending.map((day) => (
              <YardOfferCard key={day.id} day={day} busy={yardBusy === day.id}
                onAnswer={(r) => answerYardDay(day.id, r)} />
            ))}
          </section>
        )}

        {sort === 'date' ? (
          <>
            <DayGroup title="Today" sub={shortDate(today)}>
              {loading ? <LoadingSkeleton /> : (
                todayJobs.length + shiftsToday.length + yardUpcoming.filter((d) => d.date === today).length === 0
                  ? <EmptyCard>Nothing booked for today.</EmptyCard>
                  : (
                    <div className="flex flex-col gap-2.5">
                      {yardUpcoming.filter((d) => d.date === today).map((d) => <YardDayCard key={d.id} day={d} isPast={false} />)}
                      {todayJobs.map((item) => (
                        <ItemCard key={item.isGrouped ? `run-${item.runGroup}-${item.date}` : item.id} item={item} withAction />
                      ))}
                      {shiftsToday.map((s) => <ShiftCard key={s.date} shift={s} tonight />)}
                    </div>
                  )
              )}
            </DayGroup>

            {!loading && (tomorrowJobs.length + shiftsTomorrow.length + yardUpcoming.filter((d) => d.date === tomorrow).length) > 0 && (
              <DayGroup title="Tomorrow" sub={shortDate(tomorrow)}>
                <div className="flex flex-col gap-2.5">
                  {yardUpcoming.filter((d) => d.date === tomorrow).map((d) => <YardDayCard key={d.id} day={d} isPast={false} />)}
                  {tomorrowJobs.map((item) => (
                    <ItemCard key={item.isGrouped ? `run-${item.runGroup}-${item.date}` : item.id} item={item} withAction={false} />
                  ))}
                  {shiftsTomorrow.map((s) => <ShiftCard key={s.date} shift={s} tonight={false} />)}
                </div>
              </DayGroup>
            )}

            {!loading && (
              <DayGroup title="Later" sub="next 30 days">
                {later.length === 0
                  ? <EmptyCard>Nothing else booked in the next 30 days.</EmptyCard>
                  : <Grouped>{later.map(laterRow)}</Grouped>}
              </DayGroup>
            )}

            {!loading && showEarlier && (
              <DayGroup title="Earlier" sub="last few days">
                {shiftsEarlier.length > 0 && (
                  <Grouped>
                    {shiftsEarlier.map((s) => (
                      <DateRow key={`s-${s.date}`} href={`/shift/${s.date}`} ymd={s.date} kind="studio" label="Studio sitter"
                        title={shiftEnvelope(s)} meta={shiftStatusChip(s)} fee={<Fee amount={s.fee} />} />
                    ))}
                  </Grouped>
                )}
                {yardPast.map((d) => <YardDayCard key={d.id} day={d} isPast />)}
              </DayGroup>
            )}
          </>
        ) : (
          <>
            {loading ? <LoadingSkeleton /> : (
              <>
                {dcItems.length > 0 && (
                  <section className="flex flex-col gap-2.5">
                    <SectionLabel count={dcItems.length}>Deliveries &amp; collections</SectionLabel>
                    <Grouped inset={68}>{dcItems.map(typeRowFor)}</Grouped>
                  </section>
                )}
                {sitterShifts.length > 0 && (
                  <section className="flex flex-col gap-2.5">
                    <SectionLabel count={sitterShifts.length}>Studio shifts</SectionLabel>
                    <Grouped inset={68}>
                      {sitterShifts.map((s) => (
                        <TypeRow key={s.date} href={`/shift/${s.date}`} kind="studio" Icon={Mic}
                          title={`${s.date === today ? 'Tonight' : dayAndNumber(s.date)} · ${shiftEnvelope(s)}`}
                          meta={s.report_submitted_at ? 'Locked up'
                            : s.assignment_status !== 'confirmed' ? 'Assigned'
                            : s.jobs.length ? `${s.jobs.length} band${s.jobs.length === 1 ? '' : 's'} in` : undefined} />
                      ))}
                    </Grouped>
                  </section>
                )}
                {crewItems.length > 0 && (
                  <section className="flex flex-col gap-2.5">
                    <SectionLabel count={crewItems.length}>Crew</SectionLabel>
                    <Grouped inset={68}>{crewItems.map(typeRowFor)}</Grouped>
                  </section>
                )}
                {(yardUpcoming.length > 0 || yardPast.length > 0) && (
                  <section className="flex flex-col gap-2.5">
                    <SectionLabel count={yardUpcoming.length + yardPast.length}>Ooosh work</SectionLabel>
                    {yardUpcoming.map((d) => <YardDayCard key={d.id} day={d} isPast={false} />)}
                    {yardPast.map((d) => <YardDayCard key={d.id} day={d} isPast />)}
                  </section>
                )}
                {nothingAhead && <EmptyCard>Nothing booked in the next 30 days.</EmptyCard>}
              </>
            )}
          </>
        )}

        {/* Completed / Cancelled: two rows that open their own lists. */}
        {!loading && (
          <Grouped inset={56}>
            {[
              <Link key="c" href="/completed" className="h-14 px-4 flex items-center gap-3 hover:bg-hf-inset/60">
                <span className="w-7 h-7 rounded-full bg-hf-green-tint text-hf-green-text flex items-center justify-center"><Check size={16} strokeWidth={2.4} /></span>
                <span className="flex-1 text-[16px] font-medium text-hf-ink">Completed</span>
                <span className="text-[15px] text-hf-muted tabular">{stopCount(completedJobs) + pastShiftCount + yardDoneCount}</span>
                <Chevron />
              </Link>,
              <Link key="x" href="/cancelled" className="h-14 px-4 flex items-center gap-3 hover:bg-hf-inset/60">
                <span className="w-7 h-7 rounded-full bg-hf-track text-hf-muted flex items-center justify-center"><X size={16} strokeWidth={2.4} /></span>
                <span className="flex-1 text-[16px] font-medium text-hf-ink">Cancelled</span>
                <span className="text-[15px] text-hf-muted tabular">{stopCount(cancelledJobs)}</span>
                <Chevron />
              </Link>,
            ]}
          </Grouped>
        )}
      </main>

      <BottomNav active="jobs" />
    </div>
  )
}
