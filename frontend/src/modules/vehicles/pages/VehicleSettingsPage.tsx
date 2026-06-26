/**
 * VehicleSettingsPage — admin-only settings for a specific vehicle.
 * Includes: sell/reactivate, service interval, insurance details,
 * and compliance threshold overrides.
 */

import { useState, useEffect } from 'react'
import { hasManagerRole } from '../../../lib/roles'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { vmPath } from '../config/route-paths'
import { useVehicle } from '../hooks/useVehicles'
import { updateVehicle, fetchComplianceSettings, updateComplianceSettings, DEFAULT_COMPLIANCE } from '../lib/fleet-api'
import type { ComplianceSettings } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'
import { VAN_TYPES } from '../lib/van-matching'
import { buildDefaultRemovalChecklist } from '../lib/removal-checklist'

function EditableField({
  label,
  value,
  type = 'text',
  placeholder,
  options,
  displayMap,
  hint,
  onSave,
}: {
  label: string
  value: string | number | null
  type?: 'text' | 'number' | 'date' | 'select'
  placeholder?: string
  options?: string[]
  displayMap?: Record<string, string>
  hint?: string
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

  // Select renders an always-visible dropdown that saves on change — no
  // click-to-edit step, since a dropdown is already self-explanatory.
  if (type === 'select' && options) {
    return (
      <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
        <span className="text-sm text-gray-600">
          {label}
          {hint && <span className="ml-1 block text-[10px] text-gray-400">{hint}</span>}
        </span>
        <select
          value={value != null ? String(value) : ''}
          onChange={e => onSave(e.target.value || null)}
          className="w-40 rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-300 focus:outline-none"
        >
          <option value="">Not set</option>
          {options.map(opt => <option key={opt} value={opt}>{displayMap?.[opt] || opt}</option>)}
        </select>
      </div>
    )
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

/** Single-value fleet-wide setting row (e.g. "Service alert: 2000 miles"). */
function ComplianceValueRow({
  label,
  settingsKey,
  suffix,
  settings,
  onSave,
}: {
  label: string
  settingsKey: keyof ComplianceSettings
  suffix: string
  settings: ComplianceSettings
  onSave: (key: keyof ComplianceSettings, val: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editVal, setEditVal] = useState('')

  const save = () => {
    setEditing(false)
    const num = parseInt(editVal, 10)
    if (!isNaN(num) && num >= 0) onSave(settingsKey, num)
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      {editing ? (
        <input
          type="number" min="0" value={editVal}
          onChange={e => setEditVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => e.key === 'Enter' && save()}
          autoFocus
          className="w-24 rounded border border-gray-200 px-1.5 py-0.5 text-xs text-right focus:border-blue-300 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setEditVal(String(settings[settingsKey])); setEditing(true) }}
          className="text-xs font-medium text-gray-700 hover:text-blue-600"
        >
          {settings[settingsKey]}{suffix}
        </button>
      )}
    </div>
  )
}

export function VehicleSettingsPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: vehicle, isLoading, isError } = useVehicle(id)
  const opAuth = getOpAuthState()
  const isAdmin = hasManagerRole(opAuth?.userRole)
  // Sale figures (price/notes) are admin-only; sold date + removal checklist
  // are operational so any admin/manager who can reach this page may set them.
  const isStrictAdmin = opAuth?.userRole === 'admin'
  const [actionLoading, setActionLoading] = useState(false)
  const [showRemovalModal, setShowRemovalModal] = useState(false)

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

  const handleReactivate = async () => {
    if (!window.confirm(`Reactivate ${vehicle.reg} and return it to the active fleet?`)) return
    setActionLoading(true)
    try {
      await updateVehicle(vehicle.id, { fleet_group: 'active', is_active: true })
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update')
    } finally {
      setActionLoading(false)
    }
  }

  // Removal / disposal: mark sold (+ sale data), seed the removal checklist so
  // the off-system jobs are tracked, then leave the page.
  const handleRemoval = async (sale: { soldDate: string; salePrice: string; saleNotes: string }) => {
    setActionLoading(true)
    try {
      const payload: Record<string, unknown> = {
        fleet_group: 'old_sold',
        is_active: false,
        sold_date: sale.soldDate || null,
        // Seed the removal checklist (unless one already exists, preserved server-side merge).
        removal_checklist: buildDefaultRemovalChecklist(),
      }
      // Sale figures are admin-only — the API ignores them for non-admins anyway,
      // but only send them when the field was shown.
      if (isStrictAdmin) {
        payload.sale_price = sale.salePrice ? Number(sale.salePrice) : null
        payload.sale_notes = sale.saleNotes || null
      }
      await updateVehicle(vehicle.id, payload)
      queryClient.invalidateQueries({ queryKey: ['vehicles'] })
      navigate(vmPath('/vehicles'))
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to mark as sold')
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
        {/* Rossetts annual warranty service (Mercedes / on-plan vans) */}
        <div className="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
          <span className="text-sm text-gray-600">On Rossetts plan</span>
          <button
            type="button"
            onClick={() => saveField('rossetts_applicable', !vehicle.rossettsApplicable)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${vehicle.rossettsApplicable ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
          >
            {vehicle.rossettsApplicable ? 'Yes' : 'No'}
          </button>
        </div>
        <EditableField label="Last Rossetts service date" value={vehicle.lastRossettsServiceDate} type="date" onSave={v => saveField('last_rossetts_service_date', v)} />
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
        <EditableField
          label="Van type"
          value={vehicle.simpleType || null}
          type="select"
          options={[...VAN_TYPES]}
          hint="Used to match this van to job requirements"
          onSave={v => saveField('simple_type', v)}
        />
        <EditableField
          label="Gearbox"
          value={vehicle.gearbox || null}
          type="select"
          options={['auto', 'manual']}
          displayMap={{ auto: 'Auto', manual: 'Manual' }}
          hint="Matches auto/manual job requirements (ignored for Panel vans)"
          onSave={v => saveField('gearbox', v)}
        />
        <EditableField label="Fuel type" value={vehicle.fuelType} type="text" placeholder="Diesel, Petrol, Electric" onSave={v => saveField('fuel_type', v)} />
        <EditableField label="MPG" value={vehicle.mpg} type="number" placeholder="e.g. 35" onSave={v => saveField('mpg', v)} />
        <EditableField label="CO2 (g/km)" value={vehicle.co2PerKm} type="number" onSave={v => saveField('co2_per_km', v)} />
        <EditableField label="Front tyre PSI" value={vehicle.recommendedTyrePsiFront} type="number" onSave={v => saveField('recommended_tyre_psi_front', v)} />
        <EditableField label="Rear tyre PSI" value={vehicle.recommendedTyrePsiRear} type="number" onSave={v => saveField('recommended_tyre_psi_rear', v)} />
      </div>

      {/* Finance & lifecycle now lives on the vehicle detail page (admin-only
          "Finance & Lifecycle" section) — kept off Settings so there's one home. */}

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

      {/* Service Alerts (fleet-wide) */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-1 text-sm font-semibold uppercase tracking-wide text-gray-500">Service Alerts</h3>
        <p className="mb-3 text-xs text-gray-400">
          Fleet-wide. Daily 08:00 scan emails the vehicle manager when a van approaches a service. Click to edit.
        </p>
        <ComplianceValueRow label="General service — alert this far ahead" settingsKey="service_mileage_warning_miles" suffix=" mi" settings={compliance} onSave={saveThreshold} />
        <ComplianceValueRow label="Rossetts — first service after first registration" settingsKey="rossetts_first_service_years" suffix=" yr" settings={compliance} onSave={saveThreshold} />
        <ComplianceValueRow label="Rossetts — interval between services" settingsKey="rossetts_interval_months" suffix=" mo" settings={compliance} onSave={saveThreshold} />
        <ComplianceValueRow label="Rossetts — alert this far ahead" settingsKey="rossetts_warning_days" suffix="d" settings={compliance} onSave={saveThreshold} />
      </div>

      {/* Danger zone — sell / removal */}
      <div className="rounded-lg border border-red-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-red-500">Danger Zone</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-gray-900">
              {vehicle.isOldSold ? 'Reactivate Vehicle' : 'Sell / Remove from Fleet'}
            </p>
            <p className="text-xs text-gray-500">
              {vehicle.isOldSold
                ? 'Return this vehicle to the active fleet'
                : 'Records the sale and starts the removal checklist. Can be reactivated later.'}
            </p>
          </div>
          <button
            type="button"
            onClick={vehicle.isOldSold ? handleReactivate : () => setShowRemovalModal(true)}
            disabled={actionLoading}
            className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
              vehicle.isOldSold
                ? 'border border-green-200 text-green-700 hover:bg-green-50'
                : 'border border-red-200 text-red-700 hover:bg-red-50'
            }`}
          >
            {actionLoading ? 'Processing...' : vehicle.isOldSold ? 'Reactivate' : 'Sell / Remove'}
          </button>
        </div>
      </div>

      {showRemovalModal && (
        <RemovalModal
          reg={vehicle.reg}
          showSaleFigures={isStrictAdmin}
          loading={actionLoading}
          onClose={() => setShowRemovalModal(false)}
          onConfirm={handleRemoval}
        />
      )}
    </div>
  )
}

/** Modal for selling / removing a vehicle — captures sale data + confirms. */
function RemovalModal({
  reg, showSaleFigures, loading, onClose, onConfirm,
}: {
  reg: string
  showSaleFigures: boolean
  loading: boolean
  onClose: () => void
  onConfirm: (sale: { soldDate: string; salePrice: string; saleNotes: string }) => void
}) {
  const today = new Date().toISOString().slice(0, 10)
  const [soldDate, setSoldDate] = useState(today)
  const [salePrice, setSalePrice] = useState('')
  const [saleNotes, setSaleNotes] = useState('')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-ooosh-navy">Sell / Remove {reg}</h3>
        <p className="mt-1 text-sm text-gray-500">
          This moves the van out of the active fleet and starts the removal checklist
          (HireHop, TTS360, insurers, DVLA). It can be reactivated later.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Sale / removal date</label>
            <input
              type="date" value={soldDate} onChange={e => setSoldDate(e.target.value)}
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
            />
          </div>
          {showSaleFigures && (
            <>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Sale price (£)</label>
                <input
                  type="number" min="0" step="0.01" value={salePrice} placeholder="e.g. 12500"
                  onChange={e => setSalePrice(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-600">Sale notes</label>
                <textarea
                  value={saleNotes} rows={3} placeholder="Buyer, condition, any relevant details…"
                  onChange={e => setSaleNotes(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
                />
              </div>
            </>
          )}
          {!showSaleFigures && (
            <p className="rounded border border-gray-200 bg-gray-50 px-2.5 py-2 text-xs text-gray-500">
              Sale price &amp; notes are admin-only and can be added afterwards by an admin from the vehicle's Finance &amp; Lifecycle section.
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">
            Cancel
          </button>
          <button
            type="button" disabled={loading}
            onClick={() => onConfirm({ soldDate, salePrice, saleNotes })}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {loading ? 'Processing…' : 'Confirm Sale & Remove'}
          </button>
        </div>
      </div>
    </div>
  )
}
