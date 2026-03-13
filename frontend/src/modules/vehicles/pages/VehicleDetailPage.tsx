import { useState, useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useVehicle } from '../hooks/useVehicles'
import { useVehicleIssues } from '../hooks/useVehicleIssues'
import { useVehicleTracker, useUpdateTrackerAssignment } from '../hooks/useTrackerAssignments'
import { IssueCard } from '../components/issues/IssueCard'
import { VehicleLocationTab } from '../components/tracking/VehicleLocationTab'
import { PrepHistoryTab } from '../components/prep/PrepHistoryTab'
import ServiceHistoryTab from '../components/service/ServiceHistoryTab'
import { updateVehicle } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/** Status badge used throughout the detail page */
function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>
      {children}
    </span>
  )
}

/** Editable row — click to edit inline, save on blur or Enter */
function EditableRow({
  label,
  value,
  type = 'text',
  options,
  onSave,
}: {
  label: string
  value: string | number | boolean | null
  type?: 'text' | 'date' | 'number' | 'select' | 'toggle'
  options?: string[]
  onSave: (newValue: string | number | boolean | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const displayValue = type === 'toggle'
    ? (value ? 'Yes' : 'No')
    : type === 'date'
      ? formatDate(value as string | null)
      : value != null ? String(value) : '—'

  const startEdit = () => {
    if (type === 'toggle') {
      onSave(!value)
      return
    }
    setEditValue(value != null ? String(value) : '')
    setEditing(true)
  }

  const save = () => {
    setEditing(false)
    if (type === 'number') {
      onSave(editValue ? Number(editValue) : null)
    } else if (type === 'date') {
      onSave(editValue || null)
    } else {
      onSave(editValue || null)
    }
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      {editing ? (
        <div className="flex items-center gap-1">
          {type === 'select' && options ? (
            <select
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={save}
              autoFocus
              className="rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-300 focus:outline-none"
            >
              <option value="">—</option>
              {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
            </select>
          ) : (
            <input
              type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onBlur={save}
              onKeyDown={e => e.key === 'Enter' && save()}
              autoFocus
              className="w-36 rounded border border-gray-200 px-2 py-1 text-sm text-right focus:border-blue-300 focus:outline-none"
            />
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={startEdit}
          className="flex items-center gap-1 text-sm font-medium text-gray-900 hover:text-blue-600 group"
        >
          {displayValue}
          <span className="text-[10px] text-gray-300 group-hover:text-blue-400">Edit</span>
        </button>
      )}
    </div>
  )
}

export function VehicleDetailPage() {
  const { id } = useParams()
  const { data: vehicle, isLoading, isError } = useVehicle(id)
  const { data: vehicleIssues } = useVehicleIssues(vehicle?.reg)
  const { trackerNumber } = useVehicleTracker(vehicle?.reg)
  const { assign: assignTracker, isSaving: isAssigningTracker } = useUpdateTrackerAssignment()
  const [activeTab, setActiveTab] = useState<'details' | 'service' | 'location' | 'preps'>('details')
  const [editingTracker, setEditingTracker] = useState(false)
  const [trackerInput, setTrackerInput] = useState('')
  const [isSelling, setIsSelling] = useState(false)
  const queryClient = useQueryClient()
  const opAuth = getOpAuthState()
  const isAdmin = opAuth?.userRole === 'admin' || opAuth?.userRole === 'manager'

  const saveField = async (field: string, value: string | number | boolean | null) => {
    if (!vehicle) return
    try {
      await updateVehicle(vehicle.id, { [field]: value })
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    }
  }

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
        {(['details', 'service', 'preps', 'location'] as const).map(tab => (
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
            {tab === 'details' ? 'Details' : tab === 'service' ? 'Service' : tab === 'preps' ? 'Prep History' : 'Location'}
          </button>
        ))}
      </div>

      {/* Location tab */}
      {activeTab === 'location' && (
        <VehicleLocationTab reg={vehicle.reg} />
      )}

      {/* Service History tab */}
      {activeTab === 'service' && (
        <ServiceHistoryTab vehicleId={vehicle.id} currentMileage={(vehicle as unknown as { currentMileage?: number | null }).currentMileage ?? null} />
      )}

      {/* Prep History tab */}
      {activeTab === 'preps' && (
        <PrepHistoryTab vehicleReg={vehicle.reg} />
      )}

      {/* Details tab */}
      {activeTab === 'details' && <>

      {/* Status */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Status</h3>
        <EditableRow label="Damage Status" value={vehicle.damageStatus} type="select"
          options={['ALL GOOD', 'BOOK REPAIR!', 'QUOTE NEEDED', 'REPAIR BOOKED']}
          onSave={v => saveField('damage_status', v)} />
        <EditableRow label="Service Status" value={vehicle.serviceStatus} type="select"
          options={['OK', 'SERVICE BOOKED', 'SERVICE DUE!', 'SERVICE DUE SOON', 'CHECK']}
          onSave={v => saveField('service_status', v)} />
        <EditableRow label="Hire Status" value={vehicle.hireStatus} type="select"
          options={['Available', 'On Hire', 'Prep Needed', 'Not Ready']}
          onSave={v => saveField('hire_status', v)} />
      </div>

      {/* Key Dates */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Key Dates</h3>
        <EditableRow label="MOT Due" value={vehicle.motDue} type="date" onSave={v => saveField('mot_due', v)} />
        <EditableRow label="Tax Due" value={vehicle.taxDue} type="date" onSave={v => saveField('tax_due', v)} />
        <EditableRow label="TFL Due" value={vehicle.tflDue} type="date" onSave={v => saveField('tfl_due', v)} />
        <EditableRow label="Warranty Expires" value={vehicle.warrantyExpires} type="date" onSave={v => saveField('warranty_expires', v)} />
        <EditableRow label="Last Service" value={vehicle.lastServiceDate} type="date" onSave={v => saveField('last_service_date', v)} />
        <EditableRow label="Finance Ends" value={vehicle.financeEnds} type="date" onSave={v => saveField('finance_ends', v)} />
      </div>

      {/* Mileage & Service */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Service & Mileage</h3>
        <EditableRow label="Last Service Mileage" value={vehicle.lastServiceMileage} type="number" onSave={v => saveField('last_service_mileage', v)} />
        <EditableRow label="Next Service Due (miles)" value={vehicle.nextServiceDue} type="number" onSave={v => saveField('next_service_due', v)} />
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
                className="rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
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
        <EditableRow label="Wifi Network" value={vehicle.wifiNetwork} type="text" onSave={v => saveField('wifi_network', v)} />
        <EditableRow label="Finance With" value={vehicle.financeWith} type="text" onSave={v => saveField('finance_with', v)} />
        <EditableRow label="ULEZ Compliant" value={vehicle.ulezCompliant} type="toggle" onSave={v => saveField('ulez_compliant', v)} />
        <EditableRow label="Spare Key" value={vehicle.spareKey} type="toggle" onSave={v => saveField('spare_key', v)} />
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
