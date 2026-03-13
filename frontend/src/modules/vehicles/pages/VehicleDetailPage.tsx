import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useVehicle } from '../hooks/useVehicles'
import { useVehicleIssues } from '../hooks/useVehicleIssues'
import { useVehicleTracker, useUpdateTrackerAssignment } from '../hooks/useTrackerAssignments'
import { IssueCard } from '../components/issues/IssueCard'
import { getDateUrgency } from '../types/vehicle'
import type { DateUrgency } from '../types/vehicle'
import { VehicleLocationTab } from '../components/tracking/VehicleLocationTab'
import { PrepHistoryTab } from '../components/prep/PrepHistoryTab'
import { updateVehicle } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'

const urgencyColours: Record<DateUrgency, string> = {
  ok: 'text-green-700 bg-green-50',
  soon: 'text-amber-700 bg-amber-50',
  overdue: 'text-red-700 bg-red-50',
  unknown: 'text-gray-400 bg-gray-50',
}

const urgencyLabels: Record<DateUrgency, string> = {
  ok: 'OK',
  soon: 'Due soon',
  overdue: 'Overdue',
  unknown: 'Not set',
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function formatMileage(m: number | null): string {
  if (m == null) return '—'
  return m.toLocaleString('en-GB')
}

/** Status badge used throughout the detail page */
function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  )
}

/** A row in the info grid */
function InfoRow({ label, value, className = '' }: { label: string; value: React.ReactNode; className?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className={`text-sm font-medium text-gray-900 ${className}`}>{value || '—'}</span>
    </div>
  )
}

/** A date row with urgency colouring */
function DateRow({ label, date, warningDays = 30 }: { label: string; date: string | null; warningDays?: number }) {
  const urgency = getDateUrgency(date, warningDays)
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-gray-900">{formatDate(date)}</span>
        <Badge className={urgencyColours[urgency]}>{urgencyLabels[urgency]}</Badge>
      </div>
    </div>
  )
}

export function VehicleDetailPage() {
  const { id } = useParams()
  const { data: vehicle, isLoading, isError } = useVehicle(id)
  const { data: vehicleIssues } = useVehicleIssues(vehicle?.reg)
  const { trackerNumber } = useVehicleTracker(vehicle?.reg)
  const { assign: assignTracker, isSaving: isAssigningTracker } = useUpdateTrackerAssignment()
  const [activeTab, setActiveTab] = useState<'details' | 'location' | 'preps'>('details')
  const [editingTracker, setEditingTracker] = useState(false)
  const [trackerInput, setTrackerInput] = useState('')
  const [isSelling, setIsSelling] = useState(false)
  const queryClient = useQueryClient()
  const opAuth = getOpAuthState()
  const isAdmin = opAuth?.userRole === 'admin' || opAuth?.userRole === 'manager'

  const handleToggleSold = async () => {
    if (!vehicle) return
    const newGroup = vehicle.isOldSold ? 'active' : 'old_sold'
    const confirmMsg = vehicle.isOldSold
      ? `Reactivate ${vehicle.reg} and return it to the active fleet?`
      : `Mark ${vehicle.reg} as Old & Sold? It will be moved out of the active fleet.`
    if (!window.confirm(confirmMsg)) return

    setIsSelling(true)
    try {
      await updateVehicle(vehicle.id, {
        fleet_group: newGroup,
        is_active: newGroup === 'active',
      })
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update vehicle')
    } finally {
      setIsSelling(false)
    }
  }

  const openIssues = useMemo(
    () => (vehicleIssues || []).filter(i => i.status !== 'Resolved'),
    [vehicleIssues],
  )

  const resolvedIssues = useMemo(
    () => (vehicleIssues || []).filter(i => i.status === 'Resolved'),
    [vehicleIssues],
  )

  if (isLoading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-8 w-32 rounded bg-gray-200" />
        <div className="rounded-lg border border-gray-200 bg-white p-6">
          <div className="h-6 w-48 rounded bg-gray-200" />
          <div className="mt-4 space-y-3">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-4 rounded bg-gray-100" />
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (isError || !vehicle) {
    return (
      <div className="space-y-4">
        <Link to={vmPath('/vehicles')} className="text-sm text-ooosh-blue hover:underline">
          &larr; Back to vehicles
        </Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          Vehicle not found
        </div>
      </div>
    )
  }

  // Damage status styling
  const damageStyles: Record<string, string> = {
    'ALL GOOD': 'bg-green-100 text-green-800',
    'BOOK REPAIR!': 'bg-amber-100 text-amber-800',
    'QUOTE NEEDED': 'bg-red-100 text-red-800',
    'REPAIR BOOKED': 'bg-indigo-100 text-indigo-800',
  }

  const serviceStyles: Record<string, string> = {
    'OK': 'bg-green-100 text-green-800',
    'SERVICE BOOKED': 'bg-amber-100 text-amber-800',
    'SERVICE DUE!': 'bg-red-100 text-red-800',
    'SERVICE DUE SOON': 'bg-blue-100 text-blue-800',
    'CHECK': 'bg-yellow-100 text-yellow-800',
  }

  const typeStyles: Record<string, string> = {
    Premium: 'bg-indigo-100 text-indigo-800',
    Basic: 'bg-sky-100 text-sky-800',
    Panel: 'bg-gray-100 text-gray-700',
    Vito: 'bg-slate-100 text-slate-700',
  }

  return (
    <div className="space-y-4">
      {/* Back link */}
      <Link to={vmPath('/vehicles')} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to vehicles
      </Link>

      {/* Header card */}
      <div className={`rounded-lg border bg-white p-4 ${vehicle.isOldSold ? 'border-orange-200' : 'border-gray-200'}`}>
        {vehicle.isOldSold && (
          <div className="mb-2 rounded bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 text-center">
            Old &amp; Sold — this vehicle is no longer in the active fleet
          </div>
        )}
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-2xl font-bold text-ooosh-navy">{vehicle.reg}</h2>
            <p className="mt-0.5 text-sm text-gray-500">{vehicle.model || vehicle.vehicleType}</p>
            <p className="text-sm text-gray-400">{vehicle.make} · {vehicle.colour}</p>
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <Badge className={typeStyles[vehicle.simpleType] || 'bg-gray-100 text-gray-600'}>
              {vehicle.simpleType || vehicle.vehicleType}
            </Badge>
            {vehicle.seats && (
              <span className="text-xs text-gray-400">{vehicle.seats} seats</span>
            )}
          </div>
        </div>

        {/* Status row */}
        <div className="mt-3 flex flex-wrap gap-2">
          {vehicle.damageStatus && (
            <Badge className={damageStyles[vehicle.damageStatus] || 'bg-gray-100 text-gray-600'}>
              {vehicle.damageStatus}
            </Badge>
          )}
          {vehicle.serviceStatus && (
            <Badge className={serviceStyles[vehicle.serviceStatus] || 'bg-gray-100 text-gray-600'}>
              {vehicle.serviceStatus}
            </Badge>
          )}
          {vehicle.ulezCompliant && (
            <Badge className="bg-green-100 text-green-800">ULEZ OK</Badge>
          )}
          {vehicle.spareKey && (
            <Badge className="bg-gray-100 text-gray-600">Spare key</Badge>
          )}
        </div>

        {/* Admin actions */}
        {isAdmin && (
          <div className="mt-3 flex gap-2 border-t border-gray-100 pt-3">
            <button
              type="button"
              onClick={handleToggleSold}
              disabled={isSelling}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                vehicle.isOldSold
                  ? 'border border-green-200 text-green-700 hover:bg-green-50'
                  : 'border border-orange-200 text-orange-700 hover:bg-orange-50'
              } disabled:opacity-50`}
            >
              {isSelling ? 'Updating...' : vehicle.isOldSold ? 'Reactivate Vehicle' : 'Mark as Sold'}
            </button>
          </div>
        )}
      </div>

      {/* Quick actions — hidden for old/sold vehicles */}
      {!vehicle.isOldSold && (
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Book Out', to: vmPath(`/book-out?vehicle=${vehicle.id}`) },
            { label: 'Check In', to: vmPath(`/check-in?vehicle=${vehicle.id}`) },
            { label: 'Log Issue', to: vmPath(`/issues/new?vehicle=${vehicle.id}`) },
          ].map(action => (
            <Link
              key={action.label}
              to={action.to}
              className="rounded-lg border border-gray-200 bg-white py-2.5 text-center text-sm font-medium text-ooosh-navy shadow-sm hover:bg-gray-50 active:bg-gray-100"
            >
              {action.label}
            </Link>
          ))}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 rounded-lg bg-gray-100 p-1">
        {(['details', 'preps', 'location'] as const).map(tab => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? 'bg-white text-ooosh-navy shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab === 'details' ? 'Details' : tab === 'preps' ? 'Prep History' : 'Location'}
          </button>
        ))}
      </div>

      {/* Location tab */}
      {activeTab === 'location' && (
        <VehicleLocationTab reg={vehicle.reg} />
      )}

      {/* Prep History tab */}
      {activeTab === 'preps' && (
        <PrepHistoryTab vehicleReg={vehicle.reg} />
      )}

      {/* Details tab */}
      {activeTab === 'details' && <>

      {/* Key Dates */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Key Dates</h3>
        <DateRow label="MOT Due" date={vehicle.motDue} />
        <DateRow label="Tax Due" date={vehicle.taxDue} />
        {vehicle.tflDue && <DateRow label="TFL Due" date={vehicle.tflDue} />}
        <DateRow label="Warranty Expires" date={vehicle.warrantyExpires} />
        <InfoRow label="Last Service" value={formatDate(vehicle.lastServiceDate)} />
        {vehicle.financeEnds && <DateRow label="Finance Ends" date={vehicle.financeEnds} />}
      </div>

      {/* Mileage & Service */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Service & Mileage</h3>
        <InfoRow label="Last Service Mileage" value={formatMileage(vehicle.lastServiceMileage)} />
        <InfoRow label="Next Service Due" value={vehicle.nextServiceDue ? `${formatMileage(vehicle.nextServiceDue)} miles` : '—'} />
      </div>

      {/* Other Info */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Other Info</h3>
        {/* Tracker number — inline editable */}
        <div className="flex items-center justify-between py-2 border-b border-gray-100">
          <span className="text-sm text-gray-500">GPS Tracker</span>
          {editingTracker ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={trackerInput}
                onChange={e => setTrackerInput(e.target.value)}
                placeholder="Tracker #"
                className="w-20 rounded border border-gray-200 px-2 py-1 text-sm text-right focus:border-blue-300 focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                disabled={isAssigningTracker}
                onClick={async () => {
                  if (vehicle) {
                    await assignTracker(vehicle.reg, trackerInput.trim() || null)
                    setEditingTracker(false)
                  }
                }}
                className="rounded bg-ooosh-navy px-2 py-1 text-xs font-medium text-white hover:bg-ooosh-navy/90"
              >
                {isAssigningTracker ? '...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setEditingTracker(false)}
                className="rounded px-2 py-1 text-xs text-gray-400 hover:text-gray-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-gray-900">
                {trackerNumber ? `#${trackerNumber}` : 'Not fitted'}
              </span>
              <button
                type="button"
                onClick={() => {
                  setTrackerInput(trackerNumber || '')
                  setEditingTracker(true)
                }}
                className="rounded px-1.5 py-0.5 text-[10px] text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                Edit
              </button>
            </div>
          )}
        </div>
        <InfoRow label="Wifi Network" value={vehicle.wifiNetwork} />
        <InfoRow label="Finance With" value={vehicle.financeWith} />
        <InfoRow label="ULEZ Compliant" value={vehicle.ulezCompliant ? 'Yes' : 'No'} />
        <InfoRow label="Spare Key" value={vehicle.spareKey ? 'Yes' : 'No'} />
      </div>

      {/* Event History placeholder */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Event History</h3>
        <p className="text-sm text-gray-400 text-center py-4">
          Event history will appear here once book-outs, check-ins, and prep events are recorded.
        </p>
      </div>

      {/* Issues */}
      <VehicleIssuesSection
        vehicleId={vehicle.id}
        openIssues={openIssues}
        resolvedIssues={resolvedIssues}
      />

      </>}
    </div>
  )
}

/** Full issues section for vehicle detail — shows open, then resolved (collapsible) */
function VehicleIssuesSection({
  vehicleId,
  openIssues,
  resolvedIssues,
}: {
  vehicleId: string
  openIssues: import('../types/issue').VehicleIssue[]
  resolvedIssues: import('../types/issue').VehicleIssue[]
}) {
  const [showResolved, setShowResolved] = useState(false)
  const totalIssues = openIssues.length + resolvedIssues.length

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Issues {totalIssues > 0 && <span className="normal-case text-gray-400">({totalIssues})</span>}
        </h3>
        <Link to={vmPath(`/issues/new?vehicle=${vehicleId}`)} className="text-xs font-medium text-blue-600">
          Log issue →
        </Link>
      </div>

      {totalIssues === 0 ? (
        <p className="text-sm text-gray-400 text-center py-4">No issues recorded</p>
      ) : (
        <div className="space-y-2">
          {/* Open issues */}
          {openIssues.length > 0 && (
            <>
              <p className="text-[11px] font-medium uppercase tracking-wide text-amber-600">
                Open ({openIssues.length})
              </p>
              {openIssues.map(issue => (
                <IssueCard key={issue.id} issue={issue} compact />
              ))}
            </>
          )}

          {/* Resolved issues (collapsible) */}
          {resolvedIssues.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setShowResolved(!showResolved)}
                className="mt-1 flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-wide text-green-600"
              >
                <span>Resolved ({resolvedIssues.length})</span>
                <span className="text-gray-400">{showResolved ? 'Hide' : 'Show'}</span>
              </button>
              {showResolved && resolvedIssues.map(issue => (
                <IssueCard key={issue.id} issue={issue} compact />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  )
}
