/**
 * New Issue page — full issue creation form.
 *
 * Flow: Vehicle picker → Category → Component → Severity → Summary → Details
 * Pre-fills vehicle from ?vehicle={id} URL param.
 */

import { useState, useMemo, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import { useQueryClient } from '@tanstack/react-query'
import { useVehicles } from '../hooks/useVehicles'
import { useTraccarDevice, useTraccarPosition } from '../hooks/useTraccar'
import { getAllocations } from '../lib/allocations-api'
import { knotsToMph } from '../types/traccar'
import { saveIssue } from '../lib/issues-r2-api'
import { uploadIssuePhotos } from '../lib/photo-upload'
import {
  ISSUE_CATEGORIES,
  COMPONENTS_BY_CATEGORY,
  ISSUE_SEVERITIES,
  ISSUE_CONTEXTS,
  SEVERITY_STYLES,
} from '../config/issue-options'
import type {
  IssueCategory,
  IssueComponent,
  IssueSeverity,
  IssueContext,
  VehicleIssue,
  IssueLocation,
} from '../types/issue'
import type { Vehicle } from '../types/vehicle'

function PillPicker<T extends string>({
  label,
  options,
  value,
  onChange,
  styleMap,
  columns = 2,
}: {
  label: string
  options: T[]
  value: T | null
  onChange: (v: T) => void
  styleMap?: Record<string, string>
  columns?: number
}) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </label>
      <div className={`grid gap-2 ${columns === 2 ? 'grid-cols-2' : columns === 3 ? 'grid-cols-3' : 'grid-cols-4'}`}>
        {options.map((opt) => {
          const isSelected = value === opt
          const customStyle = isSelected && styleMap?.[opt]
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                customStyle
                  ? `${customStyle} ring-2 ring-offset-1 ring-current`
                  : isSelected
                    ? 'bg-ooosh-navy text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function VehiclePicker({
  vehicles,
  selectedId,
  onSelect,
}: {
  vehicles: Vehicle[]
  selectedId: string | null
  onSelect: (v: Vehicle) => void
}) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    const active = vehicles.filter(v => !v.isOldSold)
    if (!search) return active
    const term = search.toLowerCase()
    return active.filter(v =>
      `${v.reg} ${v.make} ${v.model} ${v.simpleType}`.toLowerCase().includes(term),
    )
  }, [vehicles, search])

  const selected = vehicles.find(v => v.id === selectedId)

  if (selected) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-green-200 bg-green-50 p-3">
        <div>
          <span className="font-mono text-sm font-bold text-ooosh-navy">{selected.reg}</span>
          <p className="text-xs text-gray-500">{selected.simpleType} · {selected.make} {selected.model}</p>
        </div>
        <button
          type="button"
          onClick={() => onSelect({ ...selected, id: '' } as Vehicle)}
          className="text-xs font-medium text-gray-500 hover:text-gray-700"
        >
          Change
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search by reg, make, model..."
        className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
      <div className="max-h-[60vh] space-y-1 overflow-y-auto">
        {filtered.slice(0, 20).map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => onSelect(v)}
            className="flex w-full items-center justify-between rounded-lg border border-gray-200 bg-white p-2 text-left active:bg-gray-50"
          >
            <div>
              <span className="font-mono text-sm font-bold text-ooosh-navy">{v.reg}</span>
              <p className="text-xs text-gray-500">{v.simpleType} · {v.make}</p>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="py-4 text-center text-xs text-gray-400">No vehicles found</p>
        )}
      </div>
    </div>
  )
}

export function NewIssuePage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const { data: allVehicles, isLoading: vehiclesLoading } = useVehicles()

  // Form state
  const [selectedVehicle, setSelectedVehicle] = useState<Vehicle | null>(null)
  const [category, setCategory] = useState<IssueCategory | null>(null)
  const [component, setComponent] = useState<IssueComponent | null>(null)
  const [severity, setSeverity] = useState<IssueSeverity | null>(null)
  const [summary, setSummary] = useState('')
  const [reportedBy, setReportedBy] = useState('')
  const [reportedDuring, setReportedDuring] = useState<IssueContext | null>(null)
  const [mileage, setMileage] = useState('')
  const [hireHopJob, setHireHopJob] = useState('')
  const [initialNote, setInitialNote] = useState('')
  const [photos, setPhotos] = useState<File[]>([])
  const [isSaving, setIsSaving] = useState(false)
  const [capturedLocation, setCapturedLocation] = useState<IssueLocation | null>(null)

  // Traccar GPS — auto-capture location when vehicle is selected
  const { data: traccarDevice } = useTraccarDevice(selectedVehicle?.reg)
  const { data: traccarPosition } = useTraccarPosition(traccarDevice?.id)

  // Auto-capture location when position arrives
  useEffect(() => {
    if (traccarPosition && !capturedLocation) {
      setCapturedLocation({
        lat: traccarPosition.latitude,
        lng: traccarPosition.longitude,
        speed: knotsToMph(traccarPosition.speed),
        ignition: traccarPosition.attributes?.ignition,
        capturedAt: traccarPosition.fixTime,
      })
    }
  }, [traccarPosition, capturedLocation])

  // Auto-populate HireHop job from current allocation
  useEffect(() => {
    if (!selectedVehicle || hireHopJob) return
    getAllocations().then(allocations => {
      const match = allocations.find(a => a.vehicleReg === selectedVehicle.reg)
      if (match) {
        setHireHopJob(String(match.hireHopJobId))
      }
    }).catch(() => {})
  }, [selectedVehicle, hireHopJob])

  // Pre-fill vehicle from URL param
  const prefilledVehicleId = searchParams.get('vehicle')
  const vehicles = allVehicles || []

  // Auto-select vehicle from URL param
  if (prefilledVehicleId && !selectedVehicle && vehicles.length > 0) {
    const found = vehicles.find(v => v.id === prefilledVehicleId)
    if (found) {
      // Use setTimeout to avoid setState during render
      setTimeout(() => setSelectedVehicle(found), 0)
    }
  }

  // Reset component when category changes
  const availableComponents = category ? COMPONENTS_BY_CATEGORY[category] : []

  const handleCategoryChange = (newCat: IssueCategory) => {
    setCategory(newCat)
    setComponent(null) // reset component when category changes
  }

  const handleVehicleSelect = (v: Vehicle) => {
    if (!v.id) {
      setSelectedVehicle(null)
    } else {
      setSelectedVehicle(v)
    }
    // Reset auto-captured data when vehicle changes
    setCapturedLocation(null)
    setHireHopJob('')
  }

  const canSubmit = selectedVehicle && category && component && severity && summary.trim() && reportedBy.trim() && reportedDuring && !isSaving

  const handleSubmit = async () => {
    if (!canSubmit || !selectedVehicle) return
    setIsSaving(true)

    try {
      const issueId = crypto.randomUUID()
      const now = new Date().toISOString()

      // Upload photos first (if any)
      let photoUrls: string[] = []
      if (photos.length > 0) {
        const blobs = photos.map(f => f as Blob)
        const uploadResult = await uploadIssuePhotos(blobs, issueId, selectedVehicle.reg)
        photoUrls = uploadResult.urls
      }

      const issue: VehicleIssue = {
        id: issueId,
        vehicleReg: selectedVehicle.reg,
        vehicleId: selectedVehicle.id,
        vehicleMake: selectedVehicle.make,
        vehicleModel: selectedVehicle.model,
        vehicleType: selectedVehicle.simpleType || selectedVehicle.vehicleType,
        mileageAtReport: mileage ? parseInt(mileage, 10) : null,
        hireHopJob: hireHopJob.trim() || null,
        location: capturedLocation,
        category,
        component,
        severity,
        summary: summary.trim(),
        status: 'Open',
        reportedBy: reportedBy.trim(),
        reportedAt: now,
        reportedDuring,
        resolvedAt: null,
        photos: photoUrls,
        activity: [
          {
            id: crypto.randomUUID(),
            timestamp: now,
            author: reportedBy.trim(),
            action: 'Reported',
            note: initialNote.trim(),
          },
        ],
      }

      // Save to R2
      const result = await saveIssue(issue)

      if (result.success) {
        // Invalidate caches
        await queryClient.invalidateQueries({ queryKey: ['vehicle-issues', selectedVehicle.reg] })
        await queryClient.invalidateQueries({ queryKey: ['all-issues'] })

        navigate(`/issues/${encodeURIComponent(selectedVehicle.reg)}/${issueId}`)
      } else {
        console.error('[NewIssuePage] Save failed:', result.error)
        setIsSaving(false)
      }
    } catch (err) {
      console.error('[NewIssuePage] Error:', err)
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <Link to={vmPath('/issues')} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to issues
      </Link>

      <h2 className="text-xl font-semibold text-ooosh-navy">Log Issue</h2>

      {/* Vehicle picker */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-gray-500">Vehicle</h3>
        {vehiclesLoading ? (
          <div className="h-12 animate-pulse rounded-lg bg-gray-100" />
        ) : (
          <VehiclePicker
            vehicles={vehicles}
            selectedId={selectedVehicle?.id || null}
            onSelect={handleVehicleSelect}
          />
        )}
      </div>

      {/* Auto-captured context — GPS + job */}
      {selectedVehicle && (capturedLocation || hireHopJob) && (
        <div className="flex flex-wrap gap-2 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700">
          {capturedLocation && (
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              GPS location captured
              {capturedLocation.speed != null && capturedLocation.speed > 0 && (
                <span className="text-blue-500">({capturedLocation.speed} mph)</span>
              )}
            </span>
          )}
          {hireHopJob && (
            <span className="flex items-center gap-1">
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Job #{hireHopJob} (auto-detected)
            </span>
          )}
        </div>
      )}

      {/* Category */}
      {selectedVehicle && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <PillPicker
            label="Category"
            options={ISSUE_CATEGORIES}
            value={category}
            onChange={handleCategoryChange}
          />
        </div>
      )}

      {/* Component */}
      {category && availableComponents.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <PillPicker
            label="Component"
            options={availableComponents}
            value={component}
            onChange={setComponent}
            columns={3}
          />
        </div>
      )}

      {/* Severity */}
      {component && (
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <PillPicker
            label="Severity"
            options={ISSUE_SEVERITIES}
            value={severity}
            onChange={setSeverity}
            styleMap={SEVERITY_STYLES}
            columns={4}
          />
        </div>
      )}

      {/* Summary + details */}
      {severity && (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Summary
            </label>
            <input
              type="text"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="Brief description of the issue"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Reported By
            </label>
            <input
              type="text"
              value={reportedBy}
              onChange={(e) => setReportedBy(e.target.value)}
              placeholder="Your name"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>

          <PillPicker
            label="Reported During"
            options={ISSUE_CONTEXTS}
            value={reportedDuring}
            onChange={setReportedDuring}
            columns={3}
          />

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Mileage at Report <span className="text-gray-400 normal-case">(optional)</span>
            </label>
            <input
              type="number"
              value={mileage}
              onChange={(e) => setMileage(e.target.value)}
              placeholder="Current mileage"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              HireHop Job Number <span className="text-gray-400 normal-case">(optional)</span>
            </label>
            <input
              type="text"
              value={hireHopJob}
              onChange={(e) => setHireHopJob(e.target.value)}
              placeholder="e.g. 12345"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Initial Note <span className="text-gray-400 normal-case">(optional)</span>
            </label>
            <textarea
              value={initialNote}
              onChange={(e) => setInitialNote(e.target.value)}
              placeholder="Any extra detail — what happened, when, symptoms..."
              rows={3}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm placeholder-gray-400 focus:border-blue-300 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>

          {/* Photo capture */}
          <div>
            <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-gray-500">
              Photos <span className="text-gray-400 normal-case">(optional)</span>
            </label>
            <input
              type="file"
              accept="image/*"
              multiple
              capture="environment"
              onChange={(e) => {
                const files = Array.from(e.target.files || [])
                setPhotos(prev => [...prev, ...files])
                e.target.value = '' // reset so same file can be re-added
              }}
              className="w-full text-sm text-gray-500 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-gray-700 hover:file:bg-gray-200"
            />
            {photos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((file, i) => (
                  <div key={i} className="relative">
                    <img
                      src={URL.createObjectURL(file)}
                      alt={`Photo ${i + 1}`}
                      className="h-16 w-16 rounded-lg border border-gray-200 object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                      className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white shadow"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Submit */}
      {severity && (
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className={`w-full rounded-lg py-3 text-sm font-semibold text-white transition-colors ${
            canSubmit
              ? 'bg-ooosh-navy hover:bg-ooosh-navy/90 active:bg-ooosh-navy/80'
              : 'bg-gray-300 cursor-not-allowed'
          }`}
        >
          {isSaving ? 'Saving...' : 'Log Issue'}
        </button>
      )}
    </div>
  )
}
