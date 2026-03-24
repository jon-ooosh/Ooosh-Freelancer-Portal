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

import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useUpcomingJobs, useUpcomingDueBackJobs } from '../hooks/useHireHopJobs'
import { HireHopCacheStatus } from '../components/HireHopCacheStatus'
import { useVehicles } from '../hooks/useVehicles'
import { useAllocations, useSaveAllocations } from '../hooks/useAllocations'
import { useDriverHireForms } from '../hooks/useDriverHireForms'
import { extractVanRequirements } from '../lib/hirehop-api'
import { findMatchingVehicles, formatVanType, getVehicleGearboxLabel, vehicleNeedsPrepWarning } from '../lib/van-matching'
import type { HireHopJob, VanAllocation, VanRequirement } from '../types/hirehop'
import type { DriverHireForm } from '../lib/driver-hire-api'
import type { Vehicle } from '../types/vehicle'

type DateFilter = 'today' | 'tomorrow' | 'this-week' | 'all'
type ViewMode = 'going-out' | 'due-back'

/** How many days ahead the allocations page looks */
const ALLOCATIONS_DAYS_AHEAD = 14

/** Debounced driver name input — saves on blur or after 800ms idle, not on every keystroke */
function DebouncedDriverInput({
  allocationId,
  initialValue,
  onSave,
}: {
  allocationId: string
  initialValue: string
  onSave: (allocationId: string, driverName: string) => void
}) {
  const [localValue, setLocalValue] = useState(initialValue)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const savedRef = useRef(initialValue)

  // Sync from parent when server data changes (e.g. after initial load)
  useEffect(() => {
    if (initialValue !== savedRef.current) {
      setLocalValue(initialValue)
      savedRef.current = initialValue
    }
  }, [initialValue])

  const doSave = useCallback((value: string) => {
    if (value !== savedRef.current) {
      savedRef.current = value
      onSave(allocationId, value)
    }
  }, [allocationId, onSave])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    setLocalValue(val)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => doSave(val), 800)
  }, [doSave])

  const handleBlur = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    doSave(localValue)
  }, [localValue, doSave])

  return (
    <input
      type="text"
      placeholder="Driver name"
      value={localValue}
      onChange={handleChange}
      onBlur={handleBlur}
      className="w-full rounded border border-gray-200 bg-white px-2 py-1.5 text-sm placeholder:text-gray-400 focus:border-ooosh-navy focus:outline-none focus:ring-1 focus:ring-ooosh-navy"
    />
  )
}

export function AllocationsPage() {
  const [searchParams] = useSearchParams()
  const focusJobId = searchParams.get('job') ? parseInt(searchParams.get('job')!, 10) : null

  const [dateFilter, setDateFilter] = useState<DateFilter>('this-week')
  const [viewMode, setViewMode] = useState<ViewMode>('going-out')

  const { data: upcomingJobs, isLoading: upcomingLoading, error: upcomingError } = useUpcomingJobs(ALLOCATIONS_DAYS_AHEAD)
  const { data: dueBackJobs, isLoading: dueBackLoading, error: dueBackError } = useUpcomingDueBackJobs(ALLOCATIONS_DAYS_AHEAD)
  const { data: allVehicles } = useVehicles()
  const { data: allocations, isLoading: allocationsLoading } = useAllocations()
  const saveAllocations = useSaveAllocations()

  const allocationsList = allocations || []

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
      // But keep jobs where items couldn't be fetched (e.g. dispatched jobs return error 327)
      if (!job.itemsFetchFailed && extractVanRequirements(job).length === 0) return false

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
    const updated = allocationsList.filter(a => a.id !== allocationId)
    saveAllocations.mutate(updated)
  }, [allocationsList, saveAllocations])

  const handleUpdateDriver = useCallback(async (allocationId: string, driverName: string) => {
    const updated = allocationsList.map(a =>
      a.id === allocationId ? { ...a, driverName: driverName || null } : a,
    )
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
      <HireHopCacheStatus />

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

      {/* Date filter pills */}
      <div className="flex gap-2">
        {([
          { key: 'today' as DateFilter, label: 'Today' },
          { key: 'tomorrow' as DateFilter, label: 'Tomorrow' },
          { key: 'this-week' as DateFilter, label: 'This Week' },
          { key: 'all' as DateFilter, label: 'Next 2 Weeks' },
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
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-8 text-center text-sm text-gray-400">
          No jobs {viewMode === 'going-out' ? 'going out' : 'due back'}{' '}
          {dateFilter === 'today' ? 'today' : dateFilter === 'tomorrow' ? 'tomorrow' : dateFilter === 'this-week' ? 'this week' : 'in the next 2 weeks'}
        </div>
      ) : (
        <div className="space-y-4">
          {filteredJobs.map(job => (
            <JobAllocationCard
              key={job.id}
              job={job}
              allocations={allocationsList}
              vehicles={activeVehicles}
              defaultExpanded={focusJobId === job.id}
              viewMode={viewMode}
              onAllocate={handleAllocateVan}
              onRemove={handleRemoveAllocation}
              onUpdateDriver={handleUpdateDriver}
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
  onUpdateDriver,
  saving,
}: {
  job: HireHopJob
  allocations: VanAllocation[]
  vehicles: Vehicle[]
  defaultExpanded: boolean
  viewMode: ViewMode
  onAllocate: (job: HireHopJob, reqIndex: number, vehicle: Vehicle, staffName: string) => void
  onRemove: (allocationId: string) => void
  onUpdateDriver: (allocationId: string, driverName: string) => void
  saving: boolean
}) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const requirements = extractVanRequirements(job)
  const jobAllocations = allocations.filter(a => a.hireHopJobId === job.id)
  const totalNeeded = requirements.reduce((sum, r) => sum + r.quantity, 0)
  const assignedCount = jobAllocations.length

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
    <div className={`rounded-lg border ${borderColour} bg-white`}>
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
              allAllocations={allocations}
              vehicles={vehicles}
              hireForms={hireForms || []}
              onAllocate={onAllocate}
              onRemove={onRemove}
              onUpdateDriver={onUpdateDriver}
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
                    <button
                      onClick={() => onRemove(allocation.id)}
                      disabled={saving}
                      className="text-xs font-medium text-red-600 disabled:text-gray-400"
                    >
                      Remove
                    </button>
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
  allAllocations,
  vehicles,
  hireForms,
  onAllocate,
  onRemove,
  onUpdateDriver,
  saving,
}: {
  job: HireHopJob
  requirement: VanRequirement
  requirementIndex: number
  allocations: VanAllocation[]
  allAllocations: VanAllocation[]
  vehicles: Vehicle[]
  hireForms: DriverHireForm[]
  onAllocate: (job: HireHopJob, reqIndex: number, vehicle: Vehicle, staffName: string) => void
  onRemove: (allocationId: string) => void
  onUpdateDriver: (allocationId: string, driverName: string) => void
  saving: boolean
}) {
  const [showPicker, setShowPicker] = useState(false)

  const label = formatVanType(requirement.simpleType, requirement.gearbox)
  const slotsNeeded = requirement.quantity

  // Allocations for this specific requirement index
  const slotAllocations = jobAllocations.filter(a => a.vanRequirementIndex === requirementIndex)

  // Available vehicles that match this requirement (excluding all already-allocated)
  const matchingVehicles = useMemo(
    () => findMatchingVehicles(vehicles, requirement, allAllocations),
    [vehicles, requirement, allAllocations],
  )

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
                <span className="font-mono text-sm font-bold text-ooosh-navy">{allocation.vehicleReg}</span>
                <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  allocation.status === 'confirmed'
                    ? 'bg-green-100 text-green-700'
                    : 'bg-amber-100 text-amber-700'
                }`}>
                  {allocation.status === 'confirmed' ? 'Confirmed' : 'Soft'}
                </span>
                {/* Hire status badge */}
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
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => onRemove(allocation.id)}
                  disabled={saving}
                  className="text-xs font-medium text-red-600 disabled:text-gray-400"
                >
                  Remove
                </button>
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

            {/* Book Out link — only for soft allocations when vehicle is available */}
            {allocation.status === 'soft' && (
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
