import { Link, useSearchParams } from 'react-router-dom'
import { useMemo } from 'react'
import { useFilteredVehicles } from '../hooks/useVehicles'
import { useAllocations } from '../hooks/useAllocations'
import { getGearbox } from '../lib/van-matching'
import { getDateUrgency } from '../types/vehicle'
import type { Vehicle } from '../types/vehicle'

/** Colour classes for simple vehicle types */
const typeColours: Record<string, string> = {
  Premium: 'bg-indigo-100 text-indigo-800',
  Basic: 'bg-sky-100 text-sky-800',
  Panel: 'bg-gray-100 text-gray-700',
  Vito: 'bg-slate-100 text-slate-700',
}

/** Colour classes for damage status */
const damageColours: Record<string, string> = {
  'ALL GOOD': 'bg-green-100 text-green-800',
  'BOOK REPAIR!': 'bg-amber-100 text-amber-800',
  'QUOTE NEEDED': 'bg-red-100 text-red-800',
  'REPAIR BOOKED': 'bg-indigo-100 text-indigo-800',
}

/** Colour classes for service status */
const serviceColours: Record<string, string> = {
  'OK': 'bg-green-100 text-green-800',
  'SERVICE BOOKED': 'bg-amber-100 text-amber-800',
  'SERVICE DUE!': 'bg-red-100 text-red-800',
  'SERVICE DUE SOON': 'bg-blue-100 text-blue-800',
  'CHECK': 'bg-yellow-100 text-yellow-800',
}

function StatusBadge({ label, colourMap, prefix }: { label: string; colourMap: Record<string, string>; prefix?: string }) {
  if (!label) return null
  const cls = colourMap[label] || 'bg-gray-100 text-gray-600'
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {prefix ? `${prefix}: ${label}` : label}
    </span>
  )
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
      to={`/vehicles/${vehicle.id}`}
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
        <StatusBadge label={vehicle.damageStatus} colourMap={damageColours} prefix="Damage" />
        <StatusBadge label={vehicle.serviceStatus} colourMap={serviceColours} prefix="Service" />
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
        <button
          onClick={() => refetch()}
          disabled={isLoading}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50"
        >
          {isLoading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

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
