/**
 * Issues API — creates vehicle issues on the Monday.com Issues board.
 *
 * Used during check-in when damage is flagged.
 * Follows the same escapeJson + inline mutation pattern as events-api.ts.
 */

import { mondayQuery, BOARD_IDS } from './monday'

// Monday.com column IDs for the Issues board (18400365329)
const ISSUE_COLUMNS = {
  issueType: 'color_mm0ns0mc',         // Status: Damage, Mechanical, etc.
  severity: 'color_mm0nvxps',          // Status: Critical, Major, Minor
  status: 'color_mm0nntmm',           // Status: New, Acknowledged, etc.
  locationOnVehicle: 'color_mm0nb57g', // Status: Front Left, Rear Right, etc.
  description: 'long_text_mm0nek9p',   // Long Text
  vehicleReg: 'text_mm0ng16j',        // Text
  reportedDate: 'date_mm0ntfsh',       // Date
  quoteAmount: 'numeric_mm0n60h7',     // Number
  clientChargeable: 'boolean_mm0nnx9r', // Checkbox
} as const

/** Escape a JSON string for embedding inside a GraphQL string literal */
function escapeJson(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export interface CreateIssueParams {
  vehicleReg: string
  issueType: 'Damage' | 'Mechanical' | 'Electrical' | 'Cosmetic' | 'Safety' | 'Missing Item'
  severity: 'Critical' | 'Major' | 'Minor'
  locationOnVehicle?: string  // Front Left, Front Right, Rear Left, etc.
  description: string
  reportedDate?: string       // YYYY-MM-DD, defaults to today
  clientChargeable?: boolean
}

/**
 * Create a vehicle issue on the Monday.com Issues board.
 * Returns the created item ID.
 */
export async function createIssue(
  params: CreateIssueParams,
): Promise<{ id: string; error?: string }> {
  const dateStr = params.reportedDate || new Date().toISOString().split('T')[0]!
  const itemName = `${params.vehicleReg} - ${params.issueType} - ${params.severity}`

  const columnValues: Record<string, unknown> = {
    [ISSUE_COLUMNS.issueType]: { label: params.issueType },
    [ISSUE_COLUMNS.severity]: { label: params.severity },
    [ISSUE_COLUMNS.status]: { label: 'New' },
    [ISSUE_COLUMNS.vehicleReg]: params.vehicleReg,
    [ISSUE_COLUMNS.reportedDate]: { date: dateStr },
    [ISSUE_COLUMNS.description]: params.description,
  }

  if (params.locationOnVehicle) {
    columnValues[ISSUE_COLUMNS.locationOnVehicle] = { label: params.locationOnVehicle }
  }

  if (params.clientChargeable) {
    columnValues[ISSUE_COLUMNS.clientChargeable] = { checked: 'true' }
  }

  const escapedColumnValues = escapeJson(JSON.stringify(columnValues))
  const safeName = itemName.replace(/"/g, '\\"')

  const mutation = `
    mutation {
      create_item (
        board_id: ${BOARD_IDS.issues},
        item_name: "${safeName}",
        column_values: "${escapedColumnValues}"
      ) {
        id
      }
    }
  `

  try {
    console.log('[issues-api] Creating issue:', itemName)
    const result = await mondayQuery<{ create_item: { id: string } }>(mutation)
    const itemId = result.create_item.id
    console.log('[issues-api] Issue created successfully, ID:', itemId)
    return { id: itemId }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Issue creation failed'
    console.error('[issues-api] Issue creation failed:', errMsg)
    return { id: `local_${Date.now()}`, error: errMsg }
  }
}
