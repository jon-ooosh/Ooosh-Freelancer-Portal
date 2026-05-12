/**
 * TurnaroundSchedule — fleet-wide forward-facing prep planning view.
 *
 * Renders on the /vehicles HomePage as a new section. Answers the question
 * "which vans need prep, and when do I need them ready?". Each row is one
 * van with its current commitment, next upcoming hire, prep window, and
 * compliance flags within the visible window.
 *
 * Read-only: this is a planning surface, not an allocation tool. Clicking
 * a gap on the strip deep-links to AllocationsPage to take action.
 */

import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../../config/api-config'
import { vmPath } from '../../config/route-paths'

type AssignmentDto = {
  id: string
  status: 'soft' | 'confirmed' | 'booked_out' | 'active'
  jobId: string | null
  hhJobNumber: number | null
  jobName: string | null
  clientName: string | null
  pipelineStatus: string | null
  hireStart: string | null
  hireEnd: string | null
}

type ComplianceFlagDto = {
  kind: 'MOT' | 'Tax' | 'Insurance' | 'TFL'
  date: string
  daysUntil: number
  urgency: 'soon' | 'overdue'
}

type Row = {
  vehicleId: string
  reg: string
  simpleType: string | null
  hireStatus: string | null
  currentHire: AssignmentDto | null
  nextHire: AssignmentDto | null
  comingBack: string | null
  goingOutNext: string | null
  prepWindowDays: number | null
  prepUrgency: 'green' | 'amber' | 'orange' | 'red' | 'none'
  complianceFlags: ComplianceFlagDto[]
}

type Response = {
  data: Row[]
  thresholds: { amber: number; orange: number; red: number }
  window: { days: number; startISO: string; endISO: string }
  total: number
  filtered: number
}

type RangeDays = 7 | 14 | 28
type StateFilter = 'all' | 'on_hire' | 'prep_needed' | 'available'
type ComplianceFilter = 'all' | 'flagged'
type HasNextFilter = 'all' | 'yes' | 'no'
type SortMode = 'urgency' | 'returning_soonest' | 'going_out_soonest' | 'reg'

function fmtShort(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

function diffDaysFromToday(iso: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const d = new Date(iso + 'T00:00:00')
  return Math.round((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
}

function relativeDayLabel(iso: string | null): string {
  if (!iso) return '—'
  const days = diffDaysFromToday(iso)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  if (days > 0 && days <= 6) return `${fmtShort(iso)} (in ${days}d)`
  if (days < 0 && days >= -6) return `${fmtShort(iso)} (${Math.abs(days)}d ago)`
  return fmtShort(iso)
}

/** Visual urgency colour scheme for prep window. */
const prepColours: Record<Row['prepUrgency'], { bg: string; text: string; label: string }> = {
  green:  { bg: 'bg-green-100',  text: 'text-green-700',  label: 'Comfortable' },
  amber:  { bg: 'bg-amber-100',  text: 'text-amber-700',  label: 'Standard' },
  orange: { bg: 'bg-orange-100', text: 'text-orange-700', label: 'Eats buffer' },
  red:    { bg: 'bg-red-100',    text: 'text-red-700',    label: 'Overlap — review' },
  none:   { bg: 'bg-gray-100',   text: 'text-gray-500',   label: '—' },
}

function PrepWindowBadge({ row }: { row: Row }) {
  const colour = prepColours[row.prepUrgency]
  if (row.prepWindowDays === null) {
    return (
      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colour.bg} ${colour.text}`}>
        n/a
      </span>
    )
  }
  const days = row.prepWindowDays
  const label = days === 0 ? 'Same day' : days < 0 ? `${Math.abs(days)}d overlap` : `${days} day${days === 1 ? '' : 's'}`
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colour.bg} ${colour.text}`} title={colour.label}>
      {label}
    </span>
  )
}

function StatePill({ status }: { status: string | null }) {
  if (!status) return null
  if (status === 'On Hire') {
    return <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">On Hire</span>
  }
  if (status === 'Prep Needed') {
    return <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">Prep Needed</span>
  }
  if (status === 'Available') {
    return <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Available</span>
  }
  if (status === 'Not Ready') {
    return <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">Not Ready</span>
  }
  return <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600">{status}</span>
}

/**
 * Mini-strip showing the van's commitment over the window. Each cell
 * represents one day. Colour coded:
 *   Blue = current hire (out)
 *   Purple = next upcoming hire
 *   Amber = prep window (between current end and next start)
 *   Grey = available
 * Compliance pips render above their respective day.
 */
function MiniStrip({ row, windowDays }: { row: Row; windowDays: number }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const currStart = row.currentHire?.hireStart ? new Date(row.currentHire.hireStart + 'T00:00:00') : null
  const currEnd = row.currentHire?.hireEnd ? new Date(row.currentHire.hireEnd + 'T00:00:00') : null
  const nextStart = row.nextHire?.hireStart ? new Date(row.nextHire.hireStart + 'T00:00:00') : null
  const nextEnd = row.nextHire?.hireEnd ? new Date(row.nextHire.hireEnd + 'T00:00:00') : null

  function cellState(dayOffset: number): 'out' | 'next' | 'prep' | 'free' {
    const d = new Date(today)
    d.setDate(d.getDate() + dayOffset)
    // Currently out?
    if (currStart && currEnd && d >= currStart && d <= currEnd) return 'out'
    // Next hire range?
    if (nextStart && nextEnd && d >= nextStart && d <= nextEnd) return 'next'
    // Prep window between current end and next start?
    if (currEnd && nextStart && d > currEnd && d < nextStart) return 'prep'
    // Prep window before first next hire when no current hire?
    if (!currEnd && nextStart && d < nextStart) return 'prep'
    return 'free'
  }

  const cellClasses: Record<'out' | 'next' | 'prep' | 'free', string> = {
    out:  'bg-blue-400',
    next: 'bg-purple-400',
    prep: 'bg-amber-300',
    free: 'bg-gray-100',
  }

  // Compliance pips — position by day offset from today.
  const pipKindColour: Record<ComplianceFlagDto['kind'], string> = {
    MOT: 'text-red-600',
    Tax: 'text-orange-600',
    Insurance: 'text-amber-600',
    TFL: 'text-violet-600',
  }

  return (
    <div className="relative">
      {/* Compliance pips row */}
      {row.complianceFlags.length > 0 && (
        <div className="relative h-3 mb-0.5">
          {row.complianceFlags.map((flag, i) => {
            // Position the pip at the day's offset. Day 0 = today.
            const offsetDays = Math.max(0, Math.min(windowDays - 1, flag.daysUntil < 0 ? 0 : flag.daysUntil))
            const left = `${(offsetDays / windowDays) * 100}%`
            return (
              <span
                key={`${flag.kind}-${i}`}
                className={`absolute text-[10px] font-bold ${pipKindColour[flag.kind]}`}
                style={{ left, transform: 'translateX(-50%)' }}
                title={`${flag.kind} ${flag.urgency === 'overdue' ? 'overdue by ' + Math.abs(flag.daysUntil) + 'd' : 'in ' + flag.daysUntil + 'd'} (${fmtShort(flag.date)})`}
              >
                ▾
              </span>
            )
          })}
        </div>
      )}

      {/* Day cells */}
      <div className="flex h-2 overflow-hidden rounded-sm">
        {Array.from({ length: windowDays }).map((_, i) => {
          const state = cellState(i)
          return <div key={i} className={`flex-1 ${cellClasses[state]} ${i === 0 ? '' : 'border-l border-white'}`} />
        })}
      </div>
    </div>
  )
}

/**
 * Compact summary of a linked hire (current or next). The job-detail page
 * accepts only OP UUID — if we don't have one (HH-only assignment, no OP row
 * yet), render plain text + the HH number as informational. Avoids generating
 * a /jobs/<hh_number> link that would 404.
 */
function JobHireSummary({
  jobId,
  hhJobNumber,
  clientName,
  dateLabel,
}: {
  jobId: string | null
  hhJobNumber: number | null
  clientName: string | null
  dateLabel: string
}) {
  const content = (
    <>
      {dateLabel}
      {hhJobNumber && <span className="text-gray-400"> · #{hhJobNumber}</span>}
      {clientName && <span className="text-gray-500"> · {clientName}</span>}
    </>
  )
  if (jobId) {
    return (
      <Link to={`/jobs/${jobId}`} className="text-gray-700 hover:text-ooosh-navy hover:underline">
        {content}
      </Link>
    )
  }
  return <span className="text-gray-700">{content}</span>
}

function ComplianceFlagBadge({ flag }: { flag: ComplianceFlagDto }) {
  const overdue = flag.urgency === 'overdue'
  const text = overdue ? `${Math.abs(flag.daysUntil)}d overdue` : `in ${flag.daysUntil}d`
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
      overdue ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
    }`}>
      <span className="font-bold">{flag.kind}</span> {text}
    </span>
  )
}

/**
 * Build a deep-link to AllocationsPage filtered to the gap window when
 * staff want to act on "this van has a gap from X to Y, what can fit?".
 * AllocationsPage already supports ?job=<hh>; we add ?date_from/date_to as
 * a hint — page may or may not consume yet, but the URL is durable.
 */
function gapDeepLink(row: Row): string | null {
  if (!row.comingBack || !row.goingOutNext) return null
  return vmPath(`/allocations?date_from=${row.comingBack}&date_to=${row.goingOutNext}`)
}

function RowCard({ row, windowDays }: { row: Row; windowDays: number }) {
  const isAvailable = !row.currentHire && !row.nextHire
  const noNext = !row.nextHire
  const gapLink = gapDeepLink(row)

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 hover:shadow-sm transition-shadow">
      {/* Top row: reg + type + state + prep window */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <Link
          to={vmPath(`/vehicles/${row.vehicleId}`)}
          className="font-mono text-sm font-bold text-ooosh-navy hover:underline"
        >
          {row.reg}
        </Link>
        {row.simpleType && (
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {row.simpleType}
          </span>
        )}
        <StatePill status={row.hireStatus} />
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wide text-gray-400">Prep</span>
          <PrepWindowBadge row={row} />
        </div>
      </div>

      {/* Detail row: coming back / going out next */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2 text-xs">
        <div>
          <span className="text-gray-400">Coming back: </span>
          {row.currentHire ? (
            <JobHireSummary
              jobId={row.currentHire.jobId}
              hhJobNumber={row.currentHire.hhJobNumber}
              clientName={row.currentHire.clientName}
              dateLabel={relativeDayLabel(row.comingBack)}
            />
          ) : (
            <span className="text-gray-500">{isAvailable ? 'Already here' : '—'}</span>
          )}
        </div>
        <div>
          <span className="text-gray-400">Going out next: </span>
          {row.nextHire ? (
            <JobHireSummary
              jobId={row.nextHire.jobId}
              hhJobNumber={row.nextHire.hhJobNumber}
              clientName={row.nextHire.clientName}
              dateLabel={relativeDayLabel(row.goingOutNext)}
            />
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="rounded-full bg-green-50 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                No next allocation
              </span>
              {row.comingBack && (
                <Link
                  to={vmPath(`/allocations?date_from=${row.comingBack}`)}
                  className="text-[10px] font-medium text-blue-600 hover:underline"
                >
                  Find a job →
                </Link>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Mini-strip with compliance pips */}
      <MiniStrip row={row} windowDays={windowDays} />

      {/* Flags row */}
      {row.complianceFlags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.complianceFlags.map((flag, i) => (
            <ComplianceFlagBadge key={`${flag.kind}-${i}`} flag={flag} />
          ))}
        </div>
      )}

      {/* Gap action link */}
      {gapLink && !noNext && (
        <div className="mt-2 text-right">
          <Link to={gapLink} className="text-[10px] font-medium text-blue-600 hover:underline">
            Find a job for this gap →
          </Link>
        </div>
      )}
    </div>
  )
}

export function TurnaroundSchedule() {
  const [days, setDays] = useState<RangeDays>(14)
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const [complianceFilter, setComplianceFilter] = useState<ComplianceFilter>('all')
  const [hasNextFilter, setHasNextFilter] = useState<HasNextFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('urgency')
  const [searchQuery, setSearchQuery] = useState('')

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      days: String(days),
      state: stateFilter,
      compliance: complianceFilter,
      has_next: hasNextFilter,
      sort: sortMode,
    })
    if (searchQuery.trim()) params.set('q', searchQuery.trim())
    return params.toString()
  }, [days, stateFilter, complianceFilter, hasNextFilter, sortMode, searchQuery])

  const { data, isLoading, isError, error, refetch } = useQuery<Response>({
    queryKey: ['turnaround-schedule', queryString],
    queryFn: async () => {
      const resp = await apiFetch(`/turnaround-schedule?${queryString}`)
      if (!resp.ok) throw new Error(`Failed: ${resp.status}`)
      return resp.json() as Promise<Response>
    },
    staleTime: 15_000,
  })

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">
          Turnaround Schedule
          <span className="ml-2 text-[10px] font-normal normal-case text-gray-400">
            Next {days} days · prep priority
          </span>
        </h3>
        <button
          onClick={() => refetch()}
          disabled={isLoading}
          className="text-xs text-gray-400 hover:text-gray-600 disabled:opacity-50"
        >
          {isLoading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Filters + sort */}
      <div className="mb-3 space-y-2">
        {/* Range + sort row */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1">
            {([7, 14, 28] as RangeDays[]).map(n => (
              <button
                key={n}
                onClick={() => setDays(n)}
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  days === n ? 'bg-ooosh-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {n}d
              </button>
            ))}
          </div>
          <span className="text-gray-300">·</span>
          <select
            value={sortMode}
            onChange={e => setSortMode(e.target.value as SortMode)}
            className="rounded border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-600"
          >
            <option value="urgency">Sort: Urgency (default)</option>
            <option value="returning_soonest">Sort: Returning soonest</option>
            <option value="going_out_soonest">Sort: Going out soonest</option>
            <option value="reg">Sort: Reg A–Z</option>
          </select>
          <input
            type="search"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter by reg…"
            className="ml-auto w-32 rounded border border-gray-200 px-2 py-0.5 text-xs placeholder:text-gray-400 focus:border-ooosh-blue focus:outline-none"
          />
        </div>

        {/* Filter pills */}
        <div className="flex flex-wrap gap-1.5">
          {/* State filter */}
          {([
            { value: 'all', label: 'All states' },
            { value: 'on_hire', label: 'On Hire' },
            { value: 'prep_needed', label: 'Prep Needed' },
            { value: 'available', label: 'Available' },
          ] as { value: StateFilter; label: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setStateFilter(opt.value)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                stateFilter === opt.value
                  ? 'bg-ooosh-navy text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}

          <span className="self-center text-gray-300">|</span>

          {/* Has next */}
          {([
            { value: 'all', label: 'Any' },
            { value: 'yes', label: 'Has next hire' },
            { value: 'no', label: 'No next allocation' },
          ] as { value: HasNextFilter; label: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => setHasNextFilter(opt.value)}
              className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
                hasNextFilter === opt.value
                  ? 'bg-ooosh-navy text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt.label}
            </button>
          ))}

          <span className="self-center text-gray-300">|</span>

          {/* Compliance filter */}
          <button
            onClick={() => setComplianceFilter(complianceFilter === 'flagged' ? 'all' : 'flagged')}
            className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              complianceFilter === 'flagged'
                ? 'bg-red-600 text-white'
                : 'bg-red-100 text-red-700 hover:opacity-80'
            }`}
          >
            ⚠ Compliance flagged
          </button>
        </div>
      </div>

      {/* Body */}
      {isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <p className="font-medium">Failed to load turnaround schedule</p>
          <p className="mt-1 text-xs text-red-500">{error instanceof Error ? error.message : 'Unknown error'}</p>
          <button
            onClick={() => refetch()}
            className="mt-2 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      )}

      {!isLoading && !isError && data && data.data.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
          No vans match these filters in the next {days} days
        </div>
      )}

      {!isLoading && !isError && data && data.data.length > 0 && (
        <div className="space-y-2">
          {data.data.map(row => (
            <RowCard key={row.vehicleId} row={row} windowDays={days} />
          ))}
          <div className="text-right text-[10px] text-gray-400">
            Showing {data.filtered} of {data.total} active vehicles
            {data.thresholds && (
              <span>
                {' '}· Thresholds: ≤{data.thresholds.amber}d amber, ≤{data.thresholds.orange}d orange, ≤{data.thresholds.red}d red
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
