/**
 * Traccar types — position, device, and geofence models.
 */

export interface TraccarDevice {
  id: number
  name: string          // Set to vehicle registration in Traccar
  uniqueId: string      // IMEI of the FMC920 tracker
  status: 'online' | 'offline' | 'unknown'
  lastUpdate: string    // ISO 8601
  positionId: number
  attributes: Record<string, unknown>
}

export interface TraccarPosition {
  id: number
  deviceId: number
  latitude: number
  longitude: number
  speed: number         // In knots — multiply by 1.151 for mph
  course: number        // Heading 0-360
  altitude: number      // Metres
  fixTime: string       // ISO 8601 — when GPS fix was taken
  deviceTime: string    // ISO 8601
  serverTime: string    // ISO 8601
  attributes: {
    ignition?: boolean
    motion?: boolean
    totalDistance?: number   // Cumulative metres
    hours?: number          // Engine hours in ms
    batteryLevel?: number   // 0-100
    power?: number          // External voltage
    sat?: number            // Satellites in view
    [key: string]: unknown
  }
}

export interface TraccarGeofence {
  id: number
  name: string
  description: string
  area: string          // WKT POLYGON
  attributes: Record<string, unknown>
}

export interface TraccarTrip {
  deviceId: number
  startTime: string
  endTime: string
  distance: number      // Metres
  duration: number      // Milliseconds
  averageSpeed: number  // Knots
  maxSpeed: number      // Knots
  startLat: number
  startLon: number
  endLat: number
  endLon: number
  startAddress?: string
  endAddress?: string
}

/**
 * A tracker with no satellite fix reports 0,0 ("Null Island", in the Gulf of
 * Guinea) — never a real place for one of our vans. Drop it everywhere.
 * Backend twin: services/gps-trackers.ts isRealFix().
 */
export function isRealFix(p: { latitude: number; longitude: number } | null | undefined): boolean {
  if (!p) return false
  if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return false
  return !(p.latitude === 0 && p.longitude === 0)
}

/** Convert knots to mph */
export function knotsToMph(knots: number): number {
  return Math.round(knots * 1.151)
}

/** Convert metres to miles */
export function metresToMiles(metres: number): number {
  return Math.round((metres / 1609.344) * 10) / 10
}

/** Format engine hours from milliseconds */
export function formatEngineHours(ms: number): string {
  const hours = Math.floor(ms / 3600000)
  const minutes = Math.floor((ms % 3600000) / 60000)
  return `${hours}h ${minutes}m`
}

/** Human-readable time since a date */
export function timeSince(dateStr: string): string {
  const now = new Date()
  const then = new Date(dateStr)
  const diffMs = now.getTime() - then.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return 'Just now'
  if (diffMins < 60) return `${diffMins}m ago`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  return `${diffDays}d ago`
}
