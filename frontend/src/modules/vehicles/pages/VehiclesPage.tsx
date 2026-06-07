import { Link, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useFilteredVehicles } from '../hooks/useVehicles'
import { useAllocations } from '../hooks/useAllocations'
import { vehicleGearbox } from '../lib/van-matching'
import { getDateUrgency } from '../types/vehicle'
import { vmPath } from '../config/route-paths'
import { createVehicle, uploadVehicleFile, fetchComplianceSettings, DEFAULT_COMPLIANCE } from '../lib/fleet-api'
import { buildDefaultChecklist } from '../lib/setup-checklist'
import { lifespanCountdown, sellByDate, formatGbp } from '../lib/vehicle-lifecycle'
import { FinanceProviderSelect } from '../components/FinanceLifecycleSection'
import type { SetupChecklistItem } from '../types/vehicle'
import { getServiceMileageStatus, getRossettsStatus, URGENCY_TEXT } from '../lib/service-status'
import { isSetupPending, checklistProgress } from '../lib/setup-checklist'
import { getOpAuthState } from '../adapters/auth-adapter'
import type { Vehicle } from '../types/vehicle'
import type { ComplianceSettings } from '../lib/fleet-api'

/** Colour classes for simple vehicle types */
const typeColours: Record<string, string> = {
  Premium: 'bg-indigo-100 text-indigo-800',
  Basic: 'bg-sky-100 text-sky-800',
  Panel: 'bg-gray-100 text-gray-700',
  Vito: 'bg-slate-100 text-slate-700',
}


function DateBadge({ label, date, warningDays = 30 }: { label: string; date: string | null; warningDays?: number }) {
  const urgency = getDateUrgency(date, warningDays)
  if (urgency === 'unknown') return null

  const colours = {
    ok: 'text-gray-500',
    soon: 'text-amber-600',
    overdue: 'text-red-600 font-semibold',
  }

  const formatted = date ? new Date(date + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  }) : ''

  return (
    <span className={`text-xs ${colours[urgency]}`}>
      {label}: {formatted}
      {urgency === 'overdue' && ' ⚠️'}
    </span>
  )
}

function VehicleCard({ vehicle, isAllocated }: { vehicle: Vehicle; isAllocated: boolean }) {
  const gearbox = vehicleGearbox(vehicle)
  const gearboxLabel = gearbox === 'auto' ? 'Auto' : gearbox === 'manual' ? 'Manual' : null

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <Link
        to={vmPath(`/vehicles/${vehicle.id}`)}
        className="block p-4 active:bg-gray-50"
      >
        {/* Top row: reg + type badges */}
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-lg font-bold text-ooosh-navy">{vehicle.reg}</h3>
            <p className="text-sm text-gray-500">
              {vehicle.make} {vehicle.colour ? `· ${vehicle.colour}` : ''}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            {vehicle.simpleType && (
              <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${typeColours[vehicle.simpleType] || 'bg-gray-100 text-gray-600'}`}>
                {vehicle.simpleType}{gearboxLabel ? ` · ${gearboxLabel}` : ''}
              </span>
            )}
            {vehicle.seats && (
              <span className="text-xs text-gray-400">{vehicle.seats} seats</span>
            )}
          </div>
        </div>

        {/* Status badges */}
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {vehicle.hireStatus === 'On Hire' && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-blue-100 text-blue-700">
              On Hire
            </span>
          )}
          {vehicle.hireStatus === 'Prep Needed' && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
              Prep Needed
            </span>
          )}
          {vehicle.hireStatus === 'Available' && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-700">
              Ready
            </span>
          )}
          {isAllocated && vehicle.hireStatus !== 'On Hire' && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-purple-100 text-purple-700">
              Allocated
            </span>
          )}
          {vehicle.isOldSold && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-700">
              Old &amp; Sold
            </span>
          )}
          {isSetupPending(vehicle.setupChecklist) && (
            <span className="inline-block rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700">
              ⚙ Setup {checklistProgress(vehicle.setupChecklist).done}/{checklistProgress(vehicle.setupChecklist).total}
            </span>
          )}
        </div>

        {/* Key dates that need attention */}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5">
          <DateBadge label="MOT" date={vehicle.motDue} />
          <DateBadge label="Tax" date={vehicle.taxDue} />
          {vehicle.tflDue && <DateBadge label="TFL" date={vehicle.tflDue} />}
        </div>
      </Link>

      {/* Quick-action buttons.
          Book-out is intentionally NOT offered here — it needs job context and
          belongs on Job Detail / Allocations (where ?vehicle=&job= is set).
          Check-in stays: returning a van is van-centric, staff grab it from
          the fleet view. */}
      {!vehicle.isOldSold && (
        <div className="flex border-t border-gray-100">
          {vehicle.hireStatus === 'On Hire' && (
            <Link
              to={vmPath(`/check-in?vehicle=${encodeURIComponent(vehicle.id)}`)}
              className="flex-1 py-2 text-center text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-ooosh-navy active:bg-gray-100 border-r border-gray-100"
            >
              Check In
            </Link>
          )}
          {vehicle.hireStatus === 'Prep Needed' && (
            <Link
              to={vmPath('/prep')}
              className="flex-1 py-2 text-center text-xs font-medium text-amber-600 hover:bg-amber-50 active:bg-amber-100 border-r border-gray-100"
            >
              Start Prep
            </Link>
          )}
          <Link
            to={vmPath(`/vehicles/${vehicle.id}?tab=service`)}
            className="flex-1 py-2 text-center text-xs font-medium text-gray-500 hover:bg-gray-50 hover:text-ooosh-navy active:bg-gray-100"
          >
            Service
          </Link>
        </div>
      )}
    </div>
  )
}

// ── Click-to-sort table helpers (shared by the fleet + finance tables) ──────
type SortState = { col: string; dir: 'asc' | 'desc' }
function nextSort(prev: SortState | null, col: string): SortState {
  if (prev?.col === col) return { col, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
  return { col, dir: 'asc' }
}
/** Compare two sort values; nulls/blanks always sort last regardless of dir. */
function cmpVals(a: string | number | null, b: string | number | null, dir: 'asc' | 'desc'): number {
  const na = a == null || a === ''
  const nb = b == null || b === ''
  if (na && nb) return 0
  if (na) return 1
  if (nb) return -1
  const r = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
  return dir === 'desc' ? -r : r
}
function SortTh({ label, col, sort, onSort, className = '', align = 'left' }: {
  label: string
  col: string
  sort: SortState | null
  onSort: (col: string) => void
  className?: string
  align?: 'left' | 'right' | 'center'
}) {
  const active = sort?.col === col
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'
  return (
    <th
      onClick={() => onSort(col)}
      className={`cursor-pointer select-none hover:text-gray-700 ${alignCls} ${className}`}
      title="Sort"
    >
      {label}<span className="text-gray-400">{active ? (sort!.dir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )
}

/** Compact date for the dense table — "26 May 26". */
function compactDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: '2-digit',
    })
  } catch {
    return dateStr
  }
}

/** A single colour-coded date cell for the fleet table. */
function DateCell({ date, warningDays }: { date: string | null; warningDays: number }) {
  const urgency = getDateUrgency(date, warningDays)
  return (
    <td className={`whitespace-nowrap px-2 py-2 text-xs tabular-nums ${URGENCY_TEXT[urgency]}`}>
      {compactDate(date)}
      {urgency === 'overdue' && date && ' ⚠️'}
    </td>
  )
}

const STATUS_PILL: Record<string, string> = {
  'On Hire': 'bg-blue-100 text-blue-700',
  'Available': 'bg-green-100 text-green-700',
  'Prep Needed': 'bg-amber-100 text-amber-700',
  'Not Ready': 'bg-red-100 text-red-700',
}

function statusLabel(vehicle: Vehicle, isAllocated: boolean): { label: string; cls: string } {
  if (vehicle.isOldSold) return { label: 'Old & Sold', cls: 'bg-orange-100 text-orange-700' }
  if (vehicle.hireStatus === 'Available' && isAllocated) return { label: 'Allocated', cls: 'bg-purple-100 text-purple-700' }
  const label = vehicle.hireStatus === 'Available' ? 'Ready' : (vehicle.hireStatus || '—')
  return { label, cls: STATUS_PILL[vehicle.hireStatus] || 'bg-gray-100 text-gray-600' }
}

/**
 * Dense, glanceable fleet table. One row per van with colour-coded service +
 * compliance columns so the whole fleet's health reads at a glance — the
 * "Monday colour coding" the vehicle manager asked for.
 */
function FleetTable({
  vehicles,
  allocatedVehicleIds,
  settings,
}: {
  vehicles: Vehicle[]
  allocatedVehicleIds: Set<string>
  settings: ComplianceSettings
}) {
  const [sort, setSort] = useState<SortState | null>(null)
  const onSort = (col: string) => setSort(s => nextSort(s, col))

  const accessor = (v: Vehicle, col: string): string | number | null => {
    switch (col) {
      case 'reg': return v.reg
      case 'type': return v.simpleType || ''
      case 'status': return statusLabel(v, allocatedVehicleIds.has(v.id)).label
      case 'mileage': return v.currentMileage
      case 'service': return getServiceMileageStatus(v, settings.service_mileage_warning_miles).milesRemaining
      case 'mot': return v.motDue
      case 'tax': return v.taxDue
      case 'tfl': return v.tflDue
      case 'rossetts': return getRossettsStatus(v, settings).dueDate
      case 'warranty': return v.warrantyExpires
      default: return null
    }
  }
  const rows = sort
    ? [...vehicles].sort((a, b) => cmpVals(accessor(a, sort.col), accessor(b, sort.col), sort.dir))
    : vehicles

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full text-left">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <SortTh label="Reg" col="reg" sort={sort} onSort={onSort} className="px-3 py-2" />
            <SortTh label="Type" col="type" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Status" col="status" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Mileage" col="mileage" sort={sort} onSort={onSort} className="px-2 py-2" align="right" />
            <SortTh label="Service" col="service" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="MOT" col="mot" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Tax" col="tax" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="TFL" col="tfl" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Rossetts" col="rossetts" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Warranty" col="warranty" sort={sort} onSort={onSort} className="px-2 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(vehicle => {
            const svc = getServiceMileageStatus(vehicle, settings.service_mileage_warning_miles)
            const ross = getRossettsStatus(vehicle, settings)
            const status = statusLabel(vehicle, allocatedVehicleIds.has(vehicle.id))
            const gearbox = vehicleGearbox(vehicle)
            const gearboxLabel = gearbox === 'auto' ? 'A' : gearbox === 'manual' ? 'M' : null
            return (
              <tr key={vehicle.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-3 py-2">
                  <Link to={vmPath(`/vehicles/${vehicle.id}`)} className="text-sm font-bold text-ooosh-navy hover:underline">
                    {vehicle.reg}
                  </Link>
                  {isSetupPending(vehicle.setupChecklist) && (
                    <span
                      className="ml-1.5 inline-block rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 align-middle"
                      title={`Setup incomplete (${checklistProgress(vehicle.setupChecklist).done}/${checklistProgress(vehicle.setupChecklist).total})`}
                    >
                      ⚙ setup
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs text-gray-600">
                  {vehicle.simpleType || '—'}{gearboxLabel ? ` · ${gearboxLabel}` : ''}
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${status.cls}`}>
                    {status.label}
                  </span>
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums text-gray-600">
                  {vehicle.currentMileage != null ? vehicle.currentMileage.toLocaleString() : '—'}
                </td>
                <td className={`whitespace-nowrap px-2 py-2 text-xs tabular-nums ${URGENCY_TEXT[svc.urgency]}`}>
                  {svc.milesRemaining == null
                    ? '—'
                    : svc.milesRemaining <= 0
                      ? `${Math.abs(svc.milesRemaining).toLocaleString()} over ⚠️`
                      : `${svc.milesRemaining.toLocaleString()} mi`}
                </td>
                <DateCell date={vehicle.motDue} warningDays={settings.mot_warning_days} />
                <DateCell date={vehicle.taxDue} warningDays={settings.tax_warning_days} />
                <DateCell date={vehicle.tflDue} warningDays={settings.tfl_warning_days} />
                <td className={`whitespace-nowrap px-2 py-2 text-xs tabular-nums ${URGENCY_TEXT[ross.urgency]}`}>
                  {ross.dueDate ? compactDate(ross.dueDate) : '—'}
                  {ross.urgency === 'overdue' && ross.dueDate && ' ⚠️'}
                </td>
                <DateCell date={vehicle.warrantyExpires} warningDays={30} />
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Finance-end date colour: green once past (paid off), amber as it nears. */
function financeEndClass(dateStr: string | null): string {
  if (!dateStr) return 'text-gray-400'
  const days = (new Date(dateStr + 'T00:00:00').getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  if (days < 0) return 'text-green-600 font-semibold'  // paid off ✓
  if (days <= 60) return 'text-amber-600 font-medium'  // nearly there
  return 'text-gray-600'
}

/**
 * Admin-only finance & lifecycle board — the whole-fleet "Monday" overview of
 * finance, the actual cost (incl. financing), and the 5-year sell window. All
 * columns sortable; dates colour-coded (finance-end goes green once paid off).
 */
function FleetFinanceTable({ vehicles }: { vehicles: Vehicle[] }) {
  const [sort, setSort] = useState<SortState | null>(null)
  const onSort = (col: string) => setSort(s => nextSort(s, col))

  const COUNTDOWN_CLS: Record<string, string> = {
    ok: 'text-gray-600',
    soon: 'text-amber-600 font-medium',
    overdue: 'text-red-600 font-semibold',
  }

  const accessor = (v: Vehicle, col: string): string | number | null => {
    switch (col) {
      case 'reg': return v.reg
      case 'with': return v.financeWith || ''
      case 'start': return v.financeStart
      case 'ends': return v.financeEnds
      case 'deposit': return v.depositPaid
      case 'financed': return v.amountFinanced
      case 'total': return v.totalPayable
      case 'sellby': { const d = sellByDate(v.dateFirstReg); return d ? d.getTime() : null }
      case 'countdown': return lifespanCountdown(v.dateFirstReg)?.months ?? null
      default: return null
    }
  }
  const rows = sort
    ? [...vehicles].sort((a, b) => cmpVals(accessor(a, sort.col), accessor(b, sort.col), sort.dir))
    : vehicles

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full text-left">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <SortTh label="Reg" col="reg" sort={sort} onSort={onSort} className="px-3 py-2" />
            <SortTh label="Finance with" col="with" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Start" col="start" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Ends" col="ends" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Deposit" col="deposit" sort={sort} onSort={onSort} className="px-2 py-2" align="right" />
            <SortTh label="Financed" col="financed" sort={sort} onSort={onSort} className="px-2 py-2" align="right" />
            <SortTh label="Total payable" col="total" sort={sort} onSort={onSort} className="px-2 py-2" align="right" />
            <SortTh label="5-yr sell-by" col="sellby" sort={sort} onSort={onSort} className="px-2 py-2" />
            <SortTh label="Countdown" col="countdown" sort={sort} onSort={onSort} className="px-2 py-2" />
            <th className="px-2 py-2 text-center">Docs</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(vehicle => {
            const countdown = lifespanCountdown(vehicle.dateFirstReg)
            const sellBy = sellByDate(vehicle.dateFirstReg)
            const docCount = (vehicle.files || []).filter(f => f.is_finance === true).length
            return (
              <tr key={vehicle.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-3 py-2">
                  <Link to={vmPath(`/vehicles/${vehicle.id}`)} className="text-sm font-bold text-ooosh-navy hover:underline">
                    {vehicle.reg}
                  </Link>
                  {vehicle.isOldSold && (
                    <span className="ml-1.5 inline-block rounded-full bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 align-middle">sold</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs text-gray-700">{vehicle.financeWith || '—'}</td>
                <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-gray-600">{compactDate(vehicle.financeStart)}</td>
                <td className={`whitespace-nowrap px-2 py-2 text-xs tabular-nums ${financeEndClass(vehicle.financeEnds)}`}>
                  {compactDate(vehicle.financeEnds)}
                  {vehicle.financeEnds && new Date(vehicle.financeEnds + 'T00:00:00').getTime() < Date.now() && ' ✓'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums text-gray-600">
                  {vehicle.depositPaid != null ? formatGbp(vehicle.depositPaid) : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums text-gray-600">
                  {vehicle.amountFinanced != null ? formatGbp(vehicle.amountFinanced) : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-right text-xs tabular-nums font-medium text-gray-800">
                  {vehicle.totalPayable != null ? formatGbp(vehicle.totalPayable) : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-xs tabular-nums text-gray-600">
                  {sellBy ? compactDate(sellBy.toISOString().slice(0, 10)) : '—'}
                </td>
                <td className={`whitespace-nowrap px-2 py-2 text-xs ${countdown ? COUNTDOWN_CLS[countdown.urgency] : 'text-gray-400'}`}>
                  {vehicle.isOldSold ? '—' : countdown ? (countdown.urgency === 'overdue' ? countdown.text : `${countdown.text} left`) : '—'}
                </td>
                <td className="whitespace-nowrap px-2 py-2 text-center text-xs text-gray-500">
                  {docCount > 0 ? `📎 ${docCount}` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Simple type filter pills */
const VEHICLE_TYPES = ['Premium', 'Basic', 'Panel', 'Vito']

export function VehiclesPage() {
  const [searchParams] = useSearchParams()
  const statusHighlight = searchParams.get('status') // e.g. "on-hire"
  const { vehicles, allVehicles, filters, setFilters, isLoading, isError, error, refetch } = useFilteredVehicles()
  const { data: allocations } = useAllocations()
  const allocatedVehicleIds = useMemo(
    () => new Set((allocations || []).map(a => a.vehicleId)),
    [allocations],
  )
  const [showAddForm, setShowAddForm] = useState(false)
  const opAuth = getOpAuthState()
  const isAdmin = opAuth?.userRole === 'admin' || opAuth?.userRole === 'manager'
  // Finance is admin-only — the Finance board view + finance fields on the add
  // form only render for strict admins.
  const isStrictAdmin = opAuth?.userRole === 'admin'

  // View mode — dense table (default, glanceable at a desk), cards (mobile-
  // friendly), or finance (admin-only finance/lifecycle columns). Persisted.
  type FleetView = 'table' | 'cards' | 'finance'
  const [viewMode, setViewMode] = useState<FleetView>(() => {
    const stored = localStorage.getItem('fleet-view-mode')
    if (stored === 'cards') return 'cards'
    if (stored === 'finance' && isStrictAdmin) return 'finance'
    return 'table'
  })
  const setView = (mode: FleetView) => {
    setViewMode(mode)
    localStorage.setItem('fleet-view-mode', mode)
  }

  const { data: complianceSettings } = useQuery({
    queryKey: ['compliance-settings'],
    queryFn: fetchComplianceSettings,
    staleTime: 5 * 60 * 1000,
  })
  const settings = complianceSettings || DEFAULT_COMPLIANCE

  // Auto-apply hireStatus filter from URL param (e.g. ?status=on-hire from dashboard links)
  useEffect(() => {
    const statusMap: Record<string, string> = {
      'on-hire': 'On Hire',
      'available': 'Available',
      'prep-needed': 'Prep Needed',
    }
    const mapped = statusMap[statusHighlight || '']
    if (mapped) {
      setFilters(f => ({ ...f, hireStatus: mapped, simpleType: null, showOldSold: false }))
    }
  }, []) // Only on mount — don't re-run as filters change

  const sortedVehicles = vehicles

  return (
    <div className="space-y-4">
      {/* Header with count */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">
          Vehicles
          {!isLoading && (
            <span className="ml-2 text-sm font-normal text-gray-400">
              {vehicles.length}{filters.search || filters.simpleType || filters.hireStatus || filters.showOldSold ? ` / ${allVehicles.length}` : ''}
            </span>
          )}
        </h2>
        <div className="flex gap-2">
          {/* View toggle: table (glanceable) vs cards (mobile) */}
          <div className="flex overflow-hidden rounded-lg border border-gray-200">
            <button
              onClick={() => setView('table')}
              className={`px-3 py-1.5 text-sm font-medium ${viewMode === 'table' ? 'bg-ooosh-navy text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              title="Table view"
            >
              Table
            </button>
            <button
              onClick={() => setView('cards')}
              className={`px-3 py-1.5 text-sm font-medium ${viewMode === 'cards' ? 'bg-ooosh-navy text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              title="Card view"
            >
              Cards
            </button>
            {isStrictAdmin && (
              <button
                onClick={() => setView('finance')}
                className={`border-l border-gray-200 px-3 py-1.5 text-sm font-medium ${viewMode === 'finance' ? 'bg-ooosh-navy text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
                title="Finance & lifecycle view (admin only)"
              >
                Finance
              </button>
            )}
          </div>
          {isAdmin && (
            <button
              onClick={() => setShowAddForm(true)}
              className="rounded-lg bg-ooosh-navy px-3 py-1.5 text-sm font-medium text-white hover:bg-ooosh-navy/90 active:bg-ooosh-navy/80"
            >
              + Add Vehicle
            </button>
          )}
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Add Vehicle form */}
      {showAddForm && (
        <AddVehicleForm
          isAdmin={isStrictAdmin}
          onClose={() => setShowAddForm(false)}
          onCreated={() => {
            setShowAddForm(false)
            refetch()
          }}
        />
      )}

      {/* Search */}
      <input
        type="search"
        placeholder="Search reg, make, model, colour..."
        value={filters.search}
        onChange={e => setFilters(f => ({ ...f, search: e.target.value }))}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm placeholder:text-gray-400 focus:border-ooosh-blue focus:outline-none focus:ring-1 focus:ring-ooosh-blue"
      />

      {/* Type filter pills */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilters(f => ({ ...f, simpleType: null, hireStatus: null, showOldSold: false }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            !filters.simpleType && !filters.hireStatus && !filters.showOldSold
              ? 'bg-ooosh-navy text-white'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          All
        </button>
        {VEHICLE_TYPES.map(type => (
          <button
            key={type}
            onClick={() => setFilters(f => ({
              ...f,
              simpleType: f.simpleType === type ? null : type,
              hireStatus: null,
              showOldSold: false,
            }))}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
              filters.simpleType === type
                ? 'bg-ooosh-navy text-white'
                : `${typeColours[type] || 'bg-gray-100 text-gray-600'} hover:opacity-80`
            }`}
          >
            {type}
          </button>
        ))}

        {/* Divider */}
        <span className="self-center text-gray-300">|</span>

        {/* Status filter pills */}
        <button
          onClick={() => setFilters(f => ({
            ...f,
            hireStatus: f.hireStatus === 'On Hire' ? null : 'On Hire',
            simpleType: null,
            showOldSold: false,
          }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filters.hireStatus === 'On Hire'
              ? 'bg-blue-600 text-white'
              : 'bg-blue-100 text-blue-700 hover:opacity-80'
          }`}
        >
          On Hire
        </button>
        <button
          onClick={() => setFilters(f => ({
            ...f,
            hireStatus: f.hireStatus === 'Available' ? null : 'Available',
            simpleType: null,
            showOldSold: false,
          }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filters.hireStatus === 'Available'
              ? 'bg-green-600 text-white'
              : 'bg-green-100 text-green-700 hover:opacity-80'
          }`}
        >
          Ready
        </button>
        <button
          onClick={() => setFilters(f => ({
            ...f,
            hireStatus: f.hireStatus === 'Prep Needed' ? null : 'Prep Needed',
            simpleType: null,
            showOldSold: false,
          }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filters.hireStatus === 'Prep Needed'
              ? 'bg-amber-600 text-white'
              : 'bg-amber-100 text-amber-700 hover:opacity-80'
          }`}
        >
          Needs Prep
        </button>

        <button
          onClick={() => setFilters(f => ({
            ...f,
            simpleType: null,
            hireStatus: null,
            showOldSold: !f.showOldSold,
          }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            filters.showOldSold
              ? 'bg-ooosh-navy text-white'
              : 'bg-orange-100 text-orange-700 hover:opacity-80'
          }`}
        >
          Old &amp; Sold
        </button>
      </div>

      {/* Error state */}
      {isError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Failed to load vehicles</p>
          <p className="mt-1 text-red-500">{error instanceof Error ? error.message : 'Unknown error'}</p>
          <button
            onClick={() => refetch()}
            className="mt-2 rounded bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700"
          >
            Try again
          </button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="animate-pulse rounded-lg border border-gray-200 bg-white p-4">
              <div className="h-5 w-24 rounded bg-gray-200" />
              <div className="mt-2 h-4 w-40 rounded bg-gray-100" />
              <div className="mt-2 flex gap-2">
                <div className="h-5 w-16 rounded-full bg-gray-100" />
                <div className="h-5 w-12 rounded-full bg-gray-100" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Vehicle list — table (glanceable) or cards (mobile) */}
      {!isLoading && !isError && (
        sortedVehicles.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
            {filters.search || filters.simpleType || filters.hireStatus || filters.showOldSold
              ? 'No vehicles match your filters'
              : 'No vehicles found'}
          </div>
        ) : viewMode === 'finance' && isStrictAdmin ? (
          <FleetFinanceTable vehicles={sortedVehicles} />
        ) : viewMode === 'table' ? (
          <FleetTable
            vehicles={sortedVehicles}
            allocatedVehicleIds={allocatedVehicleIds}
            settings={settings}
          />
        ) : (
          <div className="space-y-3">
            {sortedVehicles.map(vehicle => (
              <VehicleCard key={vehicle.id} vehicle={vehicle} isAllocated={allocatedVehicleIds.has(vehicle.id)} />
            ))}
          </div>
        )
      )}
    </div>
  )
}

const NUMERIC_FIELDS = new Set([
  'seats', 'last_service_mileage', 'next_service_due', 'max_mass_kg',
  'cylinder_capacity_cc', 'mpg', 'co2_per_km',
  'recommended_tyre_psi_front', 'recommended_tyre_psi_rear',
  'cash_price', 'deposit_paid', 'amount_financed', 'monthly_payment', 'finance_term_months',
])

/** Collapsible section wrapper for the add-vehicle form. */
function FormSection({ title, defaultOpen = false, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:bg-gray-50"
      >
        {title}
        <span className="text-gray-400">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="border-t border-gray-100 p-3">{children}</div>}
    </div>
  )
}

/** Inline form for adding a new vehicle — full onboarding capture + setup checklist. */
function AddVehicleForm({ isAdmin, onClose, onCreated }: { isAdmin: boolean; onClose: () => void; onCreated: () => void }) {
  const [form, setForm] = useState<Record<string, string>>({ simple_type: 'Premium', fuel_type: 'diesel' })
  const [rossettsApplicable, setRossettsApplicable] = useState(false)
  const [checklist, setChecklist] = useState<SetupChecklistItem[]>(() => buildDefaultChecklist())
  const [v5File, setV5File] = useState<File | null>(null)
  const [financeDocFile, setFinanceDocFile] = useState<File | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const set = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }))

  const toggleItem = (key: string) =>
    setChecklist(list => list.map(i => i.key === key
      ? { ...i, done: !i.done, doneAt: !i.done ? new Date().toISOString() : null }
      : i))

  const inputCls = 'w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none'

  /** Render a labelled text/number/date input bound to `form[key]`. */
  const field = (key: string, label: string, type: 'text' | 'number' | 'date' = 'text', placeholder?: string) => (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <input
        type={type}
        value={form[key] || ''}
        onChange={e => set(key, e.target.value)}
        placeholder={placeholder}
        className={inputCls}
      />
    </div>
  )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!(form.reg || '').trim()) { setError('Registration is required'); return }

    setIsSaving(true)
    setError(null)
    setWarning(null)

    // Build payload — omit empty strings, coerce numeric fields.
    const payload: Record<string, unknown> = { fleet_group: 'active', is_active: true }
    for (const [key, raw] of Object.entries(form)) {
      const val = (raw ?? '').trim()
      if (!val) continue
      payload[key] = NUMERIC_FIELDS.has(key) ? Number(val) : val
    }
    payload.reg = String(form.reg).trim().toUpperCase()
    payload.rossetts_applicable = rossettsApplicable
    payload.setup_checklist = checklist

    try {
      const created = await createVehicle(payload)
      // Upload the V5 scan (if provided) after the vehicle exists. A failed
      // upload shouldn't lose the created vehicle — surface a warning instead.
      if (v5File) {
        try {
          await uploadVehicleFile(created.id, v5File, 'V5 Document', 'Uploaded at vehicle setup')
        } catch {
          setWarning(`${created.reg} was created, but the V5 upload failed. You can add it from the vehicle's Files section.`)
          setIsSaving(false)
          return
        }
      }
      // Finance doc (admin only) — flagged is_finance so it lands in the
      // admin-only Finance & Lifecycle section, not the general Files list.
      if (financeDocFile && isAdmin) {
        try {
          await uploadVehicleFile(created.id, financeDocFile, 'Finance agreement', 'Uploaded at vehicle setup', true)
        } catch {
          setWarning(`${created.reg} was created, but the finance document upload failed. You can add it from the vehicle's Finance & Lifecycle section.`)
          setIsSaving(false)
          return
        }
      }
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vehicle')
      setIsSaving(false)
    }
  }

  const doneCount = checklist.filter(i => i.done).length

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ooosh-navy">Add New Vehicle</h3>
        <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Basics — always open */}
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Basics</h4>
          <div className="grid grid-cols-2 gap-3">
            {field('reg', 'Registration *', 'text', 'e.g. AB12 CDE')}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Type</label>
              <select value={form.simple_type} onChange={e => set('simple_type', e.target.value)} className={inputCls}>
                {VEHICLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            {field('make', 'Make', 'text', 'e.g. Mercedes')}
            {field('model', 'Model', 'text', 'e.g. Sprinter')}
            {field('colour', 'Colour', 'text', 'e.g. White')}
            {field('seats', 'Seats', 'number', 'e.g. 16')}
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Fuel Type</label>
              <select value={form.fuel_type} onChange={e => set('fuel_type', e.target.value)} className={inputCls}>
                <option value="diesel">Diesel</option>
                <option value="petrol">Petrol</option>
                <option value="electric">Electric</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </div>
          </div>
        </div>

        <FormSection title="Compliance & Key Dates">
          <div className="grid grid-cols-2 gap-3">
            {field('mot_due', 'MOT due', 'date')}
            {field('tax_due', 'Tax due', 'date')}
            {field('tfl_due', 'TFL due', 'date')}
            {field('warranty_expires', 'Warranty expires', 'date')}
            {field('insurance_due', 'Insurance due', 'date')}
            {field('insurance_provider', 'Insurance provider', 'text', 'e.g. Adrian Flux')}
            {field('insurance_policy_number', 'Policy number', 'text')}
          </div>
        </FormSection>

        <FormSection title="Service">
          <div className="grid grid-cols-2 gap-3">
            {field('next_service_due', 'Next service due (miles)', 'number', 'e.g. 120000')}
            {field('last_service_date', 'Last service date', 'date')}
            {field('last_service_mileage', 'Last service mileage', 'number')}
            {field('last_rossetts_service_date', 'Last Rossetts service', 'date')}
          </div>
          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-gray-700">
            <input
              type="checkbox"
              checked={rossettsApplicable}
              onChange={e => setRossettsApplicable(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-ooosh-navy focus:ring-ooosh-blue"
            />
            On Rossetts (Mercedes) annual warranty plan
          </label>
        </FormSection>

        <FormSection title="V5 / Registration">
          <div className="grid grid-cols-2 gap-3">
            {field('vin', 'VIN / Chassis #', 'text')}
            {field('date_first_reg', 'Date of first reg', 'date')}
            {field('v5_type', 'D.2: Type', 'text')}
            {field('body_type', 'D.5: Body type', 'text', 'e.g. Panel Van')}
            {field('max_mass_kg', 'F.1: Max mass (kg)', 'number')}
            {field('vehicle_category', 'J: Vehicle category', 'text', 'e.g. N1')}
            {field('cylinder_capacity_cc', 'P.1: Cylinder capacity (cc)', 'number')}
          </div>
        </FormSection>

        <FormSection title="Specs">
          <div className="grid grid-cols-2 gap-3">
            {field('oil_type', 'Oil type', 'text', 'e.g. 5W-30')}
            {field('coolant_type', 'Coolant type', 'text')}
            {field('tyre_size', 'Tyre size', 'text', 'e.g. 235/65/R16')}
            {field('mpg', 'MPG', 'number')}
            {field('co2_per_km', 'CO2 (g/km)', 'number')}
            {field('recommended_tyre_psi_front', 'Tyre PSI (front)', 'number')}
            {field('recommended_tyre_psi_rear', 'Tyre PSI (rear)', 'number')}
          </div>
        </FormSection>

        {/* Finance & Lifecycle — admin only (matches finance visibility) */}
        {isAdmin && (
          <FormSection title="Finance & Lifecycle (admin only)">
            <div className="rounded border border-gray-100">
              <div className="px-1">
                <FinanceProviderSelect value={form.finance_with || null} onSave={v => set('finance_with', v || '')} />
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {field('finance_reference', 'Finance reference', 'text', 'Agreement / account ref')}
              {field('finance_start', 'Finance start', 'date')}
              {field('finance_ends', 'Finance ends', 'date')}
            </div>
            <div className="mt-3">
              <p className="mb-1 text-[11px] font-medium text-gray-500">Finance / cost</p>
              <div className="grid grid-cols-2 gap-3">
                {field('cash_price', 'Cash price inc VAT (£)', 'number')}
                {field('deposit_paid', 'Deposit paid (£)', 'number')}
                {field('amount_financed', 'Amount financed (£)', 'number')}
                {field('monthly_payment', 'Monthly payment (£)', 'number')}
                {field('finance_term_months', 'Term (months)', 'number')}
              </div>
              <p className="mt-1 text-[11px] text-gray-400">
                Fees + total payable are worked out on the vehicle's Finance &amp; Lifecycle section after adding.
              </p>
            </div>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-600">Finance document scan (if on finance)</label>
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp"
                onChange={e => setFinanceDocFile(e.target.files?.[0] || null)}
                className="block w-full text-xs text-gray-600 file:mr-2 file:rounded file:border-0 file:bg-ooosh-navy file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-ooosh-navy/90"
              />
              {financeDocFile && <p className="mt-1 text-[11px] text-gray-500">{financeDocFile.name}</p>}
            </div>
          </FormSection>
        )}

        {/* Setup checklist — always open, the safety net */}
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-700">
            Setup Checklist <span className="font-normal text-amber-600">({doneCount}/{checklist.length})</span>
          </h4>
          <p className="mb-2 text-[11px] text-amber-600">
            Tick what's done. Unticked items stay on the vehicle so nothing's forgotten.
          </p>
          <div className="space-y-1">
            {checklist.map(item => (
              <label key={item.key} className="flex cursor-pointer items-center gap-2 text-xs text-gray-700">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => toggleItem(item.key)}
                  className="h-4 w-4 rounded border-gray-300 text-ooosh-navy focus:ring-ooosh-blue"
                />
                {item.label}
              </label>
            ))}
          </div>
        </div>

        {/* V5 upload */}
        <div className="rounded-lg border border-gray-200 bg-white p-3">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500">Upload V5 scan</label>
          <input
            type="file"
            accept=".pdf,.jpg,.jpeg,.png,.webp"
            onChange={e => setV5File(e.target.files?.[0] || null)}
            className="block w-full text-xs text-gray-600 file:mr-2 file:rounded file:border-0 file:bg-ooosh-navy file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-ooosh-navy/90"
          />
          {v5File && <p className="mt-1 text-[11px] text-gray-500">{v5File.name}</p>}
        </div>

        {error && <p className="text-xs text-red-600">{error}</p>}
        {warning && <p className="text-xs text-amber-700">{warning}</p>}
        <button type="submit" disabled={isSaving}
          className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-navy/90 disabled:opacity-50">
          {isSaving ? 'Creating...' : 'Create Vehicle'}
        </button>
      </form>
    </div>
  )
}
