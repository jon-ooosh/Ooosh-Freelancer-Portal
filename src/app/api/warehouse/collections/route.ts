/**
 * Warehouse Collections API
 * 
 * GET /api/warehouse/collections
 * 
 * Returns jobs ready for in-person collection at the warehouse.
 * 
 * Filters applied:
 * - Monday.com: Confirmed quotes with hire date ±1 day, not yet "On hire!"
 * - HireHop: COLLECT=0 (customer collects) - excludes deliveries
 * 
 * Sorted by hire date ascending (yesterday → today → tomorrow)
 * 
 * OPTIMIZED: Only fetches specific columns to reduce API response time
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const QH_BOARD_ID = '2431480012' // Quotes & Hires board

// HireHop config (matches existing src/lib/hirehop.ts)
const HIREHOP_DOMAIN = process.env.HIREHOP_DOMAIN || 'hirehop.net'
const HIREHOP_API_TOKEN = process.env.HIREHOP_API_TOKEN || ''

// Column IDs we need from Q&H board
const COLUMNS = {
  hireStartDate: 'date',      // Hire start date
  quoteStatus: 'status6',     // Quote status (e.g., "Confirmed quote")
  onHireStatus: 'status51',   // On hire status (e.g., "On hire!")
  clientName: 'text6',        // Client name
  clientEmail: 'text1',       // Client email
  hhRef: 'text7',             // HireHop job reference
}

interface MondayItem {
  id: string
  name: string
  column_values: Array<{
    id: string
    text: string | null
  }>
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

/**
 * Query Monday.com GraphQL API
 */
async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) {
    throw new Error('MONDAY_API_TOKEN not configured')
  }

  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  })

  const result = await response.json()
  
  if (result.errors) {
    console.error('Monday API errors:', result.errors)
    throw new Error(result.errors[0]?.message || 'Monday API error')
  }

  return result.data as T
}

/**
 * Check HireHop job to see if it's a customer collection (COLLECT=0)
 */
async function isCustomerCollection(hhRef: string): Promise<boolean> {
  if (!hhRef || !HIREHOP_API_TOKEN) {
    // If no HireHop ref or token, include by default (fail open)
    console.log(`Warehouse: No HH ref or token for job, including by default`)
    return true
  }

  try {
    const url = `https://${HIREHOP_DOMAIN}/api/job_data.php?job=${encodeURIComponent(hhRef)}&token=${encodeURIComponent(HIREHOP_API_TOKEN)}`
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
      },
    })

    const text = await response.text()
    
    // Check for HTML error response
    if (text.trim().startsWith('<')) {
      console.warn(`Warehouse: HireHop returned HTML for job ${hhRef}, including by default`)
      return true
    }

    const data = JSON.parse(text)
    
    if (data.error) {
      console.warn(`Warehouse: HireHop error for job ${hhRef}: ${data.error}, including by default`)
      return true
    }

    // COLLECT field: 0 = customer collect, 1 = we deliver, 2 = courier, 3 = other
    const collectStatus = parseInt(data.COLLECT, 10)
    const isCollection = collectStatus === 0
    
    console.log(`Warehouse: HH job ${hhRef} COLLECT=${collectStatus}, isCustomerCollection=${isCollection}`)
    
    return isCollection
  } catch (err) {
    console.error(`Warehouse: Failed to check HireHop for job ${hhRef}:`, err)
    // Fail open - include the job if we can't check
    return true
  }
}

/**
 * Get column value by ID from Monday item
 */
function getColumnValue(item: MondayItem, columnId: string): string {
  const col = item.column_values.find(c => c.id === columnId)
  return col?.text || ''
}

/**
 * Check if a date is within range of today (±1 day)
 */
function isWithinDateRange(dateStr: string): boolean {
  if (!dateStr) return false
  
  try {
    const jobDate = new Date(dateStr)
    jobDate.setHours(0, 0, 0, 0)
    
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)
    
    return jobDate >= yesterday && jobDate <= tomorrow
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  
  try {
    // Verify PIN authentication
    const pin = request.headers.get('x-warehouse-pin')
    const expectedPin = process.env.WAREHOUSE_PIN
    
    if (!pin || pin !== expectedPin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }

    console.log('Warehouse: Fetching collections from Monday.com')

    // OPTIMIZED: Only fetch the specific columns we need
    // This dramatically reduces response size and parsing time
    const columnIds = Object.values(COLUMNS)
    
    const query = `
      query {
        boards(ids: [${QH_BOARD_ID}]) {
          items_page(limit: 500) {
            items {
              id
              name
              column_values(ids: ${JSON.stringify(columnIds)}) {
                id
                text
              }
            }
          }
        }
      }
    `

    const mondayStartTime = Date.now()
    const data = await mondayQuery<{
      boards: Array<{
        items_page: {
          items: MondayItem[]
        }
      }>
    }>(query)
    const mondayElapsed = Date.now() - mondayStartTime

    const items = data.boards?.[0]?.items_page?.items || []
    console.log(`Warehouse: Fetched ${items.length} items from Monday in ${mondayElapsed}ms`)

    // First pass: Filter by Monday criteria
    const mondayFiltered: CollectionJob[] = []
    
    for (const item of items) {
      const hireStartDate = getColumnValue(item, COLUMNS.hireStartDate)
      const quoteStatus = getColumnValue(item, COLUMNS.quoteStatus)
      const onHireStatus = getColumnValue(item, COLUMNS.onHireStatus)
      const clientName = getColumnValue(item, COLUMNS.clientName)
      const clientEmail = getColumnValue(item, COLUMNS.clientEmail)
      const hhRef = getColumnValue(item, COLUMNS.hhRef)

      // Filter 1: Date must be within ±1 day
      if (!isWithinDateRange(hireStartDate)) {
        continue
      }

      // Filter 2: Must be confirmed quote
      if (quoteStatus !== 'Confirmed quote') {
        continue
      }

      // Filter 3: Must NOT already be on hire
      if (onHireStatus === 'On hire!') {
        continue
      }

      mondayFiltered.push({
        id: item.id,
        name: item.name,
        hireStartDate,
        clientName,
        clientEmail,
        hhRef,
        quoteStatus,
        onHireStatus,
      })
    }

    console.log(`Warehouse: ${mondayFiltered.length} jobs passed Monday filters`)

    // Second pass: Filter by HireHop COLLECT status (in parallel for speed)
    const hirehopStartTime = Date.now()
    const hirehopChecks = await Promise.all(
      mondayFiltered.map(async (job) => {
        const isCollection = await isCustomerCollection(job.hhRef)
        return { job, isCollection }
      })
    )
    const hirehopElapsed = Date.now() - hirehopStartTime

    const jobs = hirehopChecks
      .filter(({ isCollection }) => isCollection)
      .map(({ job }) => job)

    console.log(`Warehouse: ${jobs.length} jobs passed HireHop COLLECT filter in ${hirehopElapsed}ms`)

    // Sort by hire date ascending (yesterday → today → tomorrow)
    jobs.sort((a, b) => {
      const dateA = new Date(a.hireStartDate).getTime()
      const dateB = new Date(b.hireStartDate).getTime()
      return dateA - dateB
    })

    const elapsed = Date.now() - startTime
    console.log(`Warehouse: Collections API completed in ${elapsed}ms (Monday: ${mondayElapsed}ms, HireHop: ${hirehopElapsed}ms)`)

    return NextResponse.json({
      success: true,
      jobs,
      fetchedAt: new Date().toISOString(),
      timing: {
        totalMs: elapsed,
        mondayMs: mondayElapsed,
        hirehopMs: hirehopElapsed,
        jobCount: jobs.length,
      },
    })

  } catch (error) {
    console.error('Warehouse collections API error:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Failed to fetch collections' 
      },
      { status: 500 }
    )
  }
}