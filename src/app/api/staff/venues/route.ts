/**
 * Venues API
 * 
 * GET /api/staff/venues - Fetch all venues for dropdown
 * POST /api/staff/venues - Create new venue
 * PATCH /api/staff/venues - Update venue distance/time
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const VENUES_BOARD_ID = process.env.MONDAY_BOARD_ID_VENUES || '2406443142'

// Column IDs for Venues board
const VENUE_COLUMNS = {
  name: 'text43',                    // Venue name (also item name)
  distance: 'numeric_mm07y9eq',      // Distance (miles, one-way)
  driveTime: 'numeric_mm074a1k',     // Drive Time (minutes, one-way)
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
// GET - Fetch all venues
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

    console.log('Venues API: Fetching all venues from board', VENUES_BOARD_ID)

    // Fetch all venues with pagination support
    // We'll fetch up to 500 at a time and combine if needed
    const allVenues: Array<{
      id: string
      name: string
      distance: number | null
      driveTime: number | null
    }> = []

    let cursor: string | null = null
    let pageCount = 0
    const maxPages = 5 // Safety limit: 5 pages × 500 = 2500 venues max

    do {
      const query = cursor
        ? `
          query ($cursor: String!) {
            next_items_page(cursor: $cursor, limit: 500) {
              cursor
              items {
                id
                name
                column_values(ids: ["${VENUE_COLUMNS.distance}", "${VENUE_COLUMNS.driveTime}"]) {
                  id
                  text
                  value
                }
              }
            }
          }
        `
        : `
          query ($boardId: ID!) {
            boards(ids: [$boardId]) {
              items_page(limit: 500) {
                cursor
                items {
                  id
                  name
                  column_values(ids: ["${VENUE_COLUMNS.distance}", "${VENUE_COLUMNS.driveTime}"]) {
                    id
                    text
                    value
                  }
                }
              }
            }
          }
        `

      const variables = cursor 
        ? { cursor }
        : { boardId: VENUES_BOARD_ID }

      const result = await mondayQuery<{
        boards?: Array<{
          items_page: {
            cursor: string | null
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
        next_items_page?: {
          cursor: string | null
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
      }>(query, variables)

      // Explicitly type to avoid TypeScript inference issue
      type ItemsPageType = {
        cursor: string | null
        items: Array<{
          id: string
          name: string
          column_values: Array<{
            id: string
            text: string
            value: string
          }>
        }>
      } | undefined

      const itemsPage: ItemsPageType = cursor 
        ? result.next_items_page 
        : result.boards?.[0]?.items_page

      if (!itemsPage) {
        console.error('Venues API: No items_page in response')
        break
      }

      // Process items
      for (const item of itemsPage.items) {
        const columns = item.column_values.reduce((acc, col) => {
          acc[col.id] = col.text
          return acc
        }, {} as Record<string, string>)

        allVenues.push({
          id: item.id,
          name: item.name,
          distance: columns[VENUE_COLUMNS.distance] ? parseFloat(columns[VENUE_COLUMNS.distance]) : null,
          driveTime: columns[VENUE_COLUMNS.driveTime] ? parseFloat(columns[VENUE_COLUMNS.driveTime]) : null,
        })
      }

      cursor = itemsPage.cursor
      pageCount++

      console.log(`Venues API: Fetched page ${pageCount}, got ${itemsPage.items.length} items, total: ${allVenues.length}`)

    } while (cursor && pageCount < maxPages)

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
    // Verify staff PIN
    const pin = request.headers.get('x-staff-pin')
    const staffPin = process.env.STAFF_PIN
    
    if (!staffPin || pin !== staffPin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const { name, distance, driveTime } = await request.json()

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
// PATCH - Update venue distance/time
// =============================================================================

export async function PATCH(request: NextRequest) {
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

    const { venueId, distance, driveTime } = await request.json()

    if (!venueId) {
      return NextResponse.json(
        { success: false, error: 'Venue ID is required' },
        { status: 400 }
      )
    }

    console.log('Venues API: Updating venue', venueId, '- Distance:', distance, 'Drive Time:', driveTime)

    // Build column values - only update fields that are provided
    const columnValues: Record<string, unknown> = {}
    
    if (distance !== undefined && distance !== null) {
      columnValues[VENUE_COLUMNS.distance] = distance
    }
    if (driveTime !== undefined && driveTime !== null) {
      columnValues[VENUE_COLUMNS.driveTime] = driveTime
    }

    if (Object.keys(columnValues).length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No changes to update',
      })
    }

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