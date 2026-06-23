/**
 * AllocationsPage — Van-to-job assignment management.
 *
 * Fleet managers use this page to:
 * 1. See upcoming HireHop jobs for today/tomorrow
 * 2. "Soft assign" available prepped vans to jobs
 * 3. Assign drivers to vans (auto for single-van jobs, manual for multi-van)
 * 4. See which jobs are fully assigned vs unassigned
 *
 * Data: HireHop jobs (API) + fleet vehicles (Monday) + allocations (R2).
 */

import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useUpcomingJobs, useUpcomingDueBackJobs } from '../hooks/useHireHopJobs'
import { HireHopCacheStatus } from '../components/HireHopCacheStatus'
import { useVehicles } from '../hooks/useVehicles'
import { useAllocations, useSaveAllocations } from '../hooks/useAllocations'
import { useDriverHireForms } from '../hooks/useDriverHireForms'
import { extractVanRequirements } from '../lib/hirehop-api'
import { findMatchingVehicles, formatVanType, getVehicleGearboxLabel, vehicleNeedsPrepWarning } from '../lib/van-matching'
import { useAvailability } from '../hooks/useAvailability'
import type { HireHopJob, VanAllocation, VanRequirement } from '../types/hirehop'
import type { Vehicle } from '../types/vehicle'

type DateFilter = 'today' | 'tomorrow' | 'this-week' | 'all'
type ViewMode = 'going-out' | 'due-back'

/** How many days ahead the allocations page looks. The "All" pill maps to
 *  this window; "This Week" / "Today" / "Tomorrow" are subsets. Bumped from
 *  14 to 30 in May 2026 so deep-links from Job Detail (?job=<hh>) surface
 *  jobs further out — 14 days frequently missed next-week bookings whose
 *  out_date fell after Sunday. */
const ALLOCATIONS_DAYS_AHEAD = 30

export function AllocationsPage() {
  const [searchParams] = useSearchParams()
  const focusJobId = searchParams.get('job') ? parseInt(searchParams.get('job')!, 10) : null

  // When arriving via ?job=<hh> deep-link from Job Detail, force the
  // broadest filter so the target job is guaranteed to be visible
  // regardless of when it lands. Without this the deep-link silently
  // drops the user on "This Week" and the focused job may be off-screen
  // entirely. Search box still works on top.
  const [dateFilter, setDateFilter] = useState<DateFilter>(focusJobId ? 'all' : 'this-week')
  const [viewMode, setViewMode] = useState<ViewMode>('going-out')
  const [searchTerm, setSearchTerm] = useState('')

  const { data: upcomingJobs, isLoading: upcomingLoading, error: upcomingError } = useUpcomingJobs(ALLOCATIONS_DAYS_AHEAD)
  const { data: dueBackJobs, isLoading: dueBackLoading, error: dueBackError } = useUpcomingDueBackJobs(ALLOCATIONS_DAYS_AHEAD)
  const { data: allVehicles } = useVehicles()
  const { data: allocations, isLoading: allocationsLoading } = useAllocations()

  const allocationsList = allocations || []

  // All visible job numbers (for on-demand HireHop refresh)
  const allVisibleJobs = useMemo(
    () => [...(upcomingJobs || []), ...(dueBackJobs || [])].filter((j, i, arr) => arr.findIndex(x => x.id === j.id) === i),
    [upcomingJobs, dueBackJobs],
  )

  // Active fleet vehicles only
  const activeVehicles = useMemo(
    () => (allVehicles || []).filter(v => !v.isOldSold),
    [allVehicles],
  )

  // Date helpers for filtering
  const today = useMemo(() => new Date().toISOString().split('T')[0]!, [])
  const tomorrow = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    return d.toISOString().split('T')[0]!
  }, [])
  const endOfWeek = useMemo(() => {
    const d = new Date()
    // Days until Sunday (0=Sun, so 7-day = Sun at end of week)
    const daysUntilSunday = 7 - d.getDay()
    d.setDate(d.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday))
    return d.toISOString().split('T')[0]!
  }, [])

  // Filter jobs by date selection
  const filteredJobs = useMemo(() => {
    const jobs = viewMode === 'going-out' ? (upcomingJobs || []) : (dueBackJobs || [])
    const dateField = viewMode === 'going-out' ? 'outDate' : 'returnDate'

    return jobs.filter(job => {
      // Only show jobs that have van items — skip non-vehicle jobs
      // Jobs with empty items (not yet synced) are kept — use "Refresh from HireHop" to populate
      if (job.items.length > 0 && extractVanRequirements(job).length === 0) return false

      const jobDate = job[dateField]
      if (dateFilter === 'today') return jobDate === today
      if (dateFilter === 'tomorrow') return jobDate === tomorrow
      if (dateFilter === 'this-week') return jobDate <= endOfWeek
      return true // 'all' — show everything within ALLOCATIONS_DAYS_AHEAD
    }).sort((a, b) => {
      const dateA = a[dateField]
      const dateB = b[dateField]
      const dateCmp = dateA.localeCompare(dateB)
      return dateCmp !== 0 ? dateCmp : a.id - b.id
    })
  }, [viewMode, upcomingJobs, dueBackJobs, dateFilter, today, tomorrow, endOfWeek])

  // Search filter — matches HH job number, job name, client/company, or any
  // allocated van reg on the job. Case-insensitive substring. Empty string =
  // pass-through. Reg match means staff can type "RX22SWU" to find every job
  // currently holding that van — useful when triaging an overlap.
  const searchedJobs = useMemo(() => {
    const q = searchTerm.trim().toLowerCase()
    if (!q) return filteredJobs
    return filteredJobs.filter(job => {
      if (String(job.id).includes(q)) return true
      if ((job.jobName || '').toLowerCase().includes(q)) return true
      if ((job.company || '').toLowerCase().includes(q)) return true
      const jobAllocs = allocationsList.filter(a => a.hireHopJobId === job.id)
      if (jobAllocs.some(a => (a.vehicleReg || '').toLowerCase().includes(q))) return true
      return false
    })
  }, [filteredJobs, searchTerm, allocationsList])

  // All visible job IDs — sent to backend so it knows which jobs are "in scope"
  // for cancellation (even if they have zero allocations)
  const managedJobIds = useMemo(
    () => filteredJobs.map(j => j.id),
    [filteredJobs],
  )

  const saveAllocations = useSaveAllocations(managedJobIds)

  const isLoading = viewMode === 'going-out' ? upcomingLoading : dueBackLoading
  const hirehopError = viewMode === 'going-out' ? upcomingError : dueBackError

  // ── Allocation Actions ──

  const handleAllocateVan = useCallback(async (
    job: HireHopJob,
    requirementIndex: number,
    vehicle: Vehicle,
    staffName: string,
  ) => {
    const newAllocation: VanAllocation = {
      id: crypto.randomUUID(),
      hireHopJobId: job.id,
      hireHopJobName: job.company || job.jobName || `Job #${job.id}`,
      vanRequirementIndex: requirementIndex,
      vehicleId: vehicle.id,
      vehicleReg: vehicle.reg,
      driverName: null,
      status: 'soft',
      allocatedAt: new Date().toISOString(),
      allocatedBy: staffName,
      confirmedAt: null,
    }

    const updated = [...allocationsList, newAllocation]
    saveAllocations.mutate(updated)
  }, [allocationsList, saveAllocations])

  const handleRemoveAllocation = useCallback(async (allocationId: string) => {
    const target = allocationsList.find(a => a.id === allocationId)
    if (target?.readOnly) return // Can't remove booked_out/active allocations via allocations page
    const updated = allocationsList.filter(a => a.id !== allocationId)
    saveAllocations.mutate(updated)
  }, [allocationsList, saveAllocations])

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-ooosh-navy">Van Allocations</h2>
        <Link to={vmPath('/')} className="text-sm text-blue-600">
          ← Dashboard
        </Link>
      </div>
      <HireHopCacheStatus jobNumbers={allVisibleJobs.map(j => j.id)} />

      {/* View mode tabs */}
      <div className="flex gap-2">
        <button
          onClick={() => setViewMode('going-out')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            viewMode === 'going-out'
              ? 'bg-ooosh-navy text-white'
              : 'border border-gray-200 bg-white text-gray-600'
          }`}
        >
          Going Out
        </button>
        <button
          onClick={() => setViewMode('due-back')}
          className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            viewMode === 'due-back'
              ? 'bg-ooosh-navy text-white'
              : 'border border-gray-200 bg-white text-gray-600'
          }`}
        >
          Due Back
        </button>
      </div>

      {/* Search box — matches HH job number, job name, client, or van reg.
          Useful for jumping to a specific job (especially when arriving from
          the Job Detail "Allocate Van" deep-link) and for triaging overlap
          cases by reg ("which jobs are holding RX22SWU right now?"). */}
      <div className="relative">
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="Search by job number, name, client, or van reg…"
          className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 pr-8 text-sm focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
        />
        {searchTerm && (
          <button
            type="button"
            onClick={() => setSearchTerm('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            aria-label="Clear search"
          >
            ×
          </button>
        )}
      </div>

      {/* Date filter pills */}
      <div className="flex gap-2">
        {([
          { key: 'today' as DateFilter, label: 'Today' },
          { key: 'tomorrow' as DateFilter, label: 'Tomorrow' },
          { key: 'this-week' as DateFilter, label: 'This Week' },
          { key: 'all' as DateFilter, label: 'All' },
        ]).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setDateFilter(key)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              dateFilter === key
                ? 'bg-ooosh-navy text-white'
                : 'border border-gray-200 bg-white text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* HireHop error state */}
      {hirehopError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-medium text-red-800">HireHop Connection Issue</p>
          <p className="mt-1 text-xs text-red-600">
            {hirehopError instanceof Error ? hirehopError.message : 'Failed to load jobs from HireHop'}
          </p>
          <p className="mt-1 text-xs text-red-500">
            Check that HIREHOP_API_TOKEN is set correctly in Netlify environment variables.
            View Netlify function logs for diagnostic details.
          </p>
        </div>
      )}

      {/* Jobs list */}
      {isLoading || allocationsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg bg-gray-100" />
          ))}
        </div>
      ) : searchedJobs.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
          {searchTerm ? (
            <>No jobs match "{searchTerm}".</>
          ) : (
            <>
              No jobs {viewMode === 'going-out' ? 'going out' : 'due back'}{' '}
              {dateFilter === 'today' ? 'today' : dateFilter === 'tomorrow' ? 'tomorrow' : dateFilter === 'this-week' ? 'this week' : `in the next ${ALLOCATIONS_DAYS_AHEAD} days`}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {searchedJobs.map(job => (
            <JobAllocationCard
              key={job.id}
              job={job}
              allocations={allocationsList}
              vehicles={activeVehicles}
              defaultExpanded={focusJobId === job.id}
              viewMode={viewMode}
              onAllocate={handleAllocateVan}
              onRemove={handleRemoveAllocation}
              saving={saveAllocations.isPending}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Job Allocation Card — expandable job with van slots
 * ────────────────────────────────────────────── */

function JobAllocationCard({
  job,
  allocations,
  vehicles,
  defaultExpanded,
  viewMode,
  onAllocate,
  onRemove,
  saving,
}: {
  job: HireHopJob
  allocations: VanAllocation[]
  vehicles: Vehicle[]
  defaultExpanded: boolean
  viewMode: ViewMode
  onAllocate: (job: HireHopJob, reqIndex: number, vehicle: Vehicle, staffName: string) => void
  onRemove: (allocationId: string) => void
  saving: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const cardRef = useRef<HTMLDivElement>(null)

  // Scroll the card into view on mount when arriving via the ?job=<hh>
  // deep-link from Job Detail. Only fires once per mount; subsequent
  // expand/collapse interactions don't re-scroll. Guarded on
  // defaultExpanded so cards that aren't the focus target don't move.
  useEffect(() => {
    if (defaultExpanded && cardRef.current) {
      cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const requirements = extractVanRequirements(job)
  const jobAllocations = allocations.filter(a => a.hireHopJobId === job.id)
  const totalNeeded = requirements.reduce((sum, r) => sum + r.quantity, 0)
  // Count unique vans actually picked — not hire-form placeholders waiting
  // for a van. Multiple drivers on the same van still count as 1 assignment.
  const assignedCount = new Set(
    jobAllocations.filter(a => a.vehicleId).map(a => a.vehicleId),
  ).size

  // Fetch driver hire forms for this job (only when expanded to save API calls)
  const { data: hireForms } = useDriverHireForms(expanded ? String(job.id) : null)

  const dateStr = viewMode === 'going-out' ? job.outDate : job.returnDate
  const displayDate = formatDisplayDate(dateStr)

  // Status colour
  const isFullyAssigned = assignedCount >= totalNeeded
  const borderColour = isFullyAssigned
    ? 'border-green-200'
    : assignedCount > 0
      ? 'border-amber-200'
      : 'border-red-200'

  return (
    <div ref={cardRef} className={`rounded-lg border ${borderColour} bg-white scroll-mt-4`}>
      {/* Header — always visible, click to expand */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3 text-left"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-ooosh-navy">#{job.id}</span>
              <span className="truncate text-sm text-gray-700">
                {job.company || job.contactName || job.jobName}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {requirements.map((req, i) => (
                <span
                  key={i}
                  className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600"
                >
                  {req.quantity > 1 ? `${req.quantity}x ` : ''}{formatVanType(req.simpleType, req.gearbox)}
                </span>
              ))}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                isFullyAssigned
                  ? 'bg-green-100 text-green-700'
                  : assignedCount > 0
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-red-100 text-red-700'
              }`}>
                {isFullyAssigned ? 'All Assigned' : `${assignedCount}/${totalNeeded} assigned`}
              </span>
              <span className="text-[10px] text-gray-400">{job.statusLabel}</span>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-xs font-medium text-gray-600">{displayDate}</p>
            <svg
              className={`ml-auto mt-1 h-4 w-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </div>
      </button>

      {/* Expanded — van requirement slots */}
      {expanded && (
        <div className="border-t border-gray-100 px-3 pb-3 pt-2">
          {/* Registered drivers from hire form board */}
          {hireForms && hireForms.length > 0 && (
            <div className="mb-3 rounded-lg border border-green-200 bg-green-50 p-2.5">
              <p className="mb-1 text-[10px] font-medium uppercase text-green-600">Registered Drivers</p>
              <div className="flex flex-wrap gap-1">
                {hireForms.map(hf => (
                  <span
                    key={hf.id}
                    className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
                  >
                    {hf.driverName}
                  </span>
                ))}
              </div>
              {hireForms[0]?.hireStart && (
                <p className="mt-1 text-[10px] text-green-700">
                  Hire: {hireForms[0].hireStart} — {hireForms[0]?.hireEnd || '?'}
                </p>
              )}
            </div>
          )}

          {requirements.length === 0 && !job.itemsFetchFailed && (
            <p className="text-sm text-gray-400">No van items on this job</p>
          )}
          {requirements.length === 0 && job.itemsFetchFailed && (
            <p className="text-sm text-amber-500">Van items couldn't be loaded (job may be dispatched)</p>
          )}

          {requirements.map((req, reqIndex) => (
            <RequirementSlots
              key={reqIndex}
              job={job}
              requirement={req}
              requirementIndex={reqIndex}
              allocations={jobAllocations}
              vehicles={vehicles}
              onAllocate={onAllocate}
              onRemove={onRemove}
              saving={saving}
            />
          ))}

          {/* Orphaned allocations — assigned to requirement indices that no longer exist */}
          {(() => {
            const validIndices = new Set(requirements.map((_, i) => i))
            const orphaned = jobAllocations.filter(a => !validIndices.has(a.vanRequirementIndex))
            if (orphaned.length === 0) return null
            return (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5">
                <p className="mb-1.5 text-[10px] font-medium uppercase text-red-600">
                  Orphaned Allocations (job requirements changed)
                </p>
                {orphaned.map(allocation => (
                  <div key={allocation.id} className="mb-1 flex items-center justify-between rounded border border-red-200 bg-white p-2">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-sm font-bold text-ooosh-navy">{allocation.vehicleReg}</span>
                      <span className="text-[10px] text-red-600">No matching requirement</span>
                    </div>
                    {allocation.hireFormLinked ? (
                      <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                        Hire Form
                      </span>
                    ) : (
                      <button
                        onClick={() => onRemove(allocation.id)}
                        disabled={saving}
                        className="text-xs font-medium text-red-600 disabled:text-gray-400"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Requirement Slots — per van type, shows allocated or picker
 * ────────────────────────────────────────────── */

function RequirementSlots({
  job,
  requirement,
  requirementIndex,
  allocations: jobAllocations,
  vehicles,
  onAllocate,
  onRemove,
  saving,
}: {
  job: HireHopJob
  requirement: VanRequirement
  requirementIndex: number
  allocations: VanAllocation[]
  vehicles: Vehicle[]
  onAllocate: (job: HireHopJob, reqIndex: number, vehicle: Vehicle, staffName: string) => void
  onRemove: (allocationId: string) => void
  saving: boolean
}) {
  const queryClient = useQueryClient()
  const [showPicker, setShowPicker] = useState(false)
  // Inline picker state keyed by allocation id — used when a hire-form-
  // created slot has a driver attached but no vehicle yet, letting staff
  // pick a van for that specific driver card without leaving the page.
  const [linkPickerForId, setLinkPickerForId] = useState<string | null>(null)
  // Inline picker for MOVING a single already-vanned driver to a different
  // van on a multi-van job (e.g. 5 drivers over 2 vans). Distinct from the
  // link picker above: this re-points one card without cascading to siblings.
  const [changeVanForId, setChangeVanForId] = useState<string | null>(null)
  const [linking, setLinking] = useState(false)

  /** Soft-refresh allocations data without a full page reload — preserves scroll. */
  function refreshAllocationsSoftly() {
    queryClient.invalidateQueries({ queryKey: ['allocations'] })
  }

  const label = formatVanType(requirement.simpleType, requirement.gearbox)
  const slotsNeeded = requirement.quantity

  // Allocations for this specific requirement index
  const slotAllocations = jobAllocations.filter(a => a.vanRequirementIndex === requirementIndex)

  // Ask the backend which vehicles are occupied for this job's date window.
  // Uses Job Finish (jobEndDate) rather than Returning — the +1-day
  // turnaround buffer is intentionally ignored until we make it
  // configurable. Excludes this job so multi-driver single-van rows don't
  // mark themselves unavailable.
  const { data: availability } = useAvailability({
    start: job.jobDate || job.outDate,
    end: job.jobEndDate || job.returnDate,
    excludeHhJobId: job.id,
  })
  const unavailableIds = availability?.unavailableIds ?? new Set<string>()

  // Vehicles that match this requirement AND aren't already occupied for
  // this job's date window on a different job.
  const matchingVehicles = useMemo(
    () => findMatchingVehicles(vehicles, requirement, unavailableIds),
    [vehicles, requirement, unavailableIds],
  )

  /**
   * Cascade-link a van to this driver AND to every other hire-form
   * assignment that's on the same job + same van-requirement slot and
   * doesn't yet have a vehicle. Mirrors the van ↔ driver model: a single
   * van carries all the drivers assigned to that slot (typically 2, up to
   * 3+ on longer tours), so staff picks once and all siblings share the
   * vehicle_id.
   */
  async function linkVehicleToHireForm(allocationId: string, vehicle: Vehicle) {
    try {
      setLinking(true)
      const { apiFetch } = await import('../config/api-config')

      const siblingIds = slotAllocations
        .filter(a => a.hireFormLinked && !a.vehicleReg && a.id !== allocationId)
        .map(a => a.id)
      const ids = [allocationId, ...siblingIds]

      for (const id of ids) {
        const resp = await apiFetch(`/api/hire-forms/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicle_id: vehicle.id }),
        })
        if (!resp.ok) {
          const txt = await resp.text().catch(() => 'Unknown error')
          throw new Error(`PATCH failed for ${id}: ${resp.status} ${txt}`)
        }
      }
      // Soft-refresh without full page reload so the user's scroll
      // position stays put after they pick a van.
      refreshAllocationsSoftly()
    } catch (err) {
      console.error('[allocations] Link vehicle to hire form failed:', err)
      alert(err instanceof Error ? err.message : 'Failed to link vehicle')
    } finally {
      setLinking(false)
      setLinkPickerForId(null)
    }
  }

  /**
   * Clear vehicle_id on this driver card AND every sibling driver card
   * sharing the same van slot with the same currently-linked vehicle.
   * Lets staff undo a van pick pre-book-out without touching the
   * driver's hire form itself.
   */
  async function unlinkVehicleFromHireForm(allocationId: string) {
    const anchor = slotAllocations.find(a => a.id === allocationId)
    if (!anchor || !anchor.vehicleId) return
    if (!confirm(`Unlink ${anchor.vehicleReg || 'this van'} from ${anchor.driverName || 'this driver'} and the other drivers on this slot? You'll be able to pick a different van.`)) {
      return
    }

    try {
      setLinking(true)
      const { apiFetch } = await import('../config/api-config')

      // Sibling = same slot, hire-form-created, same vehicleId (so we
      // don't accidentally unlink drivers already moved to another van).
      const siblingIds = slotAllocations
        .filter(a => a.hireFormLinked && a.vehicleId === anchor.vehicleId && a.id !== allocationId)
        .map(a => a.id)
      const ids = [allocationId, ...siblingIds]

      for (const id of ids) {
        const resp = await apiFetch(`/api/hire-forms/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vehicle_id: null }),
        })
        if (!resp.ok) {
          const txt = await resp.text().catch(() => 'Unknown error')
          throw new Error(`PATCH failed for ${id}: ${resp.status} ${txt}`)
        }
      }
      refreshAllocationsSoftly()
    } catch (err) {
      console.error('[allocations] Unlink vehicle from hire form failed:', err)
      alert(err instanceof Error ? err.message : 'Failed to unlink vehicle')
    } finally {
      setLinking(false)
    }
  }

  /**
   * Re-point ONE driver card to a different van — no cascade. Used to
   * distribute drivers across the vans on a multi-van job (e.g. 5 drivers
   * over 2 vans: leave 3 on van A, move 2 onto van B). Deliberately does
   * NOT touch siblings — unlike linkVehicleToHireForm's "pick once, all
   * driverless siblings follow" cascade, which is for the one-van case.
   * Same backend PATCH the link/unlink paths use.
   */
  async function changeVanOnHireForm(allocationId: string, vehicle: Vehicle) {
    try {
      setLinking(true)
      const { apiFetch } = await import('../config/api-config')
      const resp = await apiFetch(`/api/hire-forms/${encodeURIComponent(allocationId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicle_id: vehicle.id }),
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => 'Unknown error')
        throw new Error(`PATCH failed for ${allocationId}: ${resp.status} ${txt}`)
      }
      refreshAllocationsSoftly()
    } catch (err) {
      console.error('[allocations] Change van on hire form failed:', err)
      alert(err instanceof Error ? err.message : 'Failed to change van')
    } finally {
      setLinking(false)
      setChangeVanForId(null)
    }
  }

  return (
    <div className="mt-3 first:mt-0">
      <p className="mb-1.5 text-xs font-medium text-gray-500">
        {slotsNeeded > 1 ? `${slotsNeeded}x ` : ''}{label}
      </p>

      {/* Show allocated slots */}
      {slotAllocations.map(allocation => {
        const allocatedVehicle = vehicles.find(v => v.id === allocation.vehicleId)
        const hireStatus = allocatedVehicle?.hireStatus || ''

        return (
          <div
            key={allocation.id}
            className={`mb-2 rounded-lg border p-2.5 ${
              allocation.status === 'confirmed'
                ? 'border-green-200 bg-green-50'
                : 'border-amber-200 bg-amber-50'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                {allocation.vehicleReg ? (
                  <span className="font-mono text-sm font-bold text-ooosh-navy">{allocation.vehicleReg}</span>
                ) : (
                  <span className="text-xs italic text-gray-500">No van selected yet</span>
                )}
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  allocation.status === 'confirmed'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {allocation.status === 'confirmed' ? 'Confirmed' : 'Soft'}
                </span>
                {/* Hire status badge — suppressed when no vehicle picked
                    (the "Unknown" label was confusing on hire-form cards
                    awaiting vehicle assignment). */}
                {allocation.vehicleReg && (
                  <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    hireStatus === 'Available'
                      ? 'bg-green-100 text-green-700'
                      : hireStatus === 'On Hire'
                        ? 'bg-blue-100 text-blue-700'
                        : hireStatus === 'Not Ready'
                          ? 'bg-red-100 text-red-700'
                          : 'bg-amber-100 text-amber-700'
                  }`}>
                    {hireStatus || 'Unknown'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {allocation.readOnly && allocation.hireFormLinked && (
                  <span className="text-[10px] font-medium text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">
                    Hire Form
                  </span>
                )}
                {/* Unlink van — available on hire-form cards that have a
                    van linked but aren't yet booked out. Cascades the
                    clear to every driver sharing this van on this slot
                    (per van/driver model — 1 van, N drivers).
                    Uses rawStatus because the narrowed `status` field
                    collapses booked_out/active/returned into 'confirmed'. */}
                {allocation.hireFormLinked && allocation.vehicleReg && allocation.rawStatus !== 'booked_out' && allocation.rawStatus !== 'active' && (
                  <button
                    onClick={() => unlinkVehicleFromHireForm(allocation.id)}
                    disabled={linking}
                    className="text-xs font-medium text-red-600 disabled:text-gray-400"
                    title="Unlink this van from all drivers on this slot"
                  >
                    Unlink van
                  </button>
                )}
                {!allocation.readOnly && (
                  <button
                    onClick={() => onRemove(allocation.id)}
                    disabled={saving}
                    className="text-xs font-medium text-red-600 disabled:text-gray-400"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {/* Prep warning for non-Available vehicles */}
            {hireStatus && hireStatus !== 'Available' && (
              <div className={`mt-1.5 flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium ${
                hireStatus === 'On Hire'
                  ? 'bg-blue-50 text-blue-700'
                  : hireStatus === 'Not Ready'
                    ? 'bg-red-50 text-red-700'
                    : 'bg-amber-50 text-amber-700'
              }`}>
                <svg className="h-3 w-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {hireStatus === 'On Hire' ? 'Currently on hire — will need prep when returned' :
                 hireStatus === 'Prep Needed' ? 'Needs prep before booking out' :
                 hireStatus === 'Not Ready' ? 'Vehicle not ready — check issues' :
                 'Status unknown'}
              </div>
            )}

            {/* Driver name — read-only display from linked hire form */}
            {allocation.driverName && (
              <div className="mt-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-green-50 border border-green-200 px-2.5 py-1 text-xs font-medium text-green-700">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  {allocation.driverName}
                </span>
              </div>
            )}

            {/* Hire-form slot without a vehicle yet — inline van picker so
                staff can attach a van for THIS driver without bouncing to
                the Job Detail page. Selecting the van PATCHes the
                assignment and refreshes. */}
            {allocation.hireFormLinked && !allocation.vehicleReg && (
              <div className="mt-2">
                {linkPickerForId === allocation.id ? (
                  <VanPicker
                    vehicles={matchingVehicles}
                    onSelect={(vehicle) => linkVehicleToHireForm(allocation.id, vehicle)}
                    onCancel={() => setLinkPickerForId(null)}
                  />
                ) : (
                  <button
                    onClick={() => setLinkPickerForId(allocation.id)}
                    disabled={linking}
                    className="w-full rounded-lg border-2 border-dashed border-ooosh-navy/30 bg-ooosh-navy/5 py-2 text-xs font-medium text-ooosh-navy active:bg-ooosh-navy/10 disabled:opacity-50"
                  >
                    + Select Van for this driver ({matchingVehicles.length} matching{
                      (() => {
                        const ready = matchingVehicles.filter(v => v.hireStatus === 'Available').length
                        return ready < matchingVehicles.length ? `, ${ready} ready` : ''
                      })()
                    })
                  </button>
                )}
              </div>
            )}

            {/* Multi-van split — move THIS driver to a different van on the
                job without disturbing the others. Only on multi-van jobs
                (slotsNeeded > 1): the 99% single-van case uses unlink+repick.
                Hidden once booked out (the van's physically committed). This
                is what lets staff distribute N drivers across the job's vans
                (e.g. 5 drivers / 2 vans) without DB surgery. */}
            {slotsNeeded > 1 && allocation.hireFormLinked && allocation.vehicleReg &&
              allocation.rawStatus !== 'booked_out' && allocation.rawStatus !== 'active' && (
              <div className="mt-2">
                {changeVanForId === allocation.id ? (
                  <VanPicker
                    vehicles={matchingVehicles}
                    onSelect={(vehicle) => changeVanOnHireForm(allocation.id, vehicle)}
                    onCancel={() => setChangeVanForId(null)}
                  />
                ) : (
                  <button
                    onClick={() => setChangeVanForId(allocation.id)}
                    disabled={linking}
                    className="text-xs font-medium text-ooosh-navy underline disabled:text-gray-400"
                    title="Move this driver to a different van on this job"
                  >
                    Change van
                  </button>
                )}
              </div>
            )}

            {/* Already booked out — swap Book Out for a status pill.
                rawStatus preserves the true DB status (the narrowed `status`
                collapses booked_out/active to 'confirmed'). Without this,
                AllocationsPage kept offering Book Out on vans that were
                already physically out. */}
            {(allocation.rawStatus === 'booked_out' || allocation.rawStatus === 'active') && (
              <div className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-50 border border-indigo-200 py-2 text-xs font-medium text-indigo-700">
                <span aria-hidden>🚐</span>
                <span>{allocation.rawStatus === 'active' ? 'On Hire' : 'Booked Out'}</span>
              </div>
            )}

            {/* Book Out link — soft allocations with a real vehicle selected. */}
            {allocation.status === 'soft' && allocation.vehicleId &&
              allocation.rawStatus !== 'booked_out' && allocation.rawStatus !== 'active' && (
              <Link
                to={vmPath(`/book-out?vehicle=${allocation.vehicleId}&job=${job.id}`)}
                className={`mt-2 block w-full rounded-lg py-2 text-center text-xs font-medium transition-colors ${
                  hireStatus === 'Available'
                    ? 'bg-ooosh-navy text-white active:bg-opacity-90'
                    : 'border border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                {hireStatus === 'Available' ? 'Book Out' : 'Book Out (not prepped)'}
              </Link>
            )}

            {/* Book Out link — confirmed hire-form allocations that now have
                a vehicle linked. Previously the button only showed for
                status='soft' which excluded hire-form-created rows (always
                'confirmed') — staff ended up with no path to book out. */}
            {allocation.status === 'confirmed' && allocation.hireFormLinked && allocation.vehicleId &&
              allocation.rawStatus !== 'booked_out' && allocation.rawStatus !== 'active' && (
              <Link
                to={vmPath(`/book-out?vehicle=${allocation.vehicleId}&job=${job.id}`)}
                className={`mt-2 block w-full rounded-lg py-2 text-center text-xs font-medium transition-colors ${
                  hireStatus === 'Available'
                    ? 'bg-ooosh-navy text-white active:bg-opacity-90'
                    : 'border border-gray-200 bg-gray-50 text-gray-500'
                }`}
              >
                {hireStatus === 'Available' ? 'Book Out' : 'Book Out (not prepped)'}
              </Link>
            )}
          </div>
        )
      })}

      {/* Show "Select Van" if still need more */}
      {slotAllocations.length < slotsNeeded && (
        <>
          {!showPicker ? (
            <button
              onClick={() => setShowPicker(true)}
              className="w-full rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 py-3 text-sm font-medium text-gray-500 active:bg-gray-100"
            >
              + Select Van ({matchingVehicles.length} matching{
                (() => {
                  const ready = matchingVehicles.filter(v => v.hireStatus === 'Available').length
                  return ready < matchingVehicles.length ? `, ${ready} ready` : ''
                })()
              })
            </button>
          ) : (
            <VanPicker
              vehicles={matchingVehicles}
              onSelect={(vehicle) => {
                onAllocate(job, requirementIndex, vehicle, 'Staff')
                setShowPicker(false)
              }}
              onCancel={() => setShowPicker(false)}
            />
          )}
        </>
      )}
    </div>
  )
}

/* ──────────────────────────────────────────────
 * Van Picker — shows matching available vehicles
 * ────────────────────────────────────────────── */

function VanPicker({
  vehicles,
  onSelect,
  onCancel,
}: {
  vehicles: Vehicle[]
  onSelect: (vehicle: Vehicle) => void
  onCancel: () => void
}) {
  const [search, setSearch] = useState('')

  const filtered = vehicles.filter(v => {
    if (!search) return true
    const term = search.toLowerCase()
    return `${v.reg} ${v.make} ${v.model}`.toLowerCase().includes(term)
  })

  const availableCount = vehicles.filter(v => v.hireStatus === 'Available').length

  return (
    <div className="rounded-lg border border-ooosh-navy/20 bg-white p-2 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-gray-500">
          Select a van
          <span className="ml-1 text-green-600">({availableCount} ready)</span>
        </p>
        <button
          onClick={onCancel}
          className="text-xs font-medium text-gray-400"
        >
          Cancel
        </button>
      </div>

      {vehicles.length > 3 && (
        <input
          type="text"
          placeholder="Search reg..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="mb-2 w-full rounded border border-gray-200 px-2 py-1.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none"
          autoFocus
        />
      )}

      {filtered.length === 0 ? (
        <p className="py-3 text-center text-sm text-gray-400">No matching vehicles</p>
      ) : (
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {filtered.map(v => {
            const needsWarning = vehicleNeedsPrepWarning(v)
            const isOnHire = v.hireStatus === 'On Hire'
            const isNotReady = v.hireStatus === 'Not Ready'

            return (
              <button
                key={v.id}
                onClick={() => onSelect(v)}
                className={`flex w-full items-center justify-between rounded-lg border p-2 text-left active:bg-gray-50 ${
                  needsWarning
                    ? isOnHire
                      ? 'border-blue-200 bg-blue-50/50'
                      : isNotReady
                        ? 'border-red-200 bg-red-50/50'
                        : 'border-amber-200 bg-amber-50/50'
                    : 'border-gray-200'
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
                    {needsWarning && (
                      <svg className={`h-4 w-4 shrink-0 ${
                        isOnHire ? 'text-blue-500' : isNotReady ? 'text-red-500' : 'text-amber-500'
                      }`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    )}
                  </div>
                  <p className="text-xs text-gray-500">
                    {v.simpleType} {getVehicleGearboxLabel(v)} · {v.make}
                  </p>
                </div>
                <span className={`shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                  v.hireStatus === 'Available'
                    ? 'bg-green-100 text-green-700'
                    : isOnHire
                      ? 'bg-blue-100 text-blue-700'
                      : isNotReady
                        ? 'bg-red-100 text-red-700'
                        : 'bg-amber-100 text-amber-700'
                }`}>
                  {v.hireStatus || 'Unknown'}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Format YYYY-MM-DD to a short display format */
function formatDisplayDate(dateStr: string): string {
  if (!dateStr || dateStr.length < 10) return '—'
  const date = new Date(dateStr + 'T00:00:00')
  if (isNaN(date.getTime())) return '—'

  const today = new Date()
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)

  if (date.toDateString() === today.toDateString()) return 'Today'
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow'

  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
