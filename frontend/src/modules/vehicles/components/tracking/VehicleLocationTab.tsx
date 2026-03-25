import { useState } from 'react'
import { useTraccarDevice, useTraccarPosition, useTraccarTrips } from '../../hooks/useTraccar'
import { knotsToMph, metresToMiles, timeSince } from '../../types/traccar'
import type { TraccarTrip } from '../../types/traccar'
import { VehicleLocationMap } from './VehicleLocationMap'
import { format, subDays } from 'date-fns'

interface VehicleLocationTabProps {
  reg: string
}

export function VehicleLocationTab({ reg }: VehicleLocationTabProps) {
  const { data: device, isLoading: deviceLoading } = useTraccarDevice(reg)
  const { data: position, isLoading: positionLoading } = useTraccarPosition(device?.id)

  // Trip history — default to last 7 days
  const [tripDays, setTripDays] = useState(7)
  const now = new Date()
  const from = format(subDays(now, tripDays), "yyyy-MM-dd'T'00:00:00'Z'")
  const to = format(now, "yyyy-MM-dd'T'HH:mm:ss'Z'")
  const { data: trips, isLoading: tripsLoading } = useTraccarTrips(device?.id, from, to)

  // No tracker fitted
  if (!deviceLoading && device === null) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">Location</h3>
        <p className="text-sm text-gray-400 text-center py-6">
          No GPS tracker fitted to this vehicle yet.
        </p>
      </div>
    )
  }

  // Loading
  if (deviceLoading || positionLoading) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-4 animate-pulse">
        <div className="h-4 w-24 bg-gray-200 rounded mb-3" />
        <div className="h-[250px] bg-gray-100 rounded" />
      </div>
    )
  }

  const isOnline = device?.status === 'online'
  const ignition = position?.attributes?.ignition
  const speed = position ? knotsToMph(position.speed) : 0
  const lastUpdate = device?.lastUpdate ? timeSince(device.lastUpdate) : 'Unknown'

  return (
    <div className="space-y-4">
      {/* Map */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Location</h3>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2 w-2 rounded-full ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
            <span className="text-xs text-gray-500">{isOnline ? 'Online' : 'Offline'} · {lastUpdate}</span>
          </div>
        </div>

        {position ? (
          <>
            <VehicleLocationMap position={position} reg={reg} />

            {/* Status row */}
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md bg-gray-50 px-2 py-2">
                <div className="text-xs text-gray-500">Speed</div>
                <div className="text-sm font-semibold text-gray-900">{speed} mph</div>
              </div>
              <div className="rounded-md bg-gray-50 px-2 py-2">
                <div className="text-xs text-gray-500">Ignition</div>
                <div className={`text-sm font-semibold ${ignition ? 'text-green-700' : 'text-gray-500'}`}>
                  {ignition ? 'On' : 'Off'}
                </div>
              </div>
              <div className="rounded-md bg-gray-50 px-2 py-2">
                <div className="text-xs text-gray-500">Heading</div>
                <div className="text-sm font-semibold text-gray-900">{headingToCompass(position.course)}</div>
              </div>
            </div>

            {position.attributes.totalDistance != null && (
              <div className="mt-2 text-center text-xs text-gray-400">
                Total tracked: {metresToMiles(position.attributes.totalDistance).toLocaleString()} miles
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-400 text-center py-6">
            No position data available yet.
          </p>
        )}
      </div>

      {/* Trip History */}
      <div className="rounded-lg border border-gray-200 bg-white p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Recent Trips</h3>
          <select
            value={tripDays}
            onChange={e => setTripDays(Number(e.target.value))}
            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600"
          >
            <option value={1}>Last 24h</option>
            <option value={3}>Last 3 days</option>
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
          </select>
        </div>

        {tripsLoading ? (
          <div className="space-y-2 animate-pulse">
            {[1, 2, 3].map(i => <div key={i} className="h-12 bg-gray-100 rounded" />)}
          </div>
        ) : !trips || trips.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">
            No trips recorded in this period.
          </p>
        ) : (
          <div className="space-y-2">
            {trips.map((trip, i) => (
              <TripRow key={i} trip={trip} />
            ))}
          </div>
        )}
      </div>

      {/* Link to full Traccar */}
      <a
        href="https://tracking.oooshtours.co.uk"
        target="_blank"
        rel="noopener noreferrer"
        className="block rounded-lg border border-gray-200 bg-white px-4 py-3 text-center text-sm font-medium text-ooosh-blue hover:bg-gray-50"
      >
        Open full tracking system &rarr;
      </a>
    </div>
  )
}

function TripRow({ trip }: { trip: TraccarTrip }) {
  const startTime = new Date(trip.startTime)
  const endTime = new Date(trip.endTime)
  const distance = metresToMiles(trip.distance)
  const durationMins = Math.round(trip.duration / 60000)
  const avgSpeed = knotsToMph(trip.averageSpeed)

  // Sanity check: flag trips with impossible values (GPS glitches / Traccar bugs)
  const isBogus = avgSpeed > 200 || (durationMins <= 1 && distance > 50)

  const timeRange = `${format(startTime, 'HH:mm')} – ${format(endTime, 'HH:mm')}`
  const dateLabel = format(startTime, 'EEE d MMM')

  if (isBogus) {
    return (
      <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 opacity-50">
        <div>
          <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
          <div className="text-xs text-gray-500">{timeRange}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-400 italic">GPS data error — ignored</div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2">
      <div>
        <div className="text-sm font-medium text-gray-900">{dateLabel}</div>
        <div className="text-xs text-gray-500">{timeRange}</div>
      </div>
      <div className="text-right">
        <div className="text-sm font-medium text-gray-900">{distance} mi</div>
        <div className="text-xs text-gray-500">{durationMins}min · avg {avgSpeed}mph</div>
      </div>
    </div>
  )
}

function headingToCompass(degrees: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  const index = Math.round(degrees / 45) % 8
  return directions[index] ?? 'N'
}
