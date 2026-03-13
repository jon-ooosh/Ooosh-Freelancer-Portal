import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { TraccarPosition } from '../../types/traccar'

// Fix Leaflet's default icon path issue with bundlers
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

interface VehicleLocationMapProps {
  position: TraccarPosition
  reg: string
  className?: string
}

export function VehicleLocationMap({ position, reg, className = '' }: VehicleLocationMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<L.Map | null>(null)
  const markerRef = useRef<L.Marker | null>(null)

  // Initialise map
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

    const map = L.map(mapRef.current, {
      zoomControl: true,
      attributionControl: false,
    }).setView([position.latitude, position.longitude], 14)

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map)

    // Small attribution (less intrusive)
    L.control.attribution({ prefix: false, position: 'bottomright' })
      .addAttribution('OSM')
      .addTo(map)

    const marker = L.marker([position.latitude, position.longitude])
      .addTo(map)
      .bindPopup(`<strong>${reg}</strong>`)

    mapInstanceRef.current = map
    markerRef.current = marker

    return () => {
      map.remove()
      mapInstanceRef.current = null
      markerRef.current = null
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Update marker position when data changes
  useEffect(() => {
    if (!markerRef.current || !mapInstanceRef.current) return
    const latlng: L.LatLngExpression = [position.latitude, position.longitude]
    markerRef.current.setLatLng(latlng)
    mapInstanceRef.current.setView(latlng)
  }, [position.latitude, position.longitude])

  return (
    <div
      ref={mapRef}
      className={`rounded-lg overflow-hidden ${className}`}
      style={{ height: 250 }}
    />
  )
}
