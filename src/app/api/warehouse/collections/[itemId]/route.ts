/** 
 * Warehouse Single Job Details API
 * 
 * Fetches full details for a specific job including:
 * - Job info from Monday Q&H board
 * - Equipment list from HireHop (filtered for equipment only)
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
 * Fetch equipment from HireHop (using our existing internal API)
 */
async function fetchHireHopItems(hhRef: string): Promise<Array<{ id: string; name: string; quantity: number }>> {
  try {
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
    const secret = process.env.BACKGROUND_FUNCTION_SECRET || process.env.MONDAY_WEBHOOK_SECRET

    console.log(`Warehouse: Fetching HireHop items for job ${hhRef}`)

    const response = await fetch(`${appUrl}/api/hirehop/items/${hhRef}?filter=equipment`, {
      headers: secret ? { 'x-background-secret': secret } : {},
    })

    if (!response.ok) {
      console.error(`Warehouse: HireHop fetch failed with status ${response.status}`)
      return []
    }

    const data = await response.json()
    console.log(`Warehouse: HireHop returned ${data.items?.length || 0} items`)
    return data.items || []
  } catch (err) {
    console.error('Warehouse: HireHop fetch error:', err)
    return []
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
) {
  try {
    const { itemId } = await params

    // Verify PIN from header
    const pin = request.headers.get('x-warehouse-pin')
    const expectedPin = process.env.WAREHOUSE_PIN

    if (!expectedPin || pin !== expectedPin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    console.log(`Warehouse: Fetching job details for item ${itemId}`)

    // Fetch job from Monday
    const query = `
      query ($itemId: [ID!]!) {
        items(ids: $itemId) {
          id
          name
          column_values(ids: ["${COLUMNS.HIRE_START_DATE}", "${COLUMNS.QUOTE_STATUS}", "${COLUMNS.ON_HIRE_STATUS}", "${COLUMNS.CLIENT_EMAIL}", "${COLUMNS.CLIENT_NAME}", "${COLUMNS.HIREHOP_REF}"]) {
            id
            text
            value
          }
        }
      }
    `

    const result = await mondayQuery<{
      items: Array<{
        id: string
        name: string
        column_values: Array<{ id: string; text: string; value: string }>
      }>
    }>(query, { itemId: [itemId] })

    const item = result.items?.[0]
    if (!item) {
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      )
    }

    // Extract column values
    const cols: Record<string, string> = {}
    for (const col of item.column_values) {
      cols[col.id] = col.text || ''
    }

    const hhRef = cols[COLUMNS.HIREHOP_REF]

    // Fetch equipment from HireHop if we have a reference
    let items: Array<{ id: string; name: string; quantity: number }> = []
    if (hhRef) {
      items = await fetchHireHopItems(hhRef)
    } else {
      console.log('Warehouse: No HireHop reference, skipping equipment fetch')
    }

    const jobData = {
      id: item.id,
      name: item.name,
      hireStartDate: cols[COLUMNS.HIRE_START_DATE] || '',
      clientName: cols[COLUMNS.CLIENT_NAME] || '',
      clientEmail: cols[COLUMNS.CLIENT_EMAIL] || '',
      hhRef: hhRef || '',
      quoteStatus: cols[COLUMNS.QUOTE_STATUS] || '',
      onHireStatus: cols[COLUMNS.ON_HIRE_STATUS] || '',
      items,
    }

    console.log(`Warehouse: Returning job ${item.name} with ${items.length} equipment items`)

    return NextResponse.json({
      success: true,
      job: jobData,
    })

  } catch (error) {
    console.error('Warehouse job details API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to fetch job details' },
      { status: 500 }
    )
  }
}