/**
 * Finance & Lifecycle — ADMIN-ONLY card for a vehicle's financial life:
 * acquisition cost breakdown, finance details, the derived 5-year sell window
 * + countdown, the disposal record, and finance documents.
 *
 * Finance fields are gated server-side (null for non-admins) AND this whole
 * section only renders for admins — callers pass `isAdmin`.
 *
 * The Removal Checklist (exported separately) is operational and shown to ALL
 * staff, so it lives outside this admin gate.
 */

import { useEffect, useState } from 'react'
import {
  updateVehicle,
  uploadVehicleFile,
  deleteVehicleFile,
  fetchVehicleFileBlob,
  fetchFinanceProviders,
  addFinanceProvider,
  type FinanceProvider,
} from '../lib/fleet-api'
import { lifespanCountdown, sellByDate, formatGbp, VEHICLE_LIFESPAN_YEARS } from '../lib/vehicle-lifecycle'
import {
  buildDefaultRemovalChecklist,
  mergeRemovalChecklist,
  removalProgress,
} from '../lib/removal-checklist'
import type { Vehicle, VehicleFile, SetupChecklistItem } from '../types/vehicle'

function fmtDate(d: string | null): string {
  if (!d) return '—'
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

const URGENCY_CLS: Record<string, string> = {
  ok: 'bg-green-100 text-green-700',
  soon: 'bg-amber-100 text-amber-700',
  overdue: 'bg-red-100 text-red-700',
}

/** Click-to-edit text/date row (compact, matches the detail page rows). */
function FinanceField({
  label, value, type = 'text', placeholder, onSave,
}: {
  label: string
  value: string | null
  type?: 'text' | 'date'
  placeholder?: string
  onSave: (val: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [val, setVal] = useState('')
  const display = type === 'date' ? fmtDate(value) : (value || null)
  const save = () => { setEditing(false); onSave(val.trim() || null) }
  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">{label}</span>
      {editing ? (
        <input
          type={type} value={val} autoFocus placeholder={placeholder}
          onChange={e => setVal(e.target.value)}
          onBlur={save}
          onKeyDown={e => e.key === 'Enter' && save()}
          className="w-44 rounded border border-gray-200 px-2 py-1 text-sm text-right focus:border-blue-300 focus:outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => { setVal(value || ''); setEditing(true) }}
          className="flex items-center gap-1 text-sm font-medium text-gray-900 hover:text-blue-600 group"
        >
          {display || <span className="text-gray-400">Not set</span>}
          <span className="text-[10px] text-gray-300 group-hover:text-blue-400">Edit</span>
        </button>
      )}
    </div>
  )
}

/** Finance-with dropdown with ad-hoc "add new provider" inline. */
export function FinanceProviderSelect({ value, onSave }: { value: string | null; onSave: (val: string | null) => void }) {
  const [providers, setProviders] = useState<FinanceProvider[]>([])
  const [adding, setAdding] = useState(false)
  const [newLabel, setNewLabel] = useState('')

  useEffect(() => {
    fetchFinanceProviders().then(setProviders).catch(() => setProviders([]))
  }, [])

  // The stored value might be a legacy free-text provider not in the picklist —
  // surface it as a selectable option so it's not silently lost.
  const options = [...providers]
  if (value && !options.some(o => o.value === value)) {
    options.unshift({ value, label: value })
  }

  const commitNew = async () => {
    const label = newLabel.trim()
    if (!label) { setAdding(false); return }
    try {
      const added = await addFinanceProvider(label)
      setProviders(p => (p.some(x => x.value === added.value) ? p : [...p, added]))
      onSave(added.value)
    } catch {
      // fall back to just selecting the typed value even if persist failed
      onSave(label)
    }
    setNewLabel('')
    setAdding(false)
  }

  if (adding) {
    return (
      <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
        <span className="text-sm text-gray-600">Finance with</span>
        <div className="flex items-center gap-1">
          <input
            type="text" value={newLabel} autoFocus placeholder="New provider name"
            onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') commitNew(); if (e.key === 'Escape') setAdding(false) }}
            className="w-40 rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-300 focus:outline-none"
          />
          <button type="button" onClick={commitNew} className="rounded bg-ooosh-navy px-2 py-1 text-xs font-medium text-white">Add</button>
          <button type="button" onClick={() => setAdding(false)} className="text-xs text-gray-400">✕</button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <span className="text-sm text-gray-600">Finance with</span>
      <select
        value={value || ''}
        onChange={e => {
          if (e.target.value === '__add__') { setAdding(true); return }
          onSave(e.target.value || null)
        }}
        className="w-44 rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-300 focus:outline-none"
      >
        <option value="">Not set</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        <option value="__add__">+ Add new provider…</option>
      </select>
    </div>
  )
}

/** Live acquisition cost breakdown — three boxes summing to a read-only total. */
function AcquisitionCosts({ vehicle, onSaved }: { vehicle: Vehicle; onSaved: () => void }) {
  const [purchase, setPurchase] = useState(vehicle.purchaseCost?.toString() ?? '')
  const [finance, setFinance] = useState(vehicle.financeCost?.toString() ?? '')
  const [extra, setExtra] = useState(vehicle.extraCosts?.toString() ?? '')
  const [saving, setSaving] = useState(false)

  // Re-sync when the vehicle reloads (e.g. after another edit).
  useEffect(() => {
    setPurchase(vehicle.purchaseCost?.toString() ?? '')
    setFinance(vehicle.financeCost?.toString() ?? '')
    setExtra(vehicle.extraCosts?.toString() ?? '')
  }, [vehicle.purchaseCost, vehicle.financeCost, vehicle.extraCosts])

  const toNum = (s: string) => (s.trim() === '' ? null : Number(s))
  const total = (toNum(purchase) || 0) + (toNum(finance) || 0) + (toNum(extra) || 0)
  const dirty =
    toNum(purchase) !== (vehicle.purchaseCost ?? null) ||
    toNum(finance) !== (vehicle.financeCost ?? null) ||
    toNum(extra) !== (vehicle.extraCosts ?? null)

  const save = async () => {
    setSaving(true)
    try {
      await updateVehicle(vehicle.id, {
        purchase_cost: toNum(purchase),
        finance_cost: toNum(finance),
        extra_costs: toNum(extra),
      })
      onSaved()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save costs')
    } finally {
      setSaving(false)
    }
  }

  const box = (label: string, val: string, set: (v: string) => void) => (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-gray-500">{label}</label>
      <div className="relative">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">£</span>
        <input
          type="number" min="0" step="0.01" value={val}
          onChange={e => set(e.target.value)}
          className="w-full rounded border border-gray-200 pl-5 pr-2 py-1.5 text-sm focus:border-blue-300 focus:outline-none"
        />
      </div>
    </div>
  )

  return (
    <div>
      <div className="grid grid-cols-3 gap-2">
        {box('Purchase cost', purchase, setPurchase)}
        {box('Finance cost', finance, setFinance)}
        {box('Extra costs (doc fees, etc.)', extra, setExtra)}
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="text-sm">
          <span className="text-gray-500">Total cost: </span>
          <span className="font-semibold text-ooosh-navy">{formatGbp(total)}</span>
        </div>
        {dirty && (
          <button
            type="button" onClick={save} disabled={saving}
            className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-xs font-medium text-white hover:bg-ooosh-navy/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save costs'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Admin-only finance documents — upload/list/delete (flagged is_finance). */
function FinanceDocs({ vehicleId, files, onChange }: { vehicleId: string; files: VehicleFile[]; onChange: () => void }) {
  const financeFiles = files.filter(f => f.is_finance === true)
  const [showUpload, setShowUpload] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)

  const upload = async () => {
    if (!file) return
    setBusy(true)
    try {
      await uploadVehicleFile(vehicleId, file, label || 'Finance document', undefined, true)
      setFile(null); setLabel(''); setShowUpload(false)
      onChange()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setBusy(false)
    }
  }

  const view = async (key: string) => {
    try {
      const url = await fetchVehicleFileBlob(key)
      window.open(url, '_blank')
    } catch {
      alert('Could not open file')
    }
  }

  const remove = async (key: string) => {
    if (!window.confirm('Delete this finance document?')) return
    try {
      await deleteVehicleFile(vehicleId, key)
      onChange()
    } catch {
      alert('Delete failed')
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Finance Documents {financeFiles.length > 0 && <span className="normal-case text-gray-400">({financeFiles.length})</span>}
        </span>
        <button type="button" onClick={() => setShowUpload(s => !s)} className="text-xs font-medium text-ooosh-blue hover:underline">
          {showUpload ? 'Cancel' : '+ Upload'}
        </button>
      </div>

      {showUpload && (
        <div className="mb-2 space-y-2 rounded border border-gray-200 bg-gray-50 p-2">
          <input
            type="text" value={label} placeholder="Label (e.g. HP agreement, lease deed)"
            onChange={e => setLabel(e.target.value)}
            className="w-full rounded border border-gray-200 px-2 py-1 text-sm focus:border-blue-300 focus:outline-none"
          />
          <input
            type="file" accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={e => setFile(e.target.files?.[0] || null)}
            className="block w-full text-xs text-gray-600 file:mr-2 file:rounded file:border-0 file:bg-ooosh-navy file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white"
          />
          <button
            type="button" onClick={upload} disabled={!file || busy}
            className="rounded bg-ooosh-navy px-3 py-1 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      )}

      {financeFiles.length === 0 ? (
        <p className="text-xs text-gray-400">No finance documents. Upload the HP/lease agreement, doc-fee invoices, etc.</p>
      ) : (
        <ul className="space-y-1">
          {financeFiles.map((f, i) => (
            <li key={i} className="flex items-center justify-between rounded border border-gray-100 px-2 py-1.5 text-sm">
              <button type="button" onClick={() => view(f.url)} className="truncate text-left text-ooosh-blue hover:underline">
                {f.label || f.name}
              </button>
              <button type="button" onClick={() => remove(f.url)} className="ml-2 text-xs text-gray-400 hover:text-red-600">Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The admin-only Finance & Lifecycle card. Render only when `isAdmin`.
 */
export function FinanceLifecycleSection({ vehicle, onChange }: { vehicle: Vehicle; onChange: () => void }) {
  const saveField = async (field: string, value: string | number | null) => {
    try {
      await updateVehicle(vehicle.id, { [field]: value })
      onChange()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to save')
    }
  }

  const countdown = lifespanCountdown(vehicle.dateFirstReg)
  const target = sellByDate(vehicle.dateFirstReg)

  return (
    <div className="rounded-lg border border-purple-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-purple-600">Finance &amp; Lifecycle</h3>
        <span className="rounded-full bg-purple-100 px-2 py-0.5 text-[10px] font-medium text-purple-700">Admin only</span>
      </div>

      {/* Finance details */}
      <FinanceProviderSelect value={vehicle.financeWith} onSave={v => saveField('finance_with', v)} />
      <FinanceField label="Finance reference" value={vehicle.financeReference} onSave={v => saveField('finance_reference', v)} placeholder="Agreement / account ref" />
      <FinanceField label="Finance start" value={vehicle.financeStart} type="date" onSave={v => saveField('finance_start', v)} />
      <FinanceField label="Finance ends" value={vehicle.financeEnds} type="date" onSave={v => saveField('finance_ends', v)} />

      {/* Acquisition cost */}
      <div className="mt-4 border-t border-gray-100 pt-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Acquisition Cost</h4>
        <AcquisitionCosts vehicle={vehicle} onSaved={onChange} />
      </div>

      {/* Lifespan / sell window */}
      <div className="mt-4 border-t border-gray-100 pt-3">
        <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
          Lifespan ({VEHICLE_LIFESPAN_YEARS}-year sell window)
        </h4>
        {!vehicle.dateFirstReg ? (
          <p className="text-xs text-gray-400">Set the Date of First Registration (V5 section) to see the sell window.</p>
        ) : (
          <div className="flex items-center justify-between py-1">
            <div className="text-sm">
              <div className="text-gray-600">Planned sell-by: <span className="font-medium text-gray-900">{target ? fmtDate(target.toISOString().slice(0, 10)) : '—'}</span></div>
              <div className="text-[11px] text-gray-400">{VEHICLE_LIFESPAN_YEARS} years from first registration ({fmtDate(vehicle.dateFirstReg)})</div>
            </div>
            {countdown && (
              <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${URGENCY_CLS[countdown.urgency]}`}>
                {countdown.urgency === 'overdue' ? countdown.text : `${countdown.text} left`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Disposal record (when sold) */}
      {vehicle.isOldSold && (
        <div className="mt-4 border-t border-gray-100 pt-3">
          <h4 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Disposal</h4>
          <div className="flex items-center justify-between py-1 text-sm">
            <span className="text-gray-600">Sold date</span>
            <span className="font-medium text-gray-900">{fmtDate(vehicle.soldDate)}</span>
          </div>
          <FinanceField
            label="Sale price"
            value={vehicle.salePrice != null ? String(vehicle.salePrice) : null}
            onSave={v => saveField('sale_price', v == null ? null : Number(v))}
            placeholder="£"
          />
          <FinanceField label="Sale notes" value={vehicle.saleNotes} onSave={v => saveField('sale_notes', v)} placeholder="Any relevant details" />
        </div>
      )}

      {/* Finance documents */}
      <div className="mt-4 border-t border-gray-100 pt-3">
        <FinanceDocs vehicleId={vehicle.id} files={vehicle.files || []} onChange={onChange} />
      </div>
    </div>
  )
}

/**
 * Removal Checklist — visible to ALL staff. Only shown once a vehicle has a
 * removal checklist (seeded when marked sold). Items are tickable inline.
 */
export function RemovalChecklistCard({ vehicle, onChange }: { vehicle: Vehicle; onChange: () => void }) {
  const items = mergeRemovalChecklist(vehicle.removalChecklist)
  const [saving, setSaving] = useState(false)
  if (items.length === 0) return null

  const { done, total } = removalProgress(vehicle.removalChecklist)

  const toggle = async (key: string) => {
    setSaving(true)
    const next: SetupChecklistItem[] = items.map(i =>
      i.key === key ? { ...i, done: !i.done, doneAt: !i.done ? new Date().toISOString() : null } : i,
    )
    try {
      await updateVehicle(vehicle.id, { removal_checklist: next })
      onChange()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update checklist')
    } finally {
      setSaving(false)
    }
  }

  const complete = done === total
  return (
    <div className={`rounded-lg border p-4 ${complete ? 'border-green-200 bg-green-50/40' : 'border-orange-200 bg-orange-50/40'}`}>
      <h3 className={`mb-1 text-sm font-semibold uppercase tracking-wide ${complete ? 'text-green-700' : 'text-orange-700'}`}>
        Removal Checklist <span className="font-normal">({done}/{total})</span>
      </h3>
      <p className="mb-2 text-[11px] text-gray-500">Off-system jobs when this van leaves the fleet. The DVLA confirmation usually lands 1–2 weeks after notifying.</p>
      <div className="space-y-1">
        {items.map(item => (
          <label key={item.key} className="flex cursor-pointer items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox" checked={item.done} disabled={saving}
              onChange={() => toggle(item.key)}
              className="h-4 w-4 rounded border-gray-300 text-ooosh-navy focus:ring-ooosh-blue"
            />
            <span className={item.done ? 'text-gray-400 line-through' : ''}>{item.label}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

export { buildDefaultRemovalChecklist }
