/**
 * Driver Hire Forms API — fetches and updates driver/hire data on Monday.com.
 *
 * Board ID 841453886 contains hire form submissions with driver details,
 * hire dates, and HireHop job numbers. Used to auto-populate book-out forms,
 * match drivers to vehicles, and write back book-out data.
 *
 * Column IDs are configurable via env vars for flexibility.
 */

import { mondayQuery, BOARD_IDS } from './monday'

/** Convert 12hr "09:00 AM" or "02:30 PM" to 24hr "09:00" / "14:30". Passes through "HH:mm" unchanged. */
function convertTo24hr(timeStr: string): string {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
  if (!match) return timeStr // already 24hr or unrecognised — pass through
  let hour = parseInt(match[1]!, 10)
  const minute = match[2]!
  const period = match[3]!.toUpperCase()
  if (period === 'AM' && hour === 12) hour = 0
  else if (period === 'PM' && hour !== 12) hour += 12
  return `${String(hour).padStart(2, '0')}:${minute}`
}

// Column IDs on the Driver Hire Forms board (841453886)
const HIRE_FORM_COLUMNS = {
  hireHopJob: 'text86',              // HireHop job number
  driverNameAlt: 'text8',            // Driver name (alternative to item name)
  hireStart: 'date46',              // Hire start date
  hireEnd: 'date14',                // Hire end date
  clientEmail: 'email',             // Client email
  excess: 'lookup_mkwt9hk',         // Excess amount (mirrored/lookup column)
  startTime: 'hour',                // Hire start time
  endTime: 'hour6',                 // Hire end time
  ve103b: 'text_mkyha3gm',          // VE103b reference
  returnOvernight: 'status_1',       // Return overnight (Yes / No / Don't know)
} as const

// Write-back column IDs — updated after book-out.
// These columns exist on the Driver Hire Forms board (841453886).
const HIRE_FORM_WRITEBACK_COLUMNS = {
  vehicleReg: 'text_mky48c3g',            // Text: vehicle registration assigned
  mileageOut: 'text_mm13qzb',             // Text: odometer reading at book-out
  status: 'color_mkx1kryv',               // Status: set to "Book van OUT" to trigger automations
  startTime: 'hour',                       // Hire start time (HH:mm)
  endTime: 'hour6',                        // Hire end time (HH:mm)
  ve103b: 'text_mkyha3gm',                // VE103b reference
  returnOvernight: 'status_1',             // Return overnight (Yes / No / Don't know)
} as const

const ALL_COLUMN_IDS = Object.values(HIRE_FORM_COLUMNS)

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

/** Parsed driver hire form entry */
export interface DriverHireForm {
  id: string                          // Monday.com item ID
  driverName: string                  // Driver name (from item name or text8 column)
  hireHopJob: string | null           // HireHop job number
  hireStart: string | null            // YYYY-MM-DD
  hireEnd: string | null              // YYYY-MM-DD
  clientEmail: string | null          // Client email
  excess: string | null               // Excess amount (mirrored from linked board)
  startTime: string | null            // Hire start time (HH:mm)
  endTime: string | null              // Hire end time (HH:mm)
  ve103b: string | null               // VE103b reference
  returnOvernight: string | null      // "Yes" | "No" | "Don't know"
}

/**
 * Fetch driver hire forms matching a HireHop job number.
 *
 * Returns all hire form entries that have the given job number,
 * which may include multiple drivers for multi-van jobs.
 */
export async function fetchHireFormsByJobNumber(
  hireHopJobNumber: string,
): Promise<DriverHireForm[]> {
  const columnIdsStr = ALL_COLUMN_IDS.map(id => `"${id}"`).join(', ')

  // Use items_page_by_column_values at root level with inline board_id
  // (same pattern as events-query.ts — proven to work with Monday.com API)
  const query = `query {
    items_page_by_column_values (
      board_id: ${BOARD_IDS.driverHireForms},
      limit: 20,
      columns: [
        { column_id: "${HIRE_FORM_COLUMNS.hireHopJob}", column_values: ["${hireHopJobNumber}"] }
      ]
    ) {
      items {
        id
        name
        column_values(ids: [${columnIdsStr}]) { id type text value }
      }
    }
  }`

  try {
    console.log('[driver-hire-api] Fetching hire forms for job:', hireHopJobNumber)

    const data = await mondayQuery<{
      items_page_by_column_values: { items: MondayItem[] }
    }>(query)

    const items = data.items_page_by_column_values?.items || []
    console.log('[driver-hire-api] Found', items.length, 'hire form(s) for job', hireHopJobNumber)

    return items.map(parseHireFormItem)
  } catch (err) {
    console.error('[driver-hire-api] Failed to fetch hire forms:', err)
    return []
  }
}

/**
 * Fetch all active hire forms (for a date range).
 * Useful for cross-referencing upcoming jobs with registered drivers.
 */
export async function fetchActiveHireForms(): Promise<DriverHireForm[]> {
  const columnIdsStr = ALL_COLUMN_IDS.map(id => `"${id}"`).join(', ')

  const query = `query {
    boards(ids: [${BOARD_IDS.driverHireForms}]) {
      items_page(limit: 100) {
        items {
          id
          name
          column_values(ids: [${columnIdsStr}]) { id type text value }
        }
      }
    }
  }`

  try {
    console.log('[driver-hire-api] Fetching active hire forms')

    const data = await mondayQuery<{
      boards: Array<{ items_page: { items: MondayItem[] } }>
    }>(query)

    const items = data.boards?.[0]?.items_page?.items || []
    console.log('[driver-hire-api] Found', items.length, 'active hire form(s)')

    return items.map(parseHireFormItem)
  } catch (err) {
    console.error('[driver-hire-api] Failed to fetch active hire forms:', err)
    return []
  }
}

/** Parse a Monday.com item into a DriverHireForm */
function parseHireFormItem(item: MondayItem): DriverHireForm {
  const getCol = (colId: string) =>
    item.column_values.find(cv => cv.id === colId)

  const getColText = (colId: string) => getCol(colId)?.text || null

  // Parse date from value JSON (Monday returns { date: "YYYY-MM-DD" })
  const getDateText = (colId: string) => {
    const col = getCol(colId)
    if (col?.text) return col.text
    if (col?.value) {
      try {
        const parsed = JSON.parse(col.value) as { date?: string }
        return parsed.date || null
      } catch { return null }
    }
    return null
  }

  // Driver name: prefer the text8 column if set, fall back to item name
  const altName = getColText(HIRE_FORM_COLUMNS.driverNameAlt)
  const driverName = altName || item.name

  // Email: Monday email columns return JSON value like { email: "x@y.com", text: "x@y.com" }
  let clientEmail = getColText(HIRE_FORM_COLUMNS.clientEmail)
  if (!clientEmail) {
    const emailCol = getCol(HIRE_FORM_COLUMNS.clientEmail)
    if (emailCol?.value) {
      try {
        const parsed = JSON.parse(emailCol.value) as { email?: string }
        clientEmail = parsed.email || null
      } catch { /* ignore */ }
    }
  }

  // Hour columns return JSON value like { hour: 14, minute: 30 } or text "14:30"
  // IMPORTANT: Parse value JSON first (gives 24hr), then fall back to text (may be 12hr AM/PM)
  const getTimeText = (colId: string) => {
    const col = getCol(colId)
    // Try structured value first — always gives clean 24hr format
    if (col?.value) {
      try {
        const parsed = JSON.parse(col.value) as { hour?: number; minute?: number }
        if (parsed.hour != null) {
          return `${String(parsed.hour).padStart(2, '0')}:${String(parsed.minute ?? 0).padStart(2, '0')}`
        }
      } catch { /* ignore */ }
    }
    // Fall back to text — may be "09:00 AM" format, convert to 24hr
    if (col?.text) {
      return convertTo24hr(col.text)
    }
    return null
  }

  return {
    id: item.id,
    driverName,
    hireHopJob: getColText(HIRE_FORM_COLUMNS.hireHopJob),
    hireStart: getDateText(HIRE_FORM_COLUMNS.hireStart),
    hireEnd: getDateText(HIRE_FORM_COLUMNS.hireEnd),
    clientEmail,
    excess: getColText(HIRE_FORM_COLUMNS.excess),
    startTime: getTimeText(HIRE_FORM_COLUMNS.startTime),
    endTime: getTimeText(HIRE_FORM_COLUMNS.endTime),
    ve103b: getColText(HIRE_FORM_COLUMNS.ve103b),
    returnOvernight: getColText(HIRE_FORM_COLUMNS.returnOvernight),
  }
}

// ── Write-back after book-out ──

/** Escape a JSON string for embedding inside a GraphQL string literal */
function escapeJson(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Write book-out data back to a driver's hire form entry on Monday.com.
 *
 * Called after a successful book-out to record which vehicle was assigned
 * and the mileage reading. Also sets status to "Book van OUT" which triggers
 * Monday.com automations (creating hire form, moving to On Hire, etc.).
 *
 * Fails gracefully — a write-back failure should not block the book-out flow.
 */
export async function updateDriverHireForm(params: {
  hireFormItemId: string
  vehicleReg?: string
  mileageOut?: number
  startTime?: string            // "HH:mm" format
  endTime?: string              // "HH:mm" format
  ve103b?: string
  returnOvernight?: string      // "Yes" | "No" | "Don't know"
}): Promise<{ success: boolean; error?: string }> {
  const columnValues: Record<string, unknown> = {}

  if (params.vehicleReg) {
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.vehicleReg] = params.vehicleReg
  }

  if (params.mileageOut != null) {
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.mileageOut] = String(params.mileageOut)
  }

  // Hour columns accept { hour: N, minute: N } JSON format
  if (params.startTime) {
    const [h, m] = params.startTime.split(':').map(Number)
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.startTime] = { hour: h, minute: m || 0 }
  }

  if (params.endTime) {
    const [h, m] = params.endTime.split(':').map(Number)
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.endTime] = { hour: h, minute: m || 0 }
  }

  if (params.ve103b) {
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.ve103b] = params.ve103b
  }

  if (params.returnOvernight) {
    columnValues[HIRE_FORM_WRITEBACK_COLUMNS.returnOvernight] = { label: params.returnOvernight }
  }

  // Set status to "Book van OUT" — triggers Monday.com automations
  columnValues[HIRE_FORM_WRITEBACK_COLUMNS.status] = { label: 'Book van OUT' }

  if (Object.keys(columnValues).length === 0) {
    return { success: true }
  }

  const escapedValues = escapeJson(JSON.stringify(columnValues))

  const mutation = `
    mutation {
      change_multiple_column_values (
        item_id: ${params.hireFormItemId},
        board_id: ${BOARD_IDS.driverHireForms},
        column_values: "${escapedValues}"
      ) {
        id
      }
    }
  `

  try {
    console.log('[driver-hire-api] Writing back to hire form', params.hireFormItemId, ':', JSON.stringify(columnValues))
    await mondayQuery(mutation)
    console.log('[driver-hire-api] Write-back successful for item', params.hireFormItemId)
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Write-back failed'
    console.error('[driver-hire-api] Write-back failed for item', params.hireFormItemId, ':', errMsg)
    return { success: false, error: errMsg }
  }
}
