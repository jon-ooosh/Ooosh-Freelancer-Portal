/**
 * VehicleSettingsPage — admin-only settings for a specific vehicle.
 * Includes: sell/reactivate, service interval, insurance details,
 * and compliance threshold overrides.
 */

import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useVehicle } from '../hooks/useVehicles'
import { updateVehicle, fetchComplianceSettings, updateComplianceSettings, DEFAULT_COMPLIANCE } from '../lib/fleet-api'
import type { ComplianceSettings } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'

function EditableField({
  label,
  value,
  type = 'text',
  placeholder,
  onSave,
}: {
  label: string
  value: string | number | null
  type?: 'text' | 'number' | 'date'
  placeholder?: string
  onSave: (val: string | number | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')

  const displayValue = type === 'date' && value
    ? new Date(value + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : value != null ? String(value) : null

  const save = () => {
    setEditing(false)
    if (type === 'number') onSave(editValue ? Number(editValue) : null)
    else onSave(editValue || null)
  }

  return (
    <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      {editing ? (
        <input
          type={type}
          value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={save}
          onKeyDown={e => e.key === 'Enter' && save()}
          autoFocus
          placeholder={placeholder}
          className="w-40 rounded border border-gray-200 px-2 py-1 text-sm text-right focus:border-blue-300 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setEditValue(value != null ? String(value) : ''); setEditing(true) }}
          className="flex items-center gap-1 text-sm font-medium text-gray-900 hover:text-blue-600 group"
        >
          {displayValue || <span className="text-gray-400">Not set</span>}
          <span className="text-[10px] text-gray-300 group-hover:text-blue-400">Edit</span>
        </button>
      )}
    </div>
  )
}

function ComplianceThresholdRow({
  label,
  warningKey,
  urgentKey,
  settings,
  onSave,
}: {
  label: string
  warningKey: keyof ComplianceSettings
  urgentKey: keyof ComplianceSettings
  settings: ComplianceSettings
  onSave: (key: keyof ComplianceSettings, val: number) => void
}) {
  const [editingField, setEditingField] = useState<'warning' | 'urgent' | null>(null)
  const [editVal, setEditVal] = useState('')

  const save = (key: keyof ComplianceSettings) => {
    setEditingField(null)
    const num = parseInt(editVal, 10)
    if (!isNaN(num) && num >= 0) onSave(key, num)
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      <div className="flex items-center gap-3">
        {/* Warning (amber) */}
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-400" />
          {editingField === 'warning' ? (
            <input
              type="number" min="0" value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onBlur={() => save(warningKey)}
              onKeyDown={e => e.key === 'Enter' && save(warningKey)}
              autoFocus
              className="w-14 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-right focus:border-blue-300 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => { setEditVal(String(settings[warningKey])); setEditingField('warning') }}
              className="text-xs font-medium text-gray-700 hover:text-blue-600"
            >
              {settings[warningKey]}d
            </button>
          )}
        </div>
        {/* Urgent (red) */}
        <div className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />
          {editingField === 'urgent' ? (
            <input
              type="number" min="0" value={editVal}
              onChange={e => setEditVal(e.target.value)}
              onBlur={() => save(urgentKey)}
              onKeyDown={e => e.key === 'Enter' && save(urgentKey)}
              autoFocus
              className="w-14 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-right focus:border-blue-300 focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => { setEditVal(String(settings[urgentKey])); setEditingField('urgent') }}
              className="text-xs font-medium text-gray-700 hover:text-blue-600"
            >
              {settings[urgentKey]}d
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function VehicleSettingsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: vehicle, isLoading, isError } = useVehicle(id)
  const opAuth = getOpAuthState()
  const isAdmin = opAuth?.userRole === 'admin' || opAuth?.userRole === 'manager'
  const [actionLoading, setActionLoading] = useState(false)

  const { data: complianceSettings } = useQuery({
    queryKey: ['compliance-settings'],
    queryFn: fetchComplianceSettings,
  })
  const compliance = complianceSettings || DEFAULT_COMPLIANCE

  const saveThreshold = async (key: keyof ComplianceSettings, value: number) => {
    try {
      await updateComplianceSettings({ [key]: value })
      queryClient.invalidateQueries({ queryKey: ['compliance-settings'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save threshold')
    }
  }

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <Link to={vmPath('/vehicles')} className="text-sm text-ooosh-blue hover:underline">&larr; Back to vehicles</Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
          Admin or manager access required
        </div>
      </div>
    )
  }

  if (isLoading) {
    return <div className="animate-pulse space-y-4"><div className="h-8 w-32 rounded bg-gray-200" /><div className="h-40 rounded-lg bg-gray-100" /></div>
  }

  if (isError || !vehicle) {
    return (
      <div className="space-y-4">
        <Link to={vmPath('/vehicles')} className="text-sm text-ooosh-blue hover:underline">&larr; Back to vehicles</Link>
        <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">Vehicle not found</div>
      </div>
    )
  }

  const saveField = async (field: string, value: string | number | boolean | null) => {
    try {
      await updateVehicle(vehicle.id, { [field]: value })
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const handleToggleSold = async () => {
    const newGroup = vehicle.isOldSold ? 'active' : 'old_sold'
    const confirmMsg = vehicle.isOldSold
      ? `Reactivate ${vehicle.reg} and return it to the active fleet?`
      : `Mark ${vehicle.reg} as Old & Sold? It will be moved out of the active fleet.`
    if (!window.confirm(confirmMsg)) return
    setActionLoading(true)
    try {
      await updateVehicle(vehicle.id, { fleet_group: newGroup, is_active: newGroup === 'active' })
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
      if (newGroup === 'old_sold') {
        navigate(vmPath('/vehicles'))
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <Link to={vmPath(`/vehicles/${vehicle.id}`)} className="inline-flex items-center text-sm text-ooosh-blue hover:underline">
        &larr; Back to {vehicle.reg}
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-ooosh-navy">{vehicle.reg} — Settings</h2>
          <p className="text-sm text-gray-400">{vehicle.make} {vehicle.model}</p>
        </div>
      </div>

      {/* Service Intervals */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Service Intervals</h3>
        <EditableField label="Next service due (miles)" value={vehicle.nextServiceDue} type="number" placeholder="e.g. 120000" onSave={v => saveField('next_service_due', v)} />
        <EditableField label="Last service mileage" value={vehicle.lastServiceMileage} type="number" onSave={v => saveField('last_service_mileage', v)} />
        <EditableField label="Last service date" value={vehicle.lastServiceDate} type="date" onSave={v => saveField('last_service_date', v)} />
      </div>

      {/* Insurance */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Insurance</h3>
        <EditableField label="Insurance due" value={vehicle.insuranceDue} type="date" onSave={v => saveField('insurance_due', v)} />
        <EditableField label="Provider" value={vehicle.insuranceProvider} type="text" placeholder="e.g. Adrian Flux" onSave={v => saveField('insurance_provider', v)} />
        <EditableField label="Policy number" value={vehicle.insurancePolicyNumber} type="text" onSave={v => saveField('insurance_policy_number', v)} />
      </div>

      {/* Vehicle Details */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Vehicle Details</h3>
        <EditableField label="Fuel type" value={vehicle.fuelType} type="text" placeholder="Diesel, Petrol, Electric" onSave={v => saveField('fuel_type', v)} />
        <EditableField label="MPG" value={vehicle.mpg} type="number" placeholder="e.g. 35" onSave={v => saveField('mpg', v)} />
        <EditableField label="CO2 (g/km)" value={vehicle.co2PerKm} type="number" onSave={v => saveField('co2_per_km', v)} />
        <EditableField label="Front tyre PSI" value={vehicle.recommendedTyrePsiFront} type="number" onSave={v => saveField('recommended_tyre_psi_front', v)} />
        <EditableField label="Rear tyre PSI" value={vehicle.recommendedTyrePsiRear} type="number" onSave={v => saveField('recommended_tyre_psi_rear', v)} />
      </div>

      {/* Finance */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Finance</h3>
        <EditableField label="Finance with" value={vehicle.financeWith} type="text" onSave={v => saveField('finance_with', v)} />
        <EditableField label="Finance ends" value={vehicle.financeEnds} type="date" onSave={v => saveField('finance_ends', v)} />
      </div>

      {/* Compliance Alert Thresholds (fleet-wide) */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Compliance Alert Thresholds</h3>
        <p className="mb-3 text-xs text-gray-400">
          Fleet-wide settings. <span className="inline-flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> Amber</span> = warning,{' '}
          <span className="inline-flex items-center gap-0.5"><span className="inline-block h-2 w-2 rounded-full bg-red-500" /> Red</span> = urgent. Click to edit.
        </p>
        <ComplianceThresholdRow label="MOT" warningKey="mot_warning_days" urgentKey="mot_urgent_days" settings={compliance} onSave={saveThreshold} />
        <ComplianceThresholdRow label="Tax" warningKey="tax_warning_days" urgentKey="tax_urgent_days" settings={compliance} onSave={saveThreshold} />
        <ComplianceThresholdRow label="Insurance" warningKey="insurance_warning_days" urgentKey="insurance_urgent_days" settings={compliance} onSave={saveThreshold} />
        <ComplianceThresholdRow label="TFL" warningKey="tfl_warning_days" urgentKey="tfl_urgent_days" settings={compliance} onSave={saveThreshold} />
      </div>

      {/* Danger zone */}
      <div className="rounded-lg border border-red-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-red-500">Danger Zone</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">
              {vehicle.isOldSold ? 'Reactivate Vehicle' : 'Mark as Old & Sold'}
            </p>
            <p className="text-xs text-gray-500">
              {vehicle.isOldSold
                ? 'Return this vehicle to the active fleet'
                : 'Remove from active fleet. Can be reactivated later.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleToggleSold}
            disabled={actionLoading}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
              vehicle.isOldSold
                ? 'border border-green-200 text-green-700 hover:bg-green-50'
                : 'border border-red-200 text-red-700 hover:bg-red-50'
            }`}
          >
            {actionLoading ? 'Processing...' : vehicle.isOldSold ? 'Reactivate' : 'Mark as Sold'}
          </button>
        </div>
      </div>
    </div>
  )
}
