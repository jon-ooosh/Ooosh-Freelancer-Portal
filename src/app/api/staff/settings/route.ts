/**
 * Staff Settings API
 * 
 * GET /api/staff/settings - Fetch costing settings from D&C Settings board
 * 
 * Reads configurable rates and thresholds used by the Crew & Transport wizard.
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const DC_SETTINGS_BOARD_ID = process.env.MONDAY_BOARD_ID_DC_SETTINGS || '18398014955'

// =============================================================================
// COLUMN IDS - D&C Settings Board (18398014955)
// These are the CORRECT column IDs as confirmed by Jon
// =============================================================================
const SETTINGS_COLUMNS = {
  // Rates
  hourlyRateFreelancerDay: 'numeric_mm06p0aw',
  hourlyRateFreelancerNight: 'numeric_mm065da0',
  hourlyRateClientDay: 'numeric_mm06saeq',
  hourlyRateClientNight: 'numeric_mm06b0vx',
  adminCostPerHour: 'numeric_mm06f6zw',
  driverDayRate: 'numeric_mm06ht23',
  
  // Thresholds and multipliers
  expenseMarkupPercent: 'numeric_mm06gkff',
  minHoursThreshold: 'numeric_mm06tfv5',
  
  // Time allowances (in minutes)
  handoverTimeMinutes: 'numeric_mm06k1wq',
  unloadTimeMinutes: 'numeric_mm062qhz',
  
  // These may need to be added or confirmed later
  fuelPricePerLitre: 'numeric_mm06n1k9',  // If this doesn't exist, we'll use default
  expenseVarianceThreshold: 'numeric_mm06v2x8',  // For expense tracking phase
}

// =============================================================================
// DEFAULT VALUES (fallback if board not populated)
// =============================================================================
const DEFAULT_SETTINGS = {
  // Rates (in GBP)
  hourlyRateFreelancerDay: 18,
  hourlyRateFreelancerNight: 25,
  hourlyRateClientDay: 33,
  hourlyRateClientNight: 45,
  adminCostPerHour: 5,
  driverDayRate: 180,
  
  // Thresholds
  expenseMarkupPercent: 10,
  minHoursThreshold: 5,  // Minimum 5-hour call
  expenseVarianceThreshold: 10,
  
  // Time allowances (minutes)
  handoverTimeMinutes: 15,  // For vehicle handover
  unloadTimeMinutes: 30,    // For equipment unload
  
  // Fuel
  fuelPricePerLitre: 1.45,
}

// =============================================================================
// TYPES
// =============================================================================

interface CostingSettings {
  fuelPricePerLitre: number
  expenseMarkupPercent: number
  adminCostPerHour: number
  handoverTimeMinutes: number
  unloadTimeMinutes: number
  minHoursThreshold: number
  hourlyRateFreelancerDay: number
  hourlyRateFreelancerNight: number
  hourlyRateClientDay: number
  hourlyRateClientNight: number
  driverDayRate: number
  expenseVarianceThreshold: number
}

// =============================================================================
// MONDAY API HELPER
// =============================================================================

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) throw new Error('MONDAY_API_TOKEN not configured')

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-10',
    },
    body: JSON.stringify({ query, variables }),
  })

  const data = await response.json()
  if (data.errors) {
    console.error('Monday API errors:', data.errors)
    throw new Error(JSON.stringify(data.errors))
  }
  return data.data as T
}

// =============================================================================
// GET HANDLER
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Verify staff PIN
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    
    if (!staffPin || pin !== staffPin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Build list of column IDs to fetch
    const columnIds = Object.values(SETTINGS_COLUMNS)

    // Fetch settings from Monday board
    const query = `
      query ($boardId: ID!) {
        boards(ids: [$boardId]) {
          items_page(limit: 1) {
            items {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        }
      }
    `

    const result = await mondayQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string
            name: string
            column_values: Array<{
              id: string
              text: string
              value: string
            }>
          }>
        }
      }>
    }>(query, { boardId: DC_SETTINGS_BOARD_ID })

    const items = result.boards?.[0]?.items_page?.items || []
    
    if (items.length === 0) {
      console.warn('Settings: No items found in D&C Settings board, using defaults')
      return NextResponse.json({
        success: true,
        settings: DEFAULT_SETTINGS,
        source: 'defaults',
      })
    }

    // Parse column values into settings object
    const item = items[0]
    const columnMap = new Map<string, string>()
    
    for (const col of item.column_values) {
      // For numeric columns, the 'text' field contains the display value
      columnMap.set(col.id, col.text || '')
    }

    // Helper to get numeric value with fallback
    const getNumeric = (columnId: string, defaultValue: number): number => {
      const text = columnMap.get(columnId)
      if (!text) return defaultValue
      const parsed = parseFloat(text)
      return isNaN(parsed) ? defaultValue : parsed
    }

    // Build settings object with values from board (or defaults)
    const settings: CostingSettings = {
      hourlyRateFreelancerDay: getNumeric(SETTINGS_COLUMNS.hourlyRateFreelancerDay, DEFAULT_SETTINGS.hourlyRateFreelancerDay),
      hourlyRateFreelancerNight: getNumeric(SETTINGS_COLUMNS.hourlyRateFreelancerNight, DEFAULT_SETTINGS.hourlyRateFreelancerNight),
      hourlyRateClientDay: getNumeric(SETTINGS_COLUMNS.hourlyRateClientDay, DEFAULT_SETTINGS.hourlyRateClientDay),
      hourlyRateClientNight: getNumeric(SETTINGS_COLUMNS.hourlyRateClientNight, DEFAULT_SETTINGS.hourlyRateClientNight),
      adminCostPerHour: getNumeric(SETTINGS_COLUMNS.adminCostPerHour, DEFAULT_SETTINGS.adminCostPerHour),
      driverDayRate: getNumeric(SETTINGS_COLUMNS.driverDayRate, DEFAULT_SETTINGS.driverDayRate),
      expenseMarkupPercent: getNumeric(SETTINGS_COLUMNS.expenseMarkupPercent, DEFAULT_SETTINGS.expenseMarkupPercent),
      minHoursThreshold: getNumeric(SETTINGS_COLUMNS.minHoursThreshold, DEFAULT_SETTINGS.minHoursThreshold),
      handoverTimeMinutes: getNumeric(SETTINGS_COLUMNS.handoverTimeMinutes, DEFAULT_SETTINGS.handoverTimeMinutes),
      unloadTimeMinutes: getNumeric(SETTINGS_COLUMNS.unloadTimeMinutes, DEFAULT_SETTINGS.unloadTimeMinutes),
      fuelPricePerLitre: getNumeric(SETTINGS_COLUMNS.fuelPricePerLitre, DEFAULT_SETTINGS.fuelPricePerLitre),
      expenseVarianceThreshold: getNumeric(SETTINGS_COLUMNS.expenseVarianceThreshold, DEFAULT_SETTINGS.expenseVarianceThreshold),
    }

    console.log('Settings: Loaded from D&C Settings board:', item.name)
    console.log('Settings values:', JSON.stringify(settings, null, 2))

    return NextResponse.json({
      success: true,
      settings,
      source: 'board',
      itemName: item.name,
    })

  } catch (error) {
    console.error('Settings API error:', error)
    
    // Return defaults on error so wizard can still function
    return NextResponse.json({
      success: true,
      settings: DEFAULT_SETTINGS,
      source: 'defaults',
      error: error instanceof Error ? error.message : 'Failed to load settings',
    })
  }
}