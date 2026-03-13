/**
 * Vehicle types — clean domain models, decoupled from Monday.com.
 * Monday.com column mapping lives in src/lib/fleet-api.ts
 */

export interface Vehicle {
  id: string              // Monday item ID (for now)
  reg: string             // Registration plate, e.g. "RO71JYA"
  vehicleType: string     // Full type: "PREMIUM LWB (A)", "BASIC MWB (M)", etc.
  simpleType: VehicleSimpleType
  make: string            // MERCEDES-BENZ, VOLKSWAGEN, FORD
  model: string           // SPRINTER 317 PREMIUM CDI, etc.
  colour: string          // BLUE, SILVER, WHITE, GREY
  seats: number | null
  // Key statuses
  damageStatus: string    // ALL GOOD, BOOK REPAIR!, QUOTE NEEDED, REPAIR BOOKED
  serviceStatus: string   // OK, SERVICE BOOKED, SERVICE DUE!, SERVICE DUE SOON, CHECK
  // Key dates
  motDue: string | null           // YYYY-MM-DD
  taxDue: string | null           // YYYY-MM-DD
  tflDue: string | null           // YYYY-MM-DD
  lastServiceDate: string | null  // YYYY-MM-DD
  warrantyExpires: string | null  // YYYY-MM-DD
  // Mileage & service
  lastServiceMileage: number | null
  nextServiceDue: number | null   // Mileage-based
  // Other info
  ulezCompliant: boolean
  spareKey: boolean
  wifiNetwork: string | null      // EE, Vodafone, THREE, N/A
  financeWith: string | null
  financeEnds: string | null      // YYYY-MM-DD
  // Hire status (from Fleet Master board column color_mm0v8bak)
  hireStatus: string              // Available, On Hire, Prep Needed, Not Ready, or ''
  // CO2 emissions (g/km from Fleet Manager board)
  co2PerKm: number | null
  // Tyre reference — front and rear may differ
  recommendedTyrePsiFront: number | null
  recommendedTyrePsiRear: number | null
  // Fleet group classification
  isOldSold: boolean              // true = from Monday "Old and sold" group
  // Raw data for anything we haven't mapped yet
  _raw?: Record<string, unknown>
}

export type VehicleSimpleType = 'Premium' | 'Basic' | 'Panel' | 'Vito' | string

export interface VehicleListFilters {
  search: string
  simpleType: string | null
  damageStatus: string | null
  showOldSold: boolean
}

/**
 * Date urgency helper — how soon is a date?
 */
export type DateUrgency = 'ok' | 'soon' | 'overdue' | 'unknown'

export function getDateUrgency(dateStr: string | null, warningDays = 30): DateUrgency {
  if (!dateStr) return 'unknown'
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = diffMs / (1000 * 60 * 60 * 24)
  if (diffDays < 0) return 'overdue'
  if (diffDays < warningDays) return 'soon'
  return 'ok'
}
