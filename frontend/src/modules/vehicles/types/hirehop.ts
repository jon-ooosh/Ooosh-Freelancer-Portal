/**
 * HireHop types — clean domain models for the HireHop rental management integration.
 *
 * HireHop API proxy lives in netlify/functions/hirehop.mts
 * Client-side API wrapper lives in src/lib/hirehop-api.ts
 * Stock-to-fleet mapping and allocation types live here.
 */

// ── Job Status ──

export type HireHopJobStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

export const HIREHOP_STATUS_LABELS: Record<number, string> = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked',
  3: 'Prepped',
  4: 'Part Dispatched',
  5: 'Dispatched',
  6: 'Returned Incomplete',
  7: 'Returned',
  8: 'Requires Attention',
  9: 'Cancelled',
  10: 'Not Interested',
  11: 'Completed',
}

/** Statuses meaning "active / going out soon" */
export const ACTIVE_JOB_STATUSES: HireHopJobStatus[] = [2, 3, 4]

/** Statuses meaning "should be coming back" */
export const RETURN_JOB_STATUSES: HireHopJobStatus[] = [4, 5, 6]

// ── Job Data ──

/** A stock line item within a HireHop job */
export interface HireHopJobItem {
  id: number
  ITEM_ID: number       // Stock type ID (maps to fleet vehicle type)
  ITEM_NAME: string     // e.g. "Premium LWB Splitter Van - auto gearbox"
  QUANTITY: number
  CATEGORY_ID?: number  // HireHop category (370 = Vehicles, 371 = Vehicle accessories, etc.)
  // The stock item id when the source sends it separately. Items read from OP's
  // stored line items carry the LINE's id in ITEM_ID and the stock id here, so
  // match stock with `stockIdOf()` in lib/hirehop-api.ts, never ITEM_ID alone.
  LIST_ID?: number
  // Nested-set position: an autopull (e.g. the Towbar) sits inside its van's range.
  LFT?: number
  RGT?: number
}

/** Parsed HireHop job — clean domain model */
export interface HireHopJob {
  id: number                     // Job number
  jobName: string                // JOB_NAME
  company: string                // COMPANY
  contactName: string            // NAME
  contactEmail: string           // EMAIL (for auto-fill on book-out)
  status: HireHopJobStatus
  statusLabel: string
  outDate: string                // YYYY-MM-DD (when stock goes out)
  jobDate: string                // YYYY-MM-DD (event start)
  jobEndDate: string             // YYYY-MM-DD (event end)
  returnDate: string             // YYYY-MM-DD (when stock comes back)
  items: HireHopJobItem[]        // Line items (van types & quantities)
  itemsFetchFailed?: boolean     // True when items_to_supply_list returned an error (e.g. dispatched jobs)
  depot: number | null
  notes: string | null
}

// ── Stock Type Mapping ──

/** Mapping from HireHop stock item ID to fleet vehicle type + gearbox */
export interface StockTypeMapping {
  stockId: number
  stockName: string
  simpleType: string             // Premium, Basic, Panel, Vito
  gearbox: 'auto' | 'manual'
}

/**
 * HireHop stock items → fleet vehicle type mapping.
 * These IDs come from the HireHop stock list and map to our fleet simpleType + gearbox.
 */
export const HIREHOP_STOCK_MAPPINGS: StockTypeMapping[] = [
  { stockId: 1130, stockName: 'Premium LWB Splitter Van - auto gearbox', simpleType: 'Premium', gearbox: 'auto' },
  { stockId: 10,   stockName: 'Premium LWB Splitter Van - manual gearbox', simpleType: 'Premium', gearbox: 'manual' },
  { stockId: 1129, stockName: 'Basic MWB Splitter Van - auto gearbox', simpleType: 'Basic', gearbox: 'auto' },
  { stockId: 11,   stockName: 'Basic MWB Splitter Van - manual gearbox', simpleType: 'Basic', gearbox: 'manual' },
  { stockId: 1016, stockName: 'Mercedes Vito 114 LWB 6-seater mini-splitter - auto gearbox', simpleType: 'Vito', gearbox: 'auto' },
  { stockId: 1303, stockName: 'Mercedes Vito 114 LWB 6-seater mini-splitter - manual gearbox', simpleType: 'Vito', gearbox: 'manual' },
  { stockId: 8,    stockName: 'Panel Van', simpleType: 'Panel', gearbox: 'auto' },
  // New for 2027 (jon, Nov 2026). Every Standard comes with a towbar.
  { stockId: 2065, stockName: 'Standard MWB Splitter Van - auto gearbox', simpleType: 'Standard', gearbox: 'auto' },
  { stockId: 2066, stockName: 'Standard MWB Splitter Van - manual gearbox', simpleType: 'Standard', gearbox: 'manual' },
]

/**
 * The "Towbar" autopull (jon, Nov 2026): a virtual item in the Vehicles
 * category, pulled onto a van that needs one. It is NOT a van, and its presence
 * inside a van line's range means that van must have a towbar.
 */
export const HIREHOP_TOWBAR_ITEM_ID = 2064

/** Virtual items to ignore (e.g. damage charges, not actual stock) */
export const HIREHOP_VIRTUAL_ITEM_IDS = [1741]

// ── Van Requirements ──

/** A single van requirement extracted from a HireHop job's line items */
export interface VanRequirement {
  stockId: number
  simpleType: string
  gearbox: 'auto' | 'manual'
  quantity: number
  /** The client asked for a towbar on this van (a Towbar line under it). */
  needsTowbar?: boolean
}

// ── Allocations (persisted in R2) ──

/** Soft or confirmed van allocation — stored in R2 */
export interface VanAllocation {
  id: string                     // crypto.randomUUID()
  hireHopJobId: number
  hireHopJobName: string
  vanRequirementIndex: number    // Which van requirement slot this fills (0-based)
  vehicleId: string              // Monday.com item ID of the allocated vehicle
  vehicleReg: string
  driverName: string | null
  status: 'soft' | 'confirmed'  // soft = pre-assigned, confirmed = booked out
  rawStatus?: 'soft' | 'confirmed' | 'booked_out' | 'active' | 'returned' | 'cancelled'  // underlying vehicle_hire_assignments.status (compat layer collapses these into status=confirmed)
  allocatedAt: string            // ISO timestamp
  allocatedBy: string            // Staff name who made the allocation
  confirmedAt: string | null     // When booked out (null for soft allocations)
  readOnly?: boolean             // true for booked_out/active or hire-form-linked — not modifiable via allocations save
  hireFormLinked?: boolean        // true if created by hire form (has driver_id) — managed via hire forms, not allocations
}

/** Fleet-wide allocations index — single file in R2 at allocations/_index.json */
export interface AllocationsIndex {
  allocations: VanAllocation[]
  updatedAt: string              // ISO timestamp of last modification
}
