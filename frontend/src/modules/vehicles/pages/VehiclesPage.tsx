import { Link, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useFilteredVehicles } from '../hooks/useVehicles'
import { useAllocations } from '../hooks/useAllocations'
import { getGearbox } from '../lib/van-matching'
import { getDateUrgency } from '../types/vehicle'
import { vmPath } from '../config/route-paths'
import { createVehicle, fetchComplianceSettings, DEFAULT_COMPLIANCE } from '../lib/fleet-api'
import { getServiceMileageStatus, getRossettsStatus, URGENCY_TEXT } from '../lib/service-status'
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
  const gearbox = getGearbox(vehicle.vehicleType)
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
              to={vmPath(`/check-in?vehicle=${encodeURIComponent(vehicle.reg)}`)}
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
  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
      <table className="min-w-full text-left">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
            <th className="px-3 py-2">Reg</th>
            <th className="px-2 py-2">Type</th>
            <th className="px-2 py-2">Status</th>
            <th className="px-2 py-2 text-right">Mileage</th>
            <th className="px-2 py-2">Service</th>
            <th className="px-2 py-2">MOT</th>
            <th className="px-2 py-2">Tax</th>
            <th className="px-2 py-2">Insurance</th>
            <th className="px-2 py-2">TFL</th>
            <th className="px-2 py-2">Rossetts</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {vehicles.map(vehicle => {
            const svc = getServiceMileageStatus(vehicle, settings.service_mileage_warning_miles)
            const ross = getRossettsStatus(vehicle, settings)
            const status = statusLabel(vehicle, allocatedVehicleIds.has(vehicle.id))
            const gearbox = getGearbox(vehicle.vehicleType)
            const gearboxLabel = gearbox === 'auto' ? 'A' : gearbox === 'manual' ? 'M' : null
            return (
              <tr key={vehicle.id} className="hover:bg-gray-50">
                <td className="whitespace-nowrap px-3 py-2">
                  <Link to={vmPath(`/vehicles/${vehicle.id}`)} className="text-sm font-bold text-ooosh-navy hover:underline">
                    {vehicle.reg}
                  </Link>
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
                <DateCell date={vehicle.insuranceDue} warningDays={settings.insurance_warning_days} />
                <DateCell date={vehicle.tflDue} warningDays={settings.tfl_warning_days} />
                <td className={`whitespace-nowrap px-2 py-2 text-xs tabular-nums ${URGENCY_TEXT[ross.urgency]}`}>
                  {ross.dueDate ? compactDate(ross.dueDate) : '—'}
                  {ross.urgency === 'overdue' && ross.dueDate && ' ⚠️'}
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

  // View mode — dense table (default, glanceable at a desk) vs cards (mobile-
  // friendly). Persisted so each user keeps their preference.
  const [viewMode, setViewMode] = useState<'table' | 'cards'>(
    () => (localStorage.getItem('fleet-view-mode') === 'cards' ? 'cards' : 'table'),
  )
  const setView = (mode: 'table' | 'cards') => {
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

/** Inline form for adding a new vehicle */
function AddVehicleForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [reg, setReg] = useState('')
  const [make, setMake] = useState('')
  const [model, setModel] = useState('')
  const [simpleType, setSimpleType] = useState('Premium')
  const [colour, setColour] = useState('')
  const [seats, setSeats] = useState('')
  const [fuelType, setFuelType] = useState('diesel')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!reg.trim()) { setError('Registration is required'); return }

    setIsSaving(true)
    setError(null)
    try {
      await createVehicle({
        reg: reg.trim().toUpperCase(),
        make: make.trim(),
        model: model.trim(),
        simple_type: simpleType,
        colour: colour.trim(),
        seats: seats ? parseInt(seats) : null,
        fuel_type: fuelType,
        fleet_group: 'active',
        is_active: true,
      })
      onCreated()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create vehicle')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ooosh-navy">Add New Vehicle</h3>
        <button type="button" onClick={onClose} className="text-xs text-gray-400 hover:text-gray-600">Cancel</button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Registration *</label>
            <input type="text" value={reg} onChange={e => setReg(e.target.value)} placeholder="e.g. AB12 CDE"
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Type</label>
            <select value={simpleType} onChange={e => setSimpleType(e.target.value)}
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
              {VEHICLE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Make</label>
            <input type="text" value={make} onChange={e => setMake(e.target.value)} placeholder="e.g. Mercedes"
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Model</label>
            <input type="text" value={model} onChange={e => setModel(e.target.value)} placeholder="e.g. Sprinter"
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Colour</label>
            <input type="text" value={colour} onChange={e => setColour(e.target.value)} placeholder="e.g. White"
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Seats</label>
            <input type="number" value={seats} onChange={e => setSeats(e.target.value)} placeholder="e.g. 16"
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Fuel Type</label>
            <select value={fuelType} onChange={e => setFuelType(e.target.value)}
              className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-400 focus:outline-none">
              <option value="diesel">Diesel</option>
              <option value="petrol">Petrol</option>
              <option value="electric">Electric</option>
              <option value="hybrid">Hybrid</option>
            </select>
          </div>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button type="submit" disabled={isSaving}
          className="rounded-lg bg-ooosh-navy px-4 py-2 text-sm font-medium text-white hover:bg-ooosh-navy/90 disabled:opacity-50">
          {isSaving ? 'Creating...' : 'Create Vehicle'}
        </button>
      </form>
    </div>
  )
}
