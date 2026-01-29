/** 
 * Warehouse Collections List API
 * 
 * Fetches jobs from the Q&H board that are ready for in-person collection:
 * - Hire start date is within ±1 day of today
 * - Quote status (status6) = "Confirmed quote"
 * - On hire status (status51) is NOT "On hire!"
 * 
 * Returns job details including client name, email, and HireHop reference.
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const QH_BOARD_ID = '2431480012'

// Column IDs on Q&H board
const COLUMNS = {
  HIRE_START_DATE: 'date',
  QUOTE_STATUS: 'status6',
  ON_HIRE_STATUS: 'status51',
  CLIENT_EMAIL: 'text1',
  CLIENT_NAME: 'text6',
  HIREHOP_REF: 'text7',
}

interface CollectionJob {
  id: string
  name: string
  hireStartDate: string
  clientName: string
  clientEmail: string
  hhRef: string
  quoteStatus: string
  onHireStatus: string
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

/**
 * Get date range for filtering (yesterday, today, tomorrow)
 */
function getDateRange(): { start: string; end: string } {
  const today = new Date()
  
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  
  const tomorrow = new Date(today)
  tomorrow.setDate(tomorrow.getDate() + 1)
  
  // Format as YYYY-MM-DD
  const formatDate = (d: Date) => d.toISOString().split('T')[0]
  
  return {
    start: formatDate(yesterday),
    end: formatDate(tomorrow),
  }
}

export async function GET(request: NextRequest) {
  try {
    // Verify PIN from header (simple auth check)
    const pin = request.headers.get('x-warehouse-pin')
    const expectedPin = process.env.WAREHOUSE_PIN
    
    if (!expectedPin || pin !== expectedPin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const dateRange = getDateRange()
    console.log(`Warehouse: Fetching collections for date range ${dateRange.start} to ${dateRange.end}`)

    // Fetch items from Q&H board
    // We'll fetch all items and filter client-side for flexibility
    const query = `
      query ($boardId: [ID!]!) {
        boards(ids: $boardId) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ["${COLUMNS.HIRE_START_DATE}", "${COLUMNS.QUOTE_STATUS}", "${COLUMNS.ON_HIRE_STATUS}", "${COLUMNS.CLIENT_EMAIL}", "${COLUMNS.CLIENT_NAME}", "${COLUMNS.HIREHOP_REF}"]) {
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
            column_values: Array<{ id: string; text: string; value: string }>
          }>
        }
      }>
    }>(query, { boardId: [QH_BOARD_ID] })

    const items = result.boards[0]?.items_page?.items || []
    console.log(`Warehouse: Retrieved ${items.length} total items from Q&H board`)

    // Filter for ready-to-collect jobs
    const readyJobs: CollectionJob[] = []
    
    for (const item of items) {
      // Extract column values into a map
      const cols: Record<string, string> = {}
      for (const col of item.column_values) {
        cols[col.id] = col.text || ''
      }

      const hireStartDate = cols[COLUMNS.HIRE_START_DATE]
      const quoteStatus = cols[COLUMNS.QUOTE_STATUS]
      const onHireStatus = cols[COLUMNS.ON_HIRE_STATUS]

      // Apply filters:
      // 1. Must have a hire start date within range
      if (!hireStartDate || hireStartDate < dateRange.start || hireStartDate > dateRange.end) {
        continue
      }

      // 2. Quote status must be "Confirmed quote"
      if (!quoteStatus || !quoteStatus.toLowerCase().includes('confirmed')) {
        continue
      }

      // 3. On hire status must NOT be "On hire!"
      if (onHireStatus && onHireStatus.toLowerCase().includes('on hire')) {
        continue
      }

      // This job is ready for collection
      readyJobs.push({
        id: item.id,
        name: item.name,
        hireStartDate,
        clientName: cols[COLUMNS.CLIENT_NAME] || '',
        clientEmail: cols[COLUMNS.CLIENT_EMAIL] || '',
        hhRef: cols[COLUMNS.HIREHOP_REF] || '',
        quoteStatus,
        onHireStatus: onHireStatus || 'Not on hire',
      })
    }

    // Sort by name (which typically includes job number)
    readyJobs.sort((a, b) => a.name.localeCompare(b.name))

    console.log(`Warehouse: Found ${readyJobs.length} jobs ready for collection`)

    return NextResponse.json({
      success: true,
      jobs: readyJobs,
      dateRange,
      fetchedAt: new Date().toISOString(),
    })

  } catch (error) {
    console.error('Warehouse collections API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch collections' },
      { status: 500 }
    )
  }
}