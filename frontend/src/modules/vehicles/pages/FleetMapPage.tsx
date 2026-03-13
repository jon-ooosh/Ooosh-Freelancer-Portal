import { useEffect, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { vmPath } from '../config/route-paths'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useTraccarDevices } from '../hooks/useTraccar'
import { useVehicles } from '../hooks/useVehicles'
import { getPositions } from '../lib/traccar-api'
import { useQuery } from '@tanstack/react-query'
import { knotsToMph, timeSince } from '../types/traccar'
import type { TraccarDevice, TraccarPosition } from '../types/traccar'
import type { Vehicle } from '../types/vehicle'

// Fix Leaflet default icon path
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// Colour-coded icons by status
function createIcon(colour: string) {
  return L.divIcon({
    className: '',
    html: `<div style="
      width: 28px; height: 28px; border-radius: 50%;
      background: ${colour}; border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      display: flex; align-items: center; justify-content: center;
    "><div style="width: 8px; height: 8px; border-radius: 50%; background: white;"></div></div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -16],
  })
}

const ICONS = {
  moving: createIcon('#22c55e'),   // green — ignition on + moving
  idling: createIcon('#f59e0b'),   // amber — ignition on, not moving
  stopped: createIcon('#6b7280'),  // grey — ignition off
  offline: createIcon('#dc2626'),  // red — device offline
}

/** Get all positions for all devices in one call */
function useAllPositions() {
  return useQuery<TraccarPosition[]>({
    queryKey: ['traccar', 'positions', 'all'],
    queryFn: () => getPositions(),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000, // Poll every 60s
  })
}

function getVehicleForDevice(
  device: TraccarDevice,
  vehicles: Vehicle[],
): Vehicle | undefined {
  const normalise = (s: string) => s.replace(/\s+/g, '').toUpperCase()
  const target = normalise(device.name)
  return vehicles.find(v => normalise(v.reg) === target)
}

function getMarkerState(
  device: TraccarDevice,
  position: TraccarPosition | undefined,
): { icon: L.DivIcon; label: string } {
  if (device.status !== 'online') return { icon: ICONS.offline, label: 'Offline' }
  if (!position) return { icon: ICONS.stopped, label: 'No position' }
  const ignition = position.attributes?.ignition
  const speed = knotsToMph(position.speed)
  if (ignition && speed > 2) return { icon: ICONS.moving, label: `${speed} mph` }
  if (ignition) return { icon: ICONS.idling, label: 'Idling' }
  return { icon: ICONS.stopped, label: 'Stopped' }
}

export function FleetMapPage() {
  const { data: devices, isLoading: devicesLoading } = useTraccarDevices()
  const { data: positions, isLoading: positionsLoading } = useAllPositions()
  const { data: vehicles } = useVehicles()

  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markersRef = useRef<Map<number, L.Marker>>(new Map())

  const positionMap = useMemo(() => {
    const map = new Map<number, TraccarPosition>()
    if (positions) {
      for (const p of positions) map.set(p.deviceId, p)
    }
    return map
  }, [positions])

  // Initialize map
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    // Default to UK view
    const map = L.map(mapRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([51.5, -0.5], 8)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map)

    L.control.attribution({ prefix: false, position: 'bottomright' })
      .addAttribution('OSM')
      .addTo(map)

    mapInstanceRef.current = map

    return () => {
      map.remove()
      mapInstanceRef.current = null
      markersRef.current.clear()
    }
  }, [])

  // Update markers when data changes
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !devices) return

    const currentMarkers = markersRef.current
    const activeDeviceIds = new Set<number>()

    const bounds: L.LatLngExpression[] = []

    for (const device of devices) {
      activeDeviceIds.add(device.id)
      const position = positionMap.get(device.id)
      if (!position) continue

      const { icon, label } = getMarkerState(device, position)
      const vehicle = vehicles ? getVehicleForDevice(device, vehicles) : undefined
      const latlng: L.LatLngExpression = [position.latitude, position.longitude]
      bounds.push(latlng)

      const popupHtml = `
        <div style="min-width: 140px;">
          <strong style="font-size: 14px;">${device.name}</strong>
          ${vehicle ? `<br><span style="font-size: 11px; color: #666;">${vehicle.make} ${vehicle.model} · ${vehicle.simpleType || ''}</span>` : ''}
          <br><span style="font-size: 11px; color: #888;">${label} · ${timeSince(device.lastUpdate)}</span>
          ${vehicle ? `<br><a href="${vmPath(`/vehicles/${vehicle.id}`)}" style="font-size: 11px; color: #2563eb;">View vehicle &rarr;</a>` : ''}
        </div>
      `

      const existing = currentMarkers.get(device.id)
      if (existing) {
        existing.setLatLng(latlng)
        existing.setIcon(icon)
        existing.getPopup()?.setContent(popupHtml)
      } else {
        const marker = L.marker(latlng, { icon })
          .addTo(map)
          .bindPopup(popupHtml)
        currentMarkers.set(device.id, marker)
      }
    }

    // Remove markers for devices that no longer exist
    for (const [id, marker] of currentMarkers) {
      if (!activeDeviceIds.has(id)) {
        marker.remove()
        currentMarkers.delete(id)
      }
    }

    // Fit bounds if we have markers
    if (bounds.length > 0) {
      map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 14 })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, positionMap, vehicles])

  const isLoading = devicesLoading || positionsLoading
  const trackedCount = devices?.length || 0
  const onlineCount = devices?.filter(d => d.status === 'online').length || 0

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Fleet Map</h2>
          {!isLoading && (
            <p className="text-xs text-gray-500">
              {onlineCount} online / {trackedCount} tracked
            </p>
          )}
        </div>
        <Link
          to={vmPath('/')}
          className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-600 active:bg-gray-50"
        >
          Dashboard
        </Link>
      </div>

      {/* Legend */}
      <div className="flex gap-3 text-xs text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-green-500 border border-white shadow-sm" /> Moving
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-amber-500 border border-white shadow-sm" /> Idling
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-gray-500 border border-white shadow-sm" /> Stopped
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-3 rounded-full bg-red-500 border border-white shadow-sm" /> Offline
        </span>
      </div>

      {/* Map */}
      <div className="relative">
        <div
          ref={mapRef}
          className="rounded-lg overflow-hidden border border-gray-200"
          style={{ height: 'calc(100vh - 220px)', minHeight: 400 }}
        />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60 rounded-lg">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-200 border-t-ooosh-navy" />
          </div>
        )}
      </div>

      {/* Vehicle list */}
      {devices && devices.length > 0 && (
        <div className="space-y-1">
          {devices.map(device => {
            const position = positionMap.get(device.id)
            const vehicle = vehicles ? getVehicleForDevice(device, vehicles) : undefined
            const { label } = getMarkerState(device, position)

            return (
              <button
                key={device.id}
                onClick={() => {
                  if (!position || !mapInstanceRef.current) return
                  mapInstanceRef.current.setView(
                    [position.latitude, position.longitude],
                    16,
                    { animate: true },
                  )
                  markersRef.current.get(device.id)?.openPopup()
                }}
                className="flex w-full items-center gap-3 rounded-lg border border-gray-100 bg-white px-3 py-2 text-left active:bg-gray-50"
              >
                <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                  device.status === 'online' ? 'bg-green-500' : 'bg-red-500'
                }`} />
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-gray-900">{device.name}</span>
                  {vehicle && (
                    <span className="ml-1.5 text-xs text-gray-400">{vehicle.simpleType}</span>
                  )}
                </div>
                <span className="text-xs text-gray-500">{label}</span>
                <span className="text-xs text-gray-400">{timeSince(device.lastUpdate)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
