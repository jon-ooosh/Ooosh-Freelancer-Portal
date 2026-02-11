/**
 * Venues API
 * 
 * GET /api/staff/venues - Fetch all venues for dropdown
 * POST /api/staff/venues - Create new venue
 * PATCH /api/staff/venues - Update venue distance/time/expenses
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const VENUES_BOARD_ID = process.env.MONDAY_BOARD_ID_VENUES || '2406443142'

// Column IDs for Venues board
const VENUE_COLUMNS = {
  name: 'text43',                            // Venue name (also item name)
  address: 'long_text',                      // Address (long text)
  distance: 'numeric_mm07y9eq',              // Distance (miles, one-way)
  driveTime: 'numeric_mm074a1k',             // Drive Time (minutes, one-way)
  publicTransportTime: 'numeric_mm0735e',    // Public transport - Travel Time (mins)
  publicTransportCost: 'numeric_mm07jwvc',   // Public transport - Ticket Cost (£)
  tollsParking: 'numeric_mm07cvgv',          // Tolls / Parking / Crossings (£)
}

// All column IDs we need to fetch
const FETCH_COLUMN_IDS = [
  VENUE_COLUMNS.address,
  VENUE_COLUMNS.distance,
  VENUE_COLUMNS.driveTime,
  VENUE_COLUMNS.publicTransportTime,
  VENUE_COLUMNS.publicTransportCost,
  VENUE_COLUMNS.tollsParking,
]

// Venue item type from Monday API
interface VenueItem {
  id: string
  name: string
  column_values: Array<{
    id: string
    text: string
    value: string
  }>
}

// Processed venue type for frontend
interface ProcessedVenue {
  id: string
  name: string
  address: string | null
  distance: number | null
  driveTime: number | null
  publicTransportTime: number | null
  publicTransportCost: number | null
  tollsParking: number | null
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
// HELPER: Process venue items into clean format
// =============================================================================

function processVenueItems(items: VenueItem[]): ProcessedVenue[] {
  return items.map(item => {
    const columns = item.column_values.reduce((acc, col) => {
      acc[col.id] = col.text
      return acc
    }, {} as Record<string, string>)

    return {
      id: item.id,
      name: item.name,
      address: columns[VENUE_COLUMNS.address] || null,
      distance: columns[VENUE_COLUMNS.distance] ? parseFloat(columns[VENUE_COLUMNS.distance]) : null,
      driveTime: columns[VENUE_COLUMNS.driveTime] ? parseFloat(columns[VENUE_COLUMNS.driveTime]) : null,
      publicTransportTime: columns[VENUE_COLUMNS.publicTransportTime] ? parseFloat(columns[VENUE_COLUMNS.publicTransportTime]) : null,
      publicTransportCost: columns[VENUE_COLUMNS.publicTransportCost] ? parseFloat(columns[VENUE_COLUMNS.publicTransportCost]) : null,
      tollsParking: columns[VENUE_COLUMNS.tollsParking] ? parseFloat(columns[VENUE_COLUMNS.tollsParking]) : null,
    }
  })
}

// =============================================================================
// HELPER: Fetch first page of venues
// =============================================================================

async function fetchFirstPage(): Promise<{ items: VenueItem[]; cursor: string | null }> {
  const columnIds = FETCH_COLUMN_IDS.map(id => `"${id}"`).join(', ')
  
  const query = `
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500) {
          cursor
          items {
            id
            name
            column_values(ids: [${columnIds}]) {
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
        cursor: string | null
        items: VenueItem[]
      }
    }>
  }>(query, { boardId: VENUES_BOARD_ID })

  const itemsPage = result.boards?.[0]?.items_page
  return {
    items: itemsPage?.items || [],
    cursor: itemsPage?.cursor || null,
  }
}

// =============================================================================
// HELPER: Fetch next page of venues
// =============================================================================

async function fetchNextPage(cursor: string): Promise<{ items: VenueItem[]; cursor: string | null }> {
  const columnIds = FETCH_COLUMN_IDS.map(id => `"${id}"`).join(', ')
  
  const query = `
    query ($cursor: String!) {
      next_items_page(cursor: $cursor, limit: 500) {
        cursor
        items {
          id
          name
          column_values(ids: [${columnIds}]) {
            id
            text
            value
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    next_items_page: {
      cursor: string | null
      items: VenueItem[]
    }
  }>(query, { cursor })

  return {
    items: result.next_items_page?.items || [],
    cursor: result.next_items_page?.cursor || null,
  }
}

// =============================================================================
// GET - Fetch all venues
// =============================================================================

export async function GET(request: NextRequest) {
  try {
    // Verify staff PIN (also accept hub auth marker for Staff Hub sessions)
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    const HUB_AUTH_MARKER = '__HUB_AUTH__'
    
    if (!staffPin || (pin !== staffPin && pin !== HUB_AUTH_MARKER)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    console.log('Venues API: Fetching all venues from board', VENUES_BOARD_ID)

    const allVenues: ProcessedVenue[] = []
    const maxPages = 5 // Safety limit: 5 pages × 500 = 2500 venues max

    // Fetch first page
    const firstPage = await fetchFirstPage()
    allVenues.push(...processVenueItems(firstPage.items))
    console.log(`Venues API: Fetched page 1, got ${firstPage.items.length} items`)

    // Fetch additional pages if needed
    let currentCursor = firstPage.cursor
    let pageCount = 1
    
    while (currentCursor && pageCount < maxPages) {
      const nextPage = await fetchNextPage(currentCursor)
      allVenues.push(...processVenueItems(nextPage.items))
      currentCursor = nextPage.cursor
      pageCount++
      console.log(`Venues API: Fetched page ${pageCount}, got ${nextPage.items.length} items, total: ${allVenues.length}`)
    }

    // Sort alphabetically by name
    allVenues.sort((a, b) => a.name.localeCompare(b.name))

    console.log(`Venues API: Returning ${allVenues.length} venues`)

    return NextResponse.json({
      success: true,
      venues: allVenues,
    })

  } catch (error) {
    console.error('Venues API GET error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch venues' },
      { status: 500 }
    )
  }
}

// =============================================================================
// POST - Create new venue
// =============================================================================

export async function POST(request: NextRequest) {
  try {
    // Verify staff PIN (also accept hub auth marker for Staff Hub sessions)
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    const HUB_AUTH_MARKER = '__HUB_AUTH__'
    
    if (!staffPin || (pin !== staffPin && pin !== HUB_AUTH_MARKER)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { 
      name, 
      distance, 
      driveTime,
      publicTransportTime,
      publicTransportCost,
      tollsParking,
    } = await request.json()

    if (!name) {
      return NextResponse.json(
        { success: false, error: 'Venue name is required' },
        { status: 400 }
      )
    }

    console.log('Venues API: Creating new venue:', name)

    // Build column values
    const columnValues: Record<string, unknown> = {}
    
    // Set the text43 column (venue name) to match item name
    columnValues[VENUE_COLUMNS.name] = name
    
    if (distance && distance > 0) {
      columnValues[VENUE_COLUMNS.distance] = distance
    }
    if (driveTime && driveTime > 0) {
      columnValues[VENUE_COLUMNS.driveTime] = driveTime
    }
    if (publicTransportTime && publicTransportTime > 0) {
      columnValues[VENUE_COLUMNS.publicTransportTime] = publicTransportTime
    }
    if (publicTransportCost && publicTransportCost > 0) {
      columnValues[VENUE_COLUMNS.publicTransportCost] = publicTransportCost
    }
    if (tollsParking && tollsParking > 0) {
      columnValues[VENUE_COLUMNS.tollsParking] = tollsParking
    }

    const mutation = `
      mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
        create_item(
          board_id: $boardId
          item_name: $itemName
          column_values: $columnValues
        ) {
          id
          name
        }
      }
    `

    const result = await mondayQuery<{
      create_item: { id: string; name: string }
    }>(mutation, {
      boardId: VENUES_BOARD_ID,
      itemName: name,
      columnValues: JSON.stringify(columnValues),
    })

    console.log('Venues API: Created venue', result.create_item.id, '-', result.create_item.name)

    return NextResponse.json({
      success: true,
      venue: {
        id: result.create_item.id,
        name: result.create_item.name,
        distance,
        driveTime,
        publicTransportTime,
        publicTransportCost,
        tollsParking,
      },
    })

  } catch (error) {
    console.error('Venues API POST error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to create venue' },
      { status: 500 }
    )
  }
}

// =============================================================================
// PATCH - Update venue fields
// =============================================================================

export async function PATCH(request: NextRequest) {
  try {
    // Verify staff PIN (also accept hub auth marker for Staff Hub sessions)
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    const HUB_AUTH_MARKER = '__HUB_AUTH__'
    
    if (!staffPin || (pin !== staffPin && pin !== HUB_AUTH_MARKER)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { 
      venueId, 
      distance, 
      driveTime,
      publicTransportTime,
      publicTransportCost,
      tollsParking,
    } = await request.json()

    if (!venueId) {
      return NextResponse.json(
        { success: false, error: 'Venue ID is required' },
        { status: 400 }
      )
    }

    console.log('Venues API: Updating venue', venueId)

    // Build column values - only update fields that are provided
    const columnValues: Record<string, unknown> = {}
    
    if (distance !== undefined && distance !== null) {
      columnValues[VENUE_COLUMNS.distance] = distance
    }
    if (driveTime !== undefined && driveTime !== null) {
      columnValues[VENUE_COLUMNS.driveTime] = driveTime
    }
    if (publicTransportTime !== undefined && publicTransportTime !== null) {
      columnValues[VENUE_COLUMNS.publicTransportTime] = publicTransportTime
    }
    if (publicTransportCost !== undefined && publicTransportCost !== null) {
      columnValues[VENUE_COLUMNS.publicTransportCost] = publicTransportCost
    }
    if (tollsParking !== undefined && tollsParking !== null) {
      columnValues[VENUE_COLUMNS.tollsParking] = tollsParking
    }

    if (Object.keys(columnValues).length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No changes to update',
      })
    }

    console.log('Venues API: Updating columns:', Object.keys(columnValues))

    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
        change_multiple_column_values(
          board_id: $boardId
          item_id: $itemId
          column_values: $columnValues
        ) {
          id
          name
        }
      }
    `

    const result = await mondayQuery<{
      change_multiple_column_values: { id: string; name: string }
    }>(mutation, {
      boardId: VENUES_BOARD_ID,
      itemId: venueId,
      columnValues: JSON.stringify(columnValues),
    })

    console.log('Venues API: Updated venue', result.change_multiple_column_values.id)

    return NextResponse.json({
      success: true,
      venue: {
        id: result.change_multiple_column_values.id,
        name: result.change_multiple_column_values.name,
      },
    })

  } catch (error) {
    console.error('Venues API PATCH error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update venue' },
      { status: 500 }
    )
  }
}