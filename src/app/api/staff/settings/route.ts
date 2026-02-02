/**
 * Staff Settings API
 * 
 * GET /api/staff/settings
 * 
 * Fetches the costing settings from the D&C Settings Monday.com board.
 * These values are used by the Crew & Transport wizard for calculations.
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const DC_SETTINGS_BOARD_ID = process.env.MONDAY_BOARD_ID_DC_SETTINGS || '18398014955'

// Column IDs from the D&C Settings board
const COLUMN_IDS = {
  name: 'text_mm06r49x',
  fuelPricePerLitre: 'numeric_mm062p94',
  expenseMarkupPercent: 'numeric_mm06gkff',
  adminCostPerHour: 'numeric_mm06f6zw',
  handoverTimeMinutes: 'numeric_mm06k1wq',
  unloadTimeMinutes: 'numeric_mm062qhz',
  minHoursThreshold: 'numeric_mm06tfv5',
  hourlyRateFreelancerDay: 'numeric_mm06p0aw',
  hourlyRateFreelancerNight: 'numeric_mm065da0',
  hourlyRateClientDay: 'numeric_mm06saeq',
  hourlyRateClientNight: 'numeric_mm06b0vx',
  driverDayRate: 'numeric_mm06ht23',
  expenseVarianceThreshold: 'numeric_mm06bqrf',
}

export interface CostingSettings {
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

// Default values - ONLY used as fallback when board fetch fails
// These should match what's in the D&C Settings board
const DEFAULT_SETTINGS: CostingSettings = {
  fuelPricePerLitre: 1.35,
  expenseMarkupPercent: 10,
  adminCostPerHour: 5,
  handoverTimeMinutes: 20,
  unloadTimeMinutes: 20,
  minHoursThreshold: 5,
  hourlyRateFreelancerDay: 15,
  hourlyRateFreelancerNight: 20,
  hourlyRateClientDay: 18,
  hourlyRateClientNight: 23,
  driverDayRate: 250,
  expenseVarianceThreshold: 10,
}

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

function parseNumericValue(text: string | undefined | null): number | null {
  if (!text) return null
  const parsed = parseFloat(text)
  return isNaN(parsed) ? null : parsed
}

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

    console.log('Staff Settings: Fetching settings from board', DC_SETTINGS_BOARD_ID)

    // Fetch the first item from the settings board
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
      console.warn('Staff Settings: No settings found in board, using defaults')
      return NextResponse.json({
        success: true,
        settings: DEFAULT_SETTINGS,
        source: 'defaults',
        warning: 'D&C Settings board is empty - please add an item with your rates'
      })
    }

    const item = items[0]
    const columns = item.column_values.reduce((acc, col) => {
      acc[col.id] = col.text
      return acc
    }, {} as Record<string, string>)

    // Map column values to settings object, falling back to defaults for missing values
    const settings: CostingSettings = {
      fuelPricePerLitre: parseNumericValue(columns[COLUMN_IDS.fuelPricePerLitre]) ?? DEFAULT_SETTINGS.fuelPricePerLitre,
      expenseMarkupPercent: parseNumericValue(columns[COLUMN_IDS.expenseMarkupPercent]) ?? DEFAULT_SETTINGS.expenseMarkupPercent,
      adminCostPerHour: parseNumericValue(columns[COLUMN_IDS.adminCostPerHour]) ?? DEFAULT_SETTINGS.adminCostPerHour,
      handoverTimeMinutes: parseNumericValue(columns[COLUMN_IDS.handoverTimeMinutes]) ?? DEFAULT_SETTINGS.handoverTimeMinutes,
      unloadTimeMinutes: parseNumericValue(columns[COLUMN_IDS.unloadTimeMinutes]) ?? DEFAULT_SETTINGS.unloadTimeMinutes,
      minHoursThreshold: parseNumericValue(columns[COLUMN_IDS.minHoursThreshold]) ?? DEFAULT_SETTINGS.minHoursThreshold,
      hourlyRateFreelancerDay: parseNumericValue(columns[COLUMN_IDS.hourlyRateFreelancerDay]) ?? DEFAULT_SETTINGS.hourlyRateFreelancerDay,
      hourlyRateFreelancerNight: parseNumericValue(columns[COLUMN_IDS.hourlyRateFreelancerNight]) ?? DEFAULT_SETTINGS.hourlyRateFreelancerNight,
      hourlyRateClientDay: parseNumericValue(columns[COLUMN_IDS.hourlyRateClientDay]) ?? DEFAULT_SETTINGS.hourlyRateClientDay,
      hourlyRateClientNight: parseNumericValue(columns[COLUMN_IDS.hourlyRateClientNight]) ?? DEFAULT_SETTINGS.hourlyRateClientNight,
      driverDayRate: parseNumericValue(columns[COLUMN_IDS.driverDayRate]) ?? DEFAULT_SETTINGS.driverDayRate,
      expenseVarianceThreshold: parseNumericValue(columns[COLUMN_IDS.expenseVarianceThreshold]) ?? DEFAULT_SETTINGS.expenseVarianceThreshold,
    }

    // Check if any settings came from defaults (missing in board)
    const missingFields: string[] = []
    if (!columns[COLUMN_IDS.fuelPricePerLitre]) missingFields.push('Fuel Price')
    if (!columns[COLUMN_IDS.hourlyRateFreelancerDay]) missingFields.push('Freelancer Day Rate')
    if (!columns[COLUMN_IDS.hourlyRateClientDay]) missingFields.push('Client Day Rate')
    if (!columns[COLUMN_IDS.driverDayRate]) missingFields.push('Driver Day Rate')

    console.log('Staff Settings: Loaded settings from Monday.com', 
      missingFields.length > 0 ? `(missing: ${missingFields.join(', ')})` : '')

    return NextResponse.json({
      success: true,
      settings,
      source: missingFields.length > 0 ? 'partial' : 'monday',
      ...(missingFields.length > 0 && { 
        warning: `Some settings missing from board (using defaults): ${missingFields.join(', ')}` 
      })
    })

  } catch (error) {
    console.error('Staff Settings error:', error)
    // Return defaults but flag it clearly as a fallback
    return NextResponse.json({
      success: true,
      settings: DEFAULT_SETTINGS,
      source: 'defaults',
      warning: 'Failed to fetch from Monday.com - using defaults'
    })
  }
}