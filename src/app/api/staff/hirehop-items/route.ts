/**
 * HireHop Items API - Add Labour Items to Jobs
 * 
 * POST /api/staff/hirehop-items
 * 
 * Adds Delivery, Collection, or Crew labour items to a HireHop job.
 * Automatically finds or creates a "Crew & transport" header section.
 * 
 * Request body:
 * {
 *   jobId: string,           // HireHop job number
 *   items: [{
 *     type: 'delivery' | 'collection' | 'crew',
 *     price: number,         // Total price for this item
 *     date: string,          // ISO date string
 *     time: string,          // Time in HH:MM format  
 *     venue: string,         // Venue name
 *   }]
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   results: [{ type, itemId, note }],
 *   headerId: string,
 *   error?: string
 * }
 */

import { NextRequest, NextResponse } from 'next/server'

// =============================================================================
// CONFIGURATION
// =============================================================================

// Labour item IDs in HireHop (from your stock list)
const LABOUR_ITEM_IDS = {
  delivery: 5,
  collection: 6,
  crew: 86,
}

// Keywords to search for when finding an existing header
const HEADER_KEYWORDS = ['crew', 'transport', 'delivery', 'collection', 'deliveries', 'collections']

// Default header name if we need to create one
const DEFAULT_HEADER_NAME = 'Crew & transport'

// Get HireHop credentials from environment
function getHireHopConfig() {
  const token = process.env.HIREHOP_API_TOKEN
  const domain = process.env.HIREHOP_DOMAIN || 'hirehop.net'
  
  if (!token) {
    throw new Error('HIREHOP_API_TOKEN not configured')
  }
  
  return { token, domain }
}

// =============================================================================
// TYPES
// =============================================================================

interface HireHopRawItem {
  ID: string
  kind: string  // "0" = header, "4" = labour item
  title: string
  parent: string
  LFT: string
  RGT: string
  [key: string]: unknown
}

interface AddItemRequest {
  type: 'delivery' | 'collection' | 'crew'
  price: number
  date: string      // ISO date string e.g. "2026-02-06"
  time: string      // HH:MM format e.g. "09:30"
  venue: string     // Venue name
}

interface RequestBody {
  jobId: string
  items: AddItemRequest[]
}

interface ItemResult {
  type: string
  itemId: string
  note: string
  success: boolean
  error?: string
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Format a date for the item note (e.g., "6 Feb")
 */
function formatDateForNote(isoDate: string): string {
  try {
    const date = new Date(isoDate)
    const day = date.getDate()
    const month = date.toLocaleString('en-GB', { month: 'short' })
    return `${day} ${month}`
  } catch {
    return isoDate
  }
}

/**
 * Build the item note in the format: "6 Feb - 09:30 - Royal Albert Hall"
 */
function buildItemNote(date: string, time: string, venue: string): string {
  const formattedDate = formatDateForNote(date)
  const parts = [formattedDate]
  
  if (time) {
    parts.push(time)
  }
  
  if (venue) {
    parts.push(venue)
  }
  
  return parts.join(' - ')
}

/**
 * Fetch all items from a HireHop job
 */
async function fetchJobItems(jobId: string): Promise<HireHopRawItem[]> {
  const { token, domain } = getHireHopConfig()
  const encodedToken = encodeURIComponent(token)
  
  const url = `https://${domain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`
  
  console.log(`HireHop Items: Fetching items for job ${jobId}`)
  
  const response = await fetch(url)
  
  if (!response.ok) {
    throw new Error(`Failed to fetch items: HTTP ${response.status}`)
  }
  
  const text = await response.text()
  
  // Check for HTML error (auth failure)
  if (text.trim().startsWith('<')) {
    throw new Error('HireHop authentication failed - received HTML instead of JSON')
  }
  
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : (parsed.items || [])
}

/**
 * Find an existing header that matches our keywords
 * Returns the header ID if found, null otherwise
 */
function findExistingHeader(items: HireHopRawItem[]): string | null {
  // Headers have kind="0" and parent="0" (top-level)
  const headers = items.filter(item => 
    item.kind === '0' && item.parent === '0'
  )
  
  console.log(`HireHop Items: Found ${headers.length} top-level headers`)
  
  for (const header of headers) {
    const title = (header.title || '').toLowerCase()
    
    for (const keyword of HEADER_KEYWORDS) {
      if (title.includes(keyword)) {
        console.log(`HireHop Items: Found matching header "${header.title}" (ID: ${header.ID})`)
        return header.ID
      }
    }
  }
  
  console.log('HireHop Items: No matching header found')
  return null
}

/**
 * Create a new header section in the job
 */
async function createHeader(jobId: string, headerName: string): Promise<string> {
  const { token, domain } = getHireHopConfig()
  
  console.log(`HireHop Items: Creating header "${headerName}" in job ${jobId}`)
  
  // To create a header, we use items_save.php with kind=0
  const params = new URLSearchParams({
    job: jobId,
    kind: '0',           // 0 = header
    id: '0',             // 0 = new item
    name: headerName,
    qty: '0',
    parent: '0',         // Top-level (no parent)
    token: token,
  })
  
  const response = await fetch(`https://${domain}/php_functions/items_save.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })
  
  if (!response.ok) {
    throw new Error(`Failed to create header: HTTP ${response.status}`)
  }
  
  const text = await response.text()
  
  if (text.trim().startsWith('<')) {
    throw new Error('HireHop authentication failed when creating header')
  }
  
  const result = JSON.parse(text)
  
  // The response contains the created items
  if (result.items && result.items.length > 0) {
    const createdHeader = result.items[0]
    console.log(`HireHop Items: Created header with ID ${createdHeader.ID}`)
    return createdHeader.ID
  }
  
  throw new Error('Header created but no ID returned')
}

/**
 * Add a labour item to a job under a specific header
 */
async function addLabourItem(
  jobId: string,
  headerId: string,
  itemType: 'delivery' | 'collection' | 'crew',
  price: number,
  note: string
): Promise<{ itemId: string; success: boolean; error?: string }> {
  const { token, domain } = getHireHopConfig()
  
  const listId = LABOUR_ITEM_IDS[itemType]
  
  console.log(`HireHop Items: Adding ${itemType} (list_id=${listId}) to job ${jobId} under header ${headerId}`)
  console.log(`HireHop Items: Price=${price}, Note="${note}"`)
  
  // Build the request parameters (matching the format from the network sniff)
  // Get current local datetime in required format
  const now = new Date()
  const localDateTime = now.toISOString().slice(0, 19).replace('T', ' ')
  
  const params = new URLSearchParams({
    job: jobId,
    kind: '4',                    // 4 = labour item
    id: '0',                      // 0 = new item
    list_id: String(listId),      // The labour item template ID
    qty: '1',
    unit_price: String(price),
    price: String(price),
    add: note,                    // This becomes the ADDITIONAL field (item note)
    parent: headerId,             // Put under this header
    flag: '0',
    priority_confirm: '0',
    name: '',                     // Leave empty - uses default from list_id
    price_type: '0',              // One-off price
    vat_rate: '0',
    value: '0',
    weight: '0',
    cost_price: '0',
    no_shortfall: '1',
    no_availability: '0',
    ignore: '0',
    local: localDateTime,         // Current datetime - may be required
    token: token,
  })
  
  try {
    const response = await fetch(`https://${domain}/php_functions/items_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
    
    if (!response.ok) {
      return { 
        itemId: '', 
        success: false, 
        error: `HTTP ${response.status}` 
      }
    }
    
    const text = await response.text()
    
    // Log the raw response for debugging
    console.log(`HireHop Items: Raw response for ${itemType}:`, text.substring(0, 500))
    
    if (text.trim().startsWith('<')) {
      return { 
        itemId: '', 
        success: false, 
        error: 'Authentication failed - received HTML' 
      }
    }
    
    const result = JSON.parse(text)
    
    // Log the parsed structure
    console.log(`HireHop Items: Parsed response keys:`, Object.keys(result))
    
    // Check for error in response
    if (result.error) {
      console.log(`HireHop Items: Error in response:`, result.error)
      return {
        itemId: '',
        success: false,
        error: `HireHop error: ${result.error}`
      }
    }
    
    if (result.items && result.items.length > 0) {
      const createdItem = result.items[0]
      console.log(`HireHop Items: Created ${itemType} with ID ${createdItem.ID}`)
      return { 
        itemId: createdItem.ID, 
        success: true 
      }
    }
    
    // Return the raw response structure in the error for debugging
    return { 
      itemId: '', 
      success: false, 
      error: `No items in response. Keys: ${Object.keys(result).join(', ')}. Full: ${JSON.stringify(result).substring(0, 200)}` 
    }
    
  } catch (error) {
    console.error(`HireHop Items: Error adding ${itemType}:`, error)
    return { 
      itemId: '', 
      success: false, 
      error: error instanceof Error ? error.message : 'Unknown error' 
    }
  }
}

// =============================================================================
// API HANDLER
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
    
    // Parse request body
    const body: RequestBody = await request.json()
    
    if (!body.jobId) {
      return NextResponse.json(
        { success: false, error: 'jobId is required' },
        { status: 400 }
      )
    }
    
    if (!body.items || body.items.length === 0) {
      return NextResponse.json(
        { success: false, error: 'At least one item is required' },
        { status: 400 }
      )
    }
    
    console.log('='.repeat(60))
    console.log(`HireHop Items: Adding ${body.items.length} item(s) to job ${body.jobId}`)
    console.log('='.repeat(60))
    
    // Step 1: Fetch existing items to find a suitable header
    const existingItems = await fetchJobItems(body.jobId)
    
    // Step 2: Find or create a header
    let headerId = findExistingHeader(existingItems)
    
    if (!headerId) {
      headerId = await createHeader(body.jobId, DEFAULT_HEADER_NAME)
    }
    
    // Step 3: Add each item
    const results: ItemResult[] = []
    
    for (const item of body.items) {
      // Validate item type
      if (!['delivery', 'collection', 'crew'].includes(item.type)) {
        results.push({
          type: item.type,
          itemId: '',
          note: '',
          success: false,
          error: `Invalid item type: ${item.type}`,
        })
        continue
      }
      
      // Build the note
      const note = buildItemNote(item.date, item.time, item.venue)
      
      // Add the item
      const result = await addLabourItem(
        body.jobId,
        headerId,
        item.type as 'delivery' | 'collection' | 'crew',
        item.price,
        note
      )
      
      results.push({
        type: item.type,
        itemId: result.itemId,
        note: note,
        success: result.success,
        error: result.error,
      })
    }
    
    // Check if all items succeeded
    const allSucceeded = results.every(r => r.success)
    const anySucceeded = results.some(r => r.success)
    
    console.log(`HireHop Items: Completed - ${results.filter(r => r.success).length}/${results.length} items added`)
    
    return NextResponse.json({
      success: allSucceeded,
      partial: !allSucceeded && anySucceeded,
      headerId,
      results,
    })
    
  } catch (error) {
    console.error('HireHop Items API error:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    )
  }
}