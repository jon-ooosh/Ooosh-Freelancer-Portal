/**
 * Fleet API — fetches vehicle data from Monday.com and maps to clean types.
 *
 * All Monday.com column-specific logic is isolated here.
 * When migrating away from Monday.com, only this file needs to change.
 */

import { mondayQuery, BOARD_IDS } from './monday'
import type { Vehicle } from '../types/vehicle'

// Monday.com column IDs for the Fleet Management board (4255233576)
const FLEET_COLUMNS = {
  vehicleType: 'vehicle',       // Status: PREMIUM LWB (A), etc.
  simpleType: 'status__1',      // Status: Premium, Basic, Panel, Vito
  regText: 'text2',             // Text: Vehicle reg
  make: 'status1',              // Status: MERCEDES-BENZ, VOLKSWAGEN, FORD
  model: 'status3',             // Status: SPRINTER 317 PREMIUM CDI, etc.
  colour: 'status86',           // Status: BLUE, SILVER, WHITE, GREY
  seats: 'status6',             // Status: 3, 6, 9
  damageStatus: 'status2',      // Status: ALL GOOD, BOOK REPAIR!, etc.
  serviceStatus: 'status',      // Status: OK, SERVICE BOOKED, etc.
  motDue: 'mot_date',           // Date
  taxDue: 'plate_',             // Date
  tflDue: 'tfl_9_seat_exp',     // Date
  lastServiceDate: 'date',      // Date
  lastServiceMileage: 'last_service_mileage', // Numbers
  nextServiceDue: 'next_serivce',             // Numbers (typo is in Monday)
  warrantyExpires: 'date45',    // Date
  ulezCompliant: 'status10',    // Status: YES, NO
  spareKey: 'status92',         // Status: YES, NO
  wifiNetwork: 'status23',      // Status: EE, Vodafone, THREE, N/A
  financeWith: 'label',         // Status: various finance companies
  financeEnds: 'date4',         // Date
  hireStatus: 'color_mm0v8bak', // Status: Available, On Hire, Prep Needed, Not Ready
  co2PerKm: 'text_mm13zwvw',                    // Text: CO2 g/km (for offset calculations)
  recommendedTyrePsiFront: 'numeric_mm0wd5xf', // Numbers: Front tyres recommended PSI
  recommendedTyrePsiRear: 'numeric_mm0ws7gw',  // Numbers: Rear tyres recommended PSI
} as const

/** The columns we request from Monday.com — only what the app needs */
const QUERY_COLUMN_IDS = Object.values(FLEET_COLUMNS)

/**
 * Fleet board group IDs.
 * "new_group" contains old/sold vehicles — excluded from the app.
 */
const FLEET_GROUPS = {
  currentFleet: 'topics',         // Active fleet — shown in the app
  oldAndSold: 'new_group',        // Archived — excluded from queries & alerts
  newVanInfo: 'new_group20249',   // New vehicle staging
} as const

/** Groups to query — we fetch ALL groups so old/sold are available behind a filter */
const ALL_GROUP_IDS = [FLEET_GROUPS.currentFleet, FLEET_GROUPS.newVanInfo, FLEET_GROUPS.oldAndSold]

/** Groups whose vehicles are "old & sold" — excluded by default, shown when filter selected */
const OLD_SOLD_GROUP_IDS: string[] = [FLEET_GROUPS.oldAndSold]

interface MondayColumnValue {
  id: string
  type: string
  text: string | null
  value: string | null
}

interface MondayItem {
  id: string
  name: string
  column_values: MondayColumnValue[]
}

interface MondayItemsPage {
  cursor: string | null
  items: MondayItem[]
}

/**
 * First page query — fetches from specific groups only (excludes old/sold).
 * Uses groups(ids:) -> items_page to scope to active fleet.
 */
const FIRST_PAGE_QUERY = `query ($boardId: [ID!]!, $groupIds: [String!]!, $columnIds: [String!]) {
  boards(ids: $boardId) {
    groups(ids: $groupIds) {
      id
      items_page(limit: 50) {
        cursor
        items {
          id
          name
          column_values(ids: $columnIds) { id type text value }
        }
      }
    }
  }
}`

const NEXT_PAGE_QUERY = `query ($cursor: String!, $columnIds: [String!]) {
  next_items_page(cursor: $cursor, limit: 50) {
    cursor
    items {
      id
      name
      column_values(ids: $columnIds) { id type text value }
    }
  }
}`

/**
 * Fetch ALL vehicles from Fleet Management board — including old/sold.
 * Each vehicle is tagged with isOldSold so the UI can filter them.
 * Uses cursor-based pagination to handle 25+ vehicles per group.
 */
export async function fetchAllVehicles(): Promise<Vehicle[]> {
  // First page — scoped to ALL groups (including old/sold)
  const firstResult = await mondayQuery<{
    boards: Array<{ groups: Array<{ id: string; items_page: MondayItemsPage }> }>
  }>(
    FIRST_PAGE_QUERY,
    { boardId: [BOARD_IDS.fleet], groupIds: ALL_GROUP_IDS, columnIds: QUERY_COLUMN_IDS },
  )

  // Track items alongside their old/sold status
  const taggedItems: Array<{ item: MondayItem; isOldSold: boolean }> = []
  const cursorsWithTag: Array<{ cursor: string; isOldSold: boolean }> = []

  const groups = firstResult.boards[0]?.groups || []
  for (const group of groups) {
    const isOldSold = OLD_SOLD_GROUP_IDS.includes(group.id)
    const page = group.items_page
    if (page) {
      for (const item of page.items) {
        taggedItems.push({ item, isOldSold })
      }
      if (page.cursor) cursorsWithTag.push({ cursor: page.cursor, isOldSold })
    }
  }

  // Follow cursors for any groups with more pages
  for (const { cursor: initialCursor, isOldSold } of cursorsWithTag) {
    let cursor: string | null = initialCursor
    while (cursor) {
      const cursorToFetch = cursor
      const nextResult: { next_items_page: MondayItemsPage } = await mondayQuery(
        NEXT_PAGE_QUERY,
        { cursor: cursorToFetch, columnIds: QUERY_COLUMN_IDS },
      )
      const nextPage: MondayItemsPage | undefined = nextResult.next_items_page
      if (!nextPage) break
      for (const item of nextPage.items) {
        taggedItems.push({ item, isOldSold })
      }
      cursor = nextPage.cursor
    }
  }

  return taggedItems.map(({ item, isOldSold }) => mapMondayItemToVehicle(item, isOldSold))
}

/**
 * Maps a Monday.com item to our clean Vehicle type.
 */
function mapMondayItemToVehicle(item: MondayItem, isOldSold: boolean): Vehicle {
  const col = (id: string): string | null => {
    const cv = item.column_values.find(c => c.id === id)
    return cv?.text || null
  }

  const numCol = (id: string): number | null => {
    const text = col(id)
    if (!text) return null
    const n = parseFloat(text)
    return isNaN(n) ? null : n
  }

  const dateCol = (id: string): string | null => {
    const text = col(id)
    // Monday dates come as "YYYY-MM-DD" in the text field
    if (!text || text.length < 10) return null
    return text.substring(0, 10)
  }

  const boolCol = (id: string): boolean => {
    return col(id) === 'YES'
  }

  const seatsText = col(FLEET_COLUMNS.seats)
  const seats = seatsText ? parseInt(seatsText, 10) : null

  return {
    id: item.id,
    reg: col(FLEET_COLUMNS.regText) || item.name,
    vehicleType: col(FLEET_COLUMNS.vehicleType) || '',
    simpleType: col(FLEET_COLUMNS.simpleType) || '',
    make: col(FLEET_COLUMNS.make) || '',
    model: col(FLEET_COLUMNS.model) || '',
    colour: col(FLEET_COLUMNS.colour) || '',
    seats: isNaN(seats!) ? null : seats,
    damageStatus: col(FLEET_COLUMNS.damageStatus) || '',
    serviceStatus: col(FLEET_COLUMNS.serviceStatus) || '',
    motDue: dateCol(FLEET_COLUMNS.motDue),
    taxDue: dateCol(FLEET_COLUMNS.taxDue),
    tflDue: dateCol(FLEET_COLUMNS.tflDue),
    lastServiceDate: dateCol(FLEET_COLUMNS.lastServiceDate),
    warrantyExpires: dateCol(FLEET_COLUMNS.warrantyExpires),
    lastServiceMileage: numCol(FLEET_COLUMNS.lastServiceMileage),
    nextServiceDue: numCol(FLEET_COLUMNS.nextServiceDue),
    ulezCompliant: boolCol(FLEET_COLUMNS.ulezCompliant),
    spareKey: boolCol(FLEET_COLUMNS.spareKey),
    wifiNetwork: col(FLEET_COLUMNS.wifiNetwork),
    financeWith: col(FLEET_COLUMNS.financeWith),
    financeEnds: dateCol(FLEET_COLUMNS.financeEnds),
    hireStatus: col(FLEET_COLUMNS.hireStatus) || '',
    co2PerKm: (() => {
      const raw = col(FLEET_COLUMNS.co2PerKm)
      if (!raw) return null
      const n = parseFloat(raw.replace(/[^\d.]/g, ''))
      return isNaN(n) ? null : n
    })(),
    recommendedTyrePsiFront: numCol(FLEET_COLUMNS.recommendedTyrePsiFront),
    recommendedTyrePsiRear: numCol(FLEET_COLUMNS.recommendedTyrePsiRear),
    isOldSold,
  }
}
