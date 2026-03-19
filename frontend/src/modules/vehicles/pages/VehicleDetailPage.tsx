import { useState, useMemo, useRef } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useVehicle } from '../hooks/useVehicles'
import { useVehicleIssues } from '../hooks/useVehicleIssues'
import { useVehicleTracker, useUpdateTrackerAssignment } from '../hooks/useTrackerAssignments'
import { IssueCard } from '../components/issues/IssueCard'
import { VehicleLocationTab } from '../components/tracking/VehicleLocationTab'
import { PrepHistoryTab } from '../components/prep/PrepHistoryTab'
import ServiceHistoryTab from '../components/service/ServiceHistoryTab'
import FuelHistoryTab from '../components/fuel/FuelHistoryTab'
import { updateVehicle, fetchComplianceSettings, DEFAULT_COMPLIANCE, uploadVehicleFile, deleteVehicleFile } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'
import { getAuthHeaders } from '../config/api-config'
import { getDateUrgency } from '../types/vehicle'
import type { DateUrgency, VehicleFile } from '../types/vehicle'

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
  const { data: complianceSettings } = useQuery({
    queryKey: ['compliance-settings'],
    queryFn: fetchComplianceSettings,
    staleTime: 5 * 60 * 1000,
  })
  const cs = complianceSettings || DEFAULT_COMPLIANCE
  const [activeTab, setActiveTab] = useState<'details' | 'service' | 'fuel' | 'location' | 'preps'>('details')
  const [editingTracker, setEditingTracker] = useState(false)
  const [trackerInput, setTrackerInput] = useState('')
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
            <Link
              to={vmPath(`/vehicles/${vehicle.id}/settings`)}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              Vehicle Settings
            </Link>
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
        {(['details', 'service', 'fuel', 'preps', 'location'] as const).map(tab => (
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
            {tab === 'details' ? 'Details' : tab === 'service' ? 'Service' : tab === 'fuel' ? 'Fuel' : tab === 'preps' ? 'Prep History' : 'Location'}
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

      {/* Fuel tab */}
      {activeTab === 'fuel' && (
        <FuelHistoryTab vehicleId={vehicle.id} currentMileage={vehicle.currentMileage} />
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

      {/* Key Dates — compliance colour coded */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Key Dates</h3>
        <ComplianceDateRow
          label="MOT Due" date={vehicle.motDue} warningDays={cs.mot_warning_days}
          bookedIn={vehicle.motBookedInDate}
          onSaveDate={v => saveField('mot_due', v)}
          onSaveBooked={v => saveField('mot_booked_in_date', v)}
        />
        <ComplianceDateRow
          label="Tax Due" date={vehicle.taxDue} warningDays={cs.tax_warning_days}
          bookedIn={vehicle.taxBookedInDate}
          onSaveDate={v => saveField('tax_due', v)}
          onSaveBooked={v => saveField('tax_booked_in_date', v)}
        />
        <ComplianceDateRow
          label="Insurance Due" date={vehicle.insuranceDue} warningDays={cs.insurance_warning_days}
          bookedIn={vehicle.insuranceBookedInDate}
          onSaveDate={v => saveField('insurance_due', v)}
          onSaveBooked={v => saveField('insurance_booked_in_date', v)}
        />
        <ComplianceDateRow
          label="TFL Due" date={vehicle.tflDue} warningDays={cs.tfl_warning_days}
          onSaveDate={v => saveField('tfl_due', v)}
        />
        <ComplianceDateRow
          label="Last Service" date={vehicle.lastServiceDate}
          bookedIn={vehicle.serviceBookedInDate}
          onSaveDate={v => saveField('last_service_date', v)}
          onSaveBooked={v => saveField('service_booked_in_date', v)}
        />
        <ComplianceDateRow
          label="Warranty Expires" date={vehicle.warrantyExpires} warningDays={60}
          onSaveDate={v => saveField('warranty_expires', v)}
        />
        <EditableRow label="Finance Ends" value={vehicle.financeEnds} type="date" onSave={v => saveField('finance_ends', v)} />
      </div>

      {/* Insurance Details */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Insurance</h3>
        <EditableRow label="Provider" value={vehicle.insuranceProvider} type="text" onSave={v => saveField('insurance_provider', v)} />
        <EditableRow label="Policy Number" value={vehicle.insurancePolicyNumber} type="text" onSave={v => saveField('insurance_policy_number', v)} />
      </div>

      {/* Mileage & Service */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Mileage & Service</h3>
        {vehicle.currentMileage != null && (
          <div className="flex items-center justify-between py-2 border-b border-gray-100">
            <span className="text-sm text-gray-500">Current Mileage</span>
            <span className="text-sm font-bold text-gray-900">{vehicle.currentMileage.toLocaleString()} mi</span>
          </div>
        )}
        {vehicle.currentMileage != null && vehicle.lastMileageUpdate && (
          <div className="flex items-center justify-between py-1 border-b border-gray-100">
            <span className="text-[11px] text-gray-400">Last updated</span>
            <span className="text-[11px] text-gray-400">
              {new Date(vehicle.lastMileageUpdate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
            </span>
          </div>
        )}
        <EditableRow label="Last Service Mileage" value={vehicle.lastServiceMileage} type="number" onSave={v => saveField('last_service_mileage', v)} />
        <EditableRow label="Next Service Due (miles)" value={vehicle.nextServiceDue} type="number" onSave={v => saveField('next_service_due', v)} />
        {vehicle.currentMileage != null && vehicle.nextServiceDue != null && vehicle.nextServiceDue > 0 && (
          <div className="flex items-center justify-between py-2">
            <span className="text-[11px] text-gray-400">Miles until service</span>
            {(() => {
              const remaining = vehicle.nextServiceDue - vehicle.currentMileage
              return (
                <span className={`text-[11px] font-bold ${remaining <= 0 ? 'text-red-600' : remaining <= 1000 ? 'text-amber-600' : 'text-green-600'}`}>
                  {remaining <= 0 ? `${Math.abs(remaining).toLocaleString()} mi overdue` : `${remaining.toLocaleString()} mi`}
                </span>
              )
            })()}
          </div>
        )}
      </div>

      {/* V5 / Registration Details */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">V5 / Registration</h3>
        <EditableRow label="VIN / Chassis #" value={vehicle.vin} type="text" onSave={v => saveField('vin', v)} />
        <EditableRow label="Date of First Reg" value={vehicle.dateFirstReg} type="date" onSave={v => saveField('date_first_reg', v)} />
        <EditableRow label="D.1: Make" value={vehicle.make} type="text" onSave={v => saveField('make', v)} />
        <EditableRow label="D.2: Type" value={vehicle.v5Type} type="text" onSave={v => saveField('v5_type', v)} />
        <EditableRow label="D.3: Model" value={vehicle.model} type="text" onSave={v => saveField('model', v)} />
        <EditableRow label="D.5: Body Type" value={vehicle.bodyType} type="text" onSave={v => saveField('body_type', v)} />
        <EditableRow label="F.1: Max Mass (kg)" value={vehicle.maxMassKg} type="number" onSave={v => saveField('max_mass_kg', v)} />
        <EditableRow label="J: Vehicle Category" value={vehicle.vehicleCategory} type="text" onSave={v => saveField('vehicle_category', v)} />
        <EditableRow label="P.1: Cylinder Capacity (cc)" value={vehicle.cylinderCapacityCc} type="number" onSave={v => saveField('cylinder_capacity_cc', v)} />
        <EditableRow label="R: Colour" value={vehicle.colour} type="text" onSave={v => saveField('colour', v)} />
        <EditableRow label="S.1: No. of Seats (inc. driver)" value={vehicle.seats} type="number" onSave={v => saveField('seats', v)} />
      </div>

      {/* Vehicle Specs */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Vehicle Specs</h3>
        <EditableRow label="Oil Type" value={vehicle.oilType} type="text" onSave={v => saveField('oil_type', v)} />
        <EditableRow label="Coolant Type" value={vehicle.coolantType} type="text" onSave={v => saveField('coolant_type', v)} />
        <EditableRow label="Tyre Size" value={vehicle.tyreSize} type="text" onSave={v => saveField('tyre_size', v)} />
        <EditableRow label="Fuel Type" value={vehicle.fuelType} type="select"
          options={['diesel', 'petrol', 'electric', 'hybrid']}
          onSave={v => saveField('fuel_type', v)} />
        <EditableRow label="MPG" value={vehicle.mpg} type="number" onSave={v => saveField('mpg', v)} />
        <EditableRow label="CO2 (g/km)" value={vehicle.co2PerKm} type="number" onSave={v => saveField('co2_per_km', v)} />
        <EditableRow label="Tyre PSI (Front)" value={vehicle.recommendedTyrePsiFront} type="number" onSave={v => saveField('recommended_tyre_psi_front', v)} />
        <EditableRow label="Tyre PSI (Rear)" value={vehicle.recommendedTyrePsiRear} type="number" onSave={v => saveField('recommended_tyre_psi_rear', v)} />
      </div>

      {/* Rossetts & Service Plan */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Rossetts & Service Plan</h3>
        <EditableRow label="Last Rossetts Service" value={vehicle.lastRossettsServiceDate} type="date" onSave={v => saveField('last_rossetts_service_date', v)} />
        <EditableRow label="Rossetts Notes" value={vehicle.lastRossettsServiceNotes} type="text" onSave={v => saveField('last_rossetts_service_notes', v)} />
        <ServicePlanRow value={vehicle.servicePlanStatus} onSave={v => saveField('service_plan_status', v)} />
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

      {/* Vehicle Files */}
      <VehicleFilesSection vehicleId={vehicle.id} files={vehicle.files || []} />

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

/** Compliance-aware date row — colour coded green/amber/red with optional booked-in date */
function ComplianceDateRow({
  label,
  date,
  warningDays = 30,
  bookedIn,
  onSaveDate,
  onSaveBooked,
}: {
  label: string
  date: string | null
  warningDays?: number
  bookedIn?: string | null
  onSaveDate: (v: string | null) => void
  onSaveBooked?: (v: string | null) => void
}) {
  const [editingDate, setEditingDate] = useState(false)
  const [editingBooked, setEditingBooked] = useState(false)
  const [dateValue, setDateValue] = useState('')
  const [bookedValue, setBookedValue] = useState('')

  const urgency = date ? getDateUrgency(date, warningDays) : 'unknown'

  const urgencyStyles: Record<DateUrgency, { dot: string; text: string; bg: string; label: string }> = {
    ok:      { dot: 'bg-green-500', text: 'text-green-700', bg: '', label: '' },
    soon:    { dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', label: 'Due soon' },
    overdue: { dot: 'bg-red-500',   text: 'text-red-700',   bg: 'bg-red-50',   label: 'Overdue' },
    unknown: { dot: 'bg-gray-300',  text: 'text-gray-500',  bg: '', label: '' },
  }
  const style = urgencyStyles[urgency]

  // Days remaining text
  let daysText = ''
  if (date && urgency !== 'unknown') {
    const diffDays = Math.ceil((new Date(date).getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24))
    if (diffDays < 0) {
      daysText = `${Math.abs(diffDays)}d overdue`
    } else if (diffDays === 0) {
      daysText = 'Today'
    } else if (diffDays <= 90) {
      daysText = `${diffDays}d`
    }
  }

  const saveDate = () => { setEditingDate(false); onSaveDate(dateValue || null) }
  const saveBooked = () => { setEditingBooked(false); onSaveBooked?.(bookedValue || null) }

  return (
    <div className={`flex items-center gap-2 py-2 px-1 rounded border-b border-gray-100 last:border-0 ${style.bg}`}>
      {/* Urgency dot */}
      <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />

      {/* Label */}
      <span className="text-sm text-gray-500 min-w-0 flex-1">{label}</span>

      {/* Days countdown */}
      {daysText && (
        <span className={`text-[10px] font-bold ${style.text}`}>{daysText}</span>
      )}

      {/* Date value */}
      {editingDate ? (
        <input
          type="date"
          value={dateValue}
          onChange={e => setDateValue(e.target.value)}
          onBlur={saveDate}
          onKeyDown={e => e.key === 'Enter' && saveDate()}
          autoFocus
          className="w-36 rounded border border-gray-200 px-2 py-1 text-sm text-right focus:border-blue-300 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setDateValue(date || ''); setEditingDate(true) }}
          className={`text-sm font-medium hover:text-blue-600 group ${date ? style.text || 'text-gray-900' : 'text-gray-400'}`}
        >
          {date ? formatDate(date) : '—'}
          <span className="ml-1 text-[10px] text-gray-300 group-hover:text-blue-400">Edit</span>
        </button>
      )}

      {/* Booked-in indicator */}
      {onSaveBooked && (
        <>
          {editingBooked ? (
            <input
              type="date"
              value={bookedValue}
              onChange={e => setBookedValue(e.target.value)}
              onBlur={saveBooked}
              onKeyDown={e => e.key === 'Enter' && saveBooked()}
              autoFocus
              className="w-32 rounded border border-gray-200 px-2 py-1 text-[11px] text-right focus:border-blue-300 focus:outline-none"
            />
          ) : bookedIn ? (
            <button
              type="button"
              onClick={() => { setBookedValue(bookedIn || ''); setEditingBooked(true) }}
              className="shrink-0 rounded-full bg-blue-100 px-2 py-0.5 text-[10px] font-medium text-blue-700 hover:bg-blue-200"
              title={`Booked: ${formatDate(bookedIn)}`}
            >
              Booked {formatDate(bookedIn)}
            </button>
          ) : (urgency === 'soon' || urgency === 'overdue') ? (
            <button
              type="button"
              onClick={() => { setBookedValue(''); setEditingBooked(true) }}
              className="shrink-0 rounded-full border border-dashed border-gray-300 px-2 py-0.5 text-[10px] font-medium text-gray-400 hover:border-blue-400 hover:text-blue-500"
            >
              + Book in
            </button>
          ) : null}
        </>
      )}
    </div>
  )
}

const SERVICE_PLAN_OPTIONS = [
  { value: '6 Remaining', label: '6 Remaining', bg: 'bg-green-500' },
  { value: '5 Remaining', label: '5 Remaining', bg: 'bg-green-400' },
  { value: '4 Remaining', label: '4 Remaining', bg: 'bg-lime-400' },
  { value: '3 Remaining', label: '3 Remaining', bg: 'bg-yellow-400' },
  { value: '2 Remaining', label: '2 Remaining', bg: 'bg-orange-400' },
  { value: '1 Remaining', label: '1 Remaining', bg: 'bg-orange-500' },
  { value: '0 Remaining', label: '0 Remaining', bg: 'bg-red-500' },
  { value: 'WORKINGONIT', label: 'WORKINGONIT', bg: 'bg-purple-500' },
  { value: 'NO PLAN', label: 'NO PLAN', bg: 'bg-gray-400' },
]

/** Service plan status picker with colour-coded badges */
function ServicePlanRow({ value, onSave }: { value: string | null; onSave: (v: string | null) => void }) {
  const [editing, setEditing] = useState(false)

  const current = SERVICE_PLAN_OPTIONS.find(o => o.value === value)
  const displayBg = current?.bg || 'bg-gray-200'

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-500">Service Plan Status</span>
      {editing ? (
        <div className="flex flex-wrap gap-1.5 max-w-xs justify-end">
          {SERVICE_PLAN_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => { onSave(opt.value); setEditing(false) }}
              className={`${opt.bg} rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white hover:opacity-80`}
            >
              {opt.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => { onSave(null); setEditing(false) }}
            className="rounded-full border border-gray-300 px-2.5 py-0.5 text-[11px] text-gray-400 hover:bg-gray-100"
          >
            Clear
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="flex items-center gap-1 group"
        >
          {value ? (
            <span className={`${displayBg} rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white`}>
              {value}
            </span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
          <span className="text-[10px] text-gray-300 group-hover:text-blue-400">Edit</span>
        </button>
      )}
    </div>
  )
}

/** Vehicle files section — upload, view, delete files (V5, insurance cert, etc.) */
function VehicleFilesSection({ vehicleId, files }: { vehicleId: string; files: VehicleFile[] }) {
  const [uploading, setUploading] = useState(false)
  const [comment, setComment] = useState('')
  const [label, setLabel] = useState('')
  const [showUploadForm, setShowUploadForm] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const authHeaders = getAuthHeaders()

  const handleUpload = async (file: File) => {
    setUploading(true)
    try {
      await uploadVehicleFile(vehicleId, file, label || undefined, comment || undefined)
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
      setComment('')
      setLabel('')
      setShowUploadForm(false)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const handleDelete = async (key: string, name: string) => {
    if (!confirm(`Delete "${name}"?`)) return
    try {
      await deleteVehicleFile(vehicleId, key)
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const handleOpenFile = async (f: VehicleFile) => {
    try {
      const res = await fetch(`/api/files/download?key=${encodeURIComponent(f.url)}`, {
        headers: authHeaders,
      })
      if (!res.ok) throw new Error(`Download failed: ${res.status}`)
      const blob = await res.blob()
      const contentType = res.headers.get('Content-Type') || ''
      if (contentType.startsWith('image/') || contentType === 'application/pdf') {
        const url = URL.createObjectURL(blob)
        window.open(url, '_blank')
        setTimeout(() => URL.revokeObjectURL(url), 60000)
      } else {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = f.name
        a.click()
        URL.revokeObjectURL(url)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to open file')
    }
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Vehicle Files {files.length > 0 && <span className="normal-case text-gray-400">({files.length})</span>}
        </h3>
        <button
          type="button"
          onClick={() => setShowUploadForm(!showUploadForm)}
          className="text-xs font-medium text-blue-600 hover:text-blue-800"
        >
          {showUploadForm ? 'Cancel' : '+ Upload'}
        </button>
      </div>

      {/* Upload form */}
      {showUploadForm && (
        <div className="mb-3 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-3 space-y-2">
          <input
            type="text"
            placeholder="Label (e.g. V5, Insurance Cert, Finance Agreement)"
            value={label}
            onChange={e => setLabel(e.target.value)}
            className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-300 focus:outline-none"
          />
          <input
            type="text"
            placeholder="Comment (optional)"
            value={comment}
            onChange={e => setComment(e.target.value)}
            className="w-full rounded border border-gray-200 px-2.5 py-1.5 text-sm focus:border-blue-300 focus:outline-none"
          />
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) handleUpload(f)
              e.target.value = ''
            }}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {uploading ? 'Uploading...' : 'Choose File & Upload'}
          </button>
        </div>
      )}

      {/* File list */}
      {files.length === 0 && !showUploadForm ? (
        <p className="text-sm text-gray-400 text-center py-4">
          No files uploaded. Use "+ Upload" to add V5, insurance certs, finance docs, etc.
        </p>
      ) : (
        <div className="space-y-1.5">
          {files.map((f, i) => (
            <div key={i} className="rounded bg-gray-50 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="text-xs shrink-0">
                  {f.type === 'image' ? '\uD83D\uDDBC\uFE0F' : f.type === 'document' ? '\uD83D\uDCC4' : '\uD83D\uDCCE'}
                </span>
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => handleOpenFile(f)}
                    className="truncate text-sm text-blue-600 hover:underline text-left block max-w-full"
                  >
                    {f.label ? <span className="font-medium">{f.label}: </span> : null}
                    {f.name}
                  </button>
                  {f.comment && (
                    <p className="text-[11px] text-gray-400 truncate">{f.comment}</p>
                  )}
                  <p className="text-[10px] text-gray-300">
                    {f.uploaded_by} &middot; {new Date(f.uploaded_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDelete(f.url, f.name)}
                  className="shrink-0 rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500"
                  title="Delete file"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
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
