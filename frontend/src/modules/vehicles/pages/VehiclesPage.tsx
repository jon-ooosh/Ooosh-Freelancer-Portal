import { Link, useSearchParams } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { useFilteredVehicles } from '../hooks/useVehicles'
import { useAllocations } from '../hooks/useAllocations'
import { getGearbox } from '../lib/van-matching'
import { getDateUrgency } from '../types/vehicle'
import { vmPath } from '../config/route-paths'
import { createVehicle } from '../lib/fleet-api'
import { getOpAuthState } from '../adapters/auth-adapter'
import type { Vehicle } from '../types/vehicle'

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
    <Link
      to={vmPath(`/vehicles/${vehicle.id}`)}
      className="block rounded-lg border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md active:bg-gray-50"
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
        {/* Damage/service status badges removed — not useful on fleet overview */}
      </div>

      {/* Key dates that need attention */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5">
        <DateBadge label="MOT" date={vehicle.motDue} />
        <DateBadge label="Tax" date={vehicle.taxDue} />
        {vehicle.tflDue && <DateBadge label="TFL" date={vehicle.tflDue} />}
      </div>
    </Link>
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

  // When ?status=on-hire, sort on-hire vehicles to the top
  const sortedVehicles = useMemo(() => {
    if (statusHighlight !== 'on-hire') return vehicles
    return [...vehicles].sort((a, b) => {
      const aOnHire = a.hireStatus === 'On Hire' ? 0 : 1
      const bOnHire = b.hireStatus === 'On Hire' ? 0 : 1
      return aOnHire - bOnHire
    })
  }, [vehicles, statusHighlight])

  return (
    <div className="space-y-4">
      {/* Header with count */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">
          Vehicles
          {!isLoading && (
            <span className="ml-2 text-sm font-normal text-gray-400">
              {vehicles.length}{filters.search || filters.simpleType || filters.showOldSold ? ` / ${allVehicles.length}` : ''}
            </span>
          )}
        </h2>
        <div className="flex gap-2">
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
          onClick={() => setFilters(f => ({ ...f, simpleType: null, showOldSold: false }))}
          className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
            !filters.simpleType && !filters.showOldSold
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
        <button
          onClick={() => setFilters(f => ({
            ...f,
            simpleType: null,
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

      {/* On Hire highlight banner */}
      {statusHighlight === 'on-hire' && !isLoading && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-medium text-blue-700">
          Showing on-hire vehicles first
        </div>
      )}

      {/* Vehicle cards */}
      {!isLoading && !isError && (
        <div className="space-y-3">
          {sortedVehicles.length === 0 ? (
            <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-400">
              {filters.search || filters.simpleType || filters.showOldSold
                ? 'No vehicles match your filters'
                : 'No vehicles found'}
            </div>
          ) : (
            sortedVehicles.map(vehicle => (
              <VehicleCard key={vehicle.id} vehicle={vehicle} isAllocated={allocatedVehicleIds.has(vehicle.id)} />
            ))
          )}
        </div>
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
