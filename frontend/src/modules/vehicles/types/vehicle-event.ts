/**
 * Vehicle Event types — clean domain models for the Events board.
 * Monday.com column mapping lives in src/lib/events-api.ts
 */

export type EventType =
  | 'Book Out'
  | 'Check In'
  | 'Interim Check In'
  | 'Prep Started'
  | 'Prep Completed'
  | 'Oil Top Up'
  | 'Coolant Top Up'
  | 'Screen Wash Top Up'
  | 'AdBlue Top Up'
  | 'Bulb Replacement'
  | 'Wiper Replacement'
  | 'Tyre Check'
  | 'Seat Rotation'
  | 'Damage Logged'
  | 'Damage Repaired'
  | 'MOT'
  | 'Service'
  | 'Location Change'
  | 'Ad-Hoc Note'
  | 'Swap Out'
  | 'Swap In'

export type FuelLevel =
  | 'Empty'
  | '1/8'
  | '2/8'
  | '3/8'
  | '4/8'
  | '5/8'
  | '6/8'
  | '7/8'
  | 'Full'

export const FUEL_LEVELS: FuelLevel[] = [
  'Empty', '1/8', '2/8', '3/8', '4/8', '5/8', '6/8', '7/8', 'Full',
]

export interface VehicleEvent {
  id: string
  name: string
  eventType: EventType
  eventDate: string       // ISO date-time
  mileage: number | null
  fuelLevel: FuelLevel | null
  details: string | null
  vehicleReg: string
  hireHopJob: string | null
  clientEmail: string | null
  syncStatus: 'Synced' | 'Pending' | 'Failed'
}

/**
 * Required photo angles for a condition report.
 * Ordered as a clockwise walk-around starting from the front of the van.
 */
export type PhotoAngle =
  | 'front'
  | 'front_right'
  | 'passenger_door'
  | 'interior_front'
  | 'sliding_door'
  | 'interior_rear'
  | 'rear_right'
  | 'rear_doors'
  | 'rear_left'
  | 'left_panel'
  | 'driver_door'
  | 'front_left'
  | 'windscreen'
  | 'dashboard'

export const REQUIRED_PHOTOS: { angle: PhotoAngle; label: string }[] = [
  { angle: 'front', label: 'Front' },
  { angle: 'front_right', label: 'Front Right' },
  { angle: 'passenger_door', label: 'Passenger Door' },
  { angle: 'interior_front', label: 'Interior Front' },
  { angle: 'sliding_door', label: 'Sliding Door' },
  { angle: 'interior_rear', label: 'Interior Rear' },
  { angle: 'rear_right', label: 'Rear Right' },
  { angle: 'rear_doors', label: 'Rear Doors' },
  { angle: 'rear_left', label: 'Rear Left' },
  { angle: 'left_panel', label: 'Left Panel' },
  { angle: 'driver_door', label: 'Driver Door' },
  { angle: 'front_left', label: 'Front Left' },
  { angle: 'windscreen', label: 'Windscreen' },
  { angle: 'dashboard', label: 'Dashboard' },
]

/**
 * Captured photo — stored as blob URL until uploaded to R2.
 */
export interface CapturedPhoto {
  angle: PhotoAngle | 'damage' | 'other' | `damage_${number}`
  label: string
  blobUrl: string        // Object URL for preview
  blob: Blob             // Actual image data
  timestamp: number
}

/**
 * Book-out wizard state — all the data collected across steps.
 */
export interface BookOutFormState {
  // Step 1: Vehicle (pre-filled if coming from vehicle detail)
  vehicleId: string | null
  vehicleReg: string
  vehicleType: string
  vehicleSimpleType: string

  // Step 2: Driver & Hire details
  driverName: string
  clientEmail: string
  hireHopJob: string

  // HireHop integration (optional — populated when selecting from upcoming jobs)
  hireHopJobData?: import('../types/hirehop').HireHopJob | null
  allocationId?: string | null

  // Driver Hire Form data (auto-populated from Monday.com board)
  hireStartDate?: string | null
  hireEndDate?: string | null
  hireStartTime?: string | null      // HH:mm
  hireEndTime?: string | null        // HH:mm
  excess?: string | null             // Excess amount (mirrored from linked board)
  ve103b?: string | null             // VE103b reference
  returnOvernight?: string | null    // "Yes" | "No" | "Don't know"
  allDrivers?: string[]              // All driver names on this job (for PDF display)
  hireFormEntries?: Array<{          // Full hire form data per driver (for write-back + multi-driver emails)
    id: string                       // Monday.com item ID of the hire form entry
    driverName: string
    clientEmail: string | null
  }>

  // Step 3: Vehicle state
  mileage: string         // String for form input, parsed to number on submit
  fuelLevel: FuelLevel | null

  // Step 4: Photos
  photos: CapturedPhoto[]

  // Step 5: Briefing checklist
  briefingChecked: Record<string, boolean>

  // Free-text notes / observations
  notes: string

  // Step 6: Signature
  signatureBlob: Blob | null
}

/**
 * Damage item flagged during check-in.
 */
export interface DamageItem {
  id: string                 // Unique ID for tracking in UI
  location: string           // Front Left, Rear Right, Interior, etc.
  severity: 'Critical' | 'Major' | 'Minor'
  description: string
  photos: CapturedPhoto[]    // Extra damage detail photos
}

/**
 * Check-in wizard state — all the data collected during check-in.
 */
export interface CheckInFormState {
  // Vehicle selection
  vehicleId: string | null
  vehicleReg: string
  vehicleType: string
  vehicleSimpleType: string

  // Book-out reference (loaded from Monday + R2)
  bookOutEventId: string | null
  bookOutDate: string | null
  bookOutMileage: number | null
  bookOutFuelLevel: string | null
  bookOutDriverName: string | null
  bookOutHireHopJob: string | null
  bookOutClientEmail: string | null
  bookOutNotes: string | null
  bookOutPhotos: Map<string, string>  // angle -> R2 URL

  // Current state
  mileage: string
  fuelLevel: FuelLevel | null

  // Check-in photos
  photos: CapturedPhoto[]

  // Damage items
  damageItems: DamageItem[]

  // Driver present at check-in (false for overnight returns)
  driverPresent: boolean

  // Signature
  signatureBlob: Blob | null
}

/** Vehicle locations for damage flagging */
export const DAMAGE_LOCATIONS = [
  'Front Left',
  'Front Right',
  'Rear Left',
  'Rear Right',
  'Front Centre',
  'Rear Centre',
  'Driver Side',
  'Passenger Side',
  'Roof',
  'Interior',
  'Dashboard',
  'Windscreen',
  'Engine Bay',
  'Underside',
] as const

/**
 * Collection form state — data collected by freelancer at vehicle pickup.
 * Stored in R2 and consumed by staff check-in to pre-populate.
 */
export interface CollectionFormState {
  // Vehicle (auto-selected from allocation)
  vehicleId: string | null
  vehicleReg: string
  vehicleType: string
  vehicleSimpleType: string

  // Job context
  hireHopJob: string
  driverName: string
  clientEmail: string

  // Vehicle state at collection point
  mileage: string
  fuelLevel: FuelLevel | null

  // Photos (8 required angles)
  photos: CapturedPhoto[]

  // Damage noted at collection (client-reported or observed)
  damageNotes: string

  // Signature
  signatureBlob: Blob | null
}

/**
 * Collection data persisted in R2 — what staff check-in reads.
 */
export interface CollectionData {
  vehicleReg: string
  vehicleType: string
  vehicleSimpleType: string
  hireHopJob: string
  driverName: string
  clientEmail: string
  mileage: number
  fuelLevel: FuelLevel
  damageNotes: string
  collectedAt: string     // ISO timestamp
  collectedBy: string     // Driver who collected
  eventId: string         // Monday.com event ID
  photoAngles: string[]   // Which angles were captured
}

/**
 * Hardcoded briefing items — used as fallback when the Settings board
 * is unavailable or empty. The primary source is the Monday.com Settings
 * board (groups named "Briefing: Premium", "Briefing: Basic", etc.).
 */
export const BRIEFING_ITEMS: Record<string, string[]> = {
  Premium: [
    'Power & reversing horn switches shown',
    'Wifi password location shown',
    'TV / Apple TV operation explained',
    'Deadlocks shown and explained',
    'Boot lights shown',
    'QR codes for manuals/help pointed out',
  ],
  Basic: [
    'Power & light switches by steering wheel shown',
    'TV / DVD operation explained',
    'Deadlocks shown and explained',
    'Boot lights shown',
    'QR codes for manuals/help pointed out',
  ],
  Panel: [
    'Deadlocks shown and explained',
    'Boot lights shown',
  ],
  Vito: [
    'Reversing sensors / camera explained',
    'Deadlocks shown and explained',
    'QR codes for manuals/help pointed out',
  ],
}
