/**
 * Fleet Status API — updates hire status on the Fleet Master board.
 *
 * Called from book-out (set "On Hire") and check-in (set "Prep Needed").
 * Uses change_multiple_column_values with the proven escapeJson pattern.
 */

import { mondayQuery, BOARD_IDS } from './monday'

// Fleet Master board column for hire status
const FLEET_HIRE_STATUS_COLUMN = 'color_mm0v8bak'

type HireStatus = 'Available' | 'On Hire' | 'Collected' | 'Prep Needed' | 'Not Ready'

/** Escape a JSON string for embedding inside a GraphQL string literal */
function escapeJson(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Update the hire status on the Fleet Master board for a vehicle.
 *
 * @param vehicleItemId - The Monday.com item ID of the vehicle (from fleet board)
 * @param status - The new hire status label
 */
export async function updateFleetHireStatus(
  vehicleItemId: string,
  status: HireStatus,
): Promise<{ success: boolean; error?: string }> {
  const columnValues: Record<string, unknown> = {
    [FLEET_HIRE_STATUS_COLUMN]: { label: status },
  }

  const escapedValues = escapeJson(JSON.stringify(columnValues))

  const mutation = `
    mutation {
      change_multiple_column_values (
        item_id: ${vehicleItemId},
        board_id: ${BOARD_IDS.fleet},
        column_values: "${escapedValues}"
      ) {
        id
      }
    }
  `

  try {
    console.log('[fleet-status] Updating hire status for item', vehicleItemId, 'to', status)
    await mondayQuery(mutation)
    console.log('[fleet-status] Status updated successfully')
    return { success: true }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Status update failed'
    console.error('[fleet-status] Update failed:', errMsg)
    return { success: false, error: errMsg }
  }
}
