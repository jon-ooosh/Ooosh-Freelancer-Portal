/**
 * HireHop Labour Items API
 * 
 * POST /api/staff/hirehop-items - Add labour items (Delivery/Collection/Crew) to a HireHop job
 * 
 * This uses a TWO-STEP APPROACH (same pattern as deposits/payments):
 * 1. Add item via save_job.php with items parameter (creates with defaults)
 * 2. Edit the item via items_save.php to set price and note
 * 
 * Items are placed under a "Crew & transport" header (created if needed).
 */

import { NextRequest, NextResponse } from 'next/server'

// =============================================================================
// TYPES
// =============================================================================

interface HireHopRawItem {
  ID: string
  NAME?: string
  title?: string
  kind: string
  LFT?: string
  RGT?: string
  parent?: string
  LIST_ID?: string
  UNIT_PRICE?: string
  ADDITIONAL?: string
}

interface AddItemRequest {
  jobId: string
  items: Array<{
    type: 'delivery' | 'collection' | 'crew'
    price: number
    date?: string      // Job date for the note (YYYY-MM-DD)
    time?: string      // Arrival time for the note (HH:MM)
    venue?: string     // Venue name for the note
  }>
}

interface ItemResult {
  type: 'delivery' | 'collection' | 'crew'
  itemId: string
  note: string
  success: boolean
  error?: string
}

// Labour item list IDs (from HireHop depot)
const LABOUR_ITEM_IDS: Record<string, number> = {
  delivery: 5,
  collection: 6,
  crew: 86,
}

// Keywords to find existing "Crew & transport" type headers
const HEADER_KEYWORDS = ['crew', 'transport', 'delivery', 'collection']

// =============================================================================
// CONFIG HELPERS
// =============================================================================

function getHireHopConfig() {
  const token = process.env.HIREHOP_API_TOKEN
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com'
  
  if (!token) {
    throw new Error('HIREHOP_API_TOKEN not configured')
  }
  
  return { token, domain }
}

// =============================================================================
// HIREHOP API FUNCTIONS
// =============================================================================

/**
 * Fetch all items for a job to find headers and existing items
 */
async function fetchJobItems(jobId: string): Promise<HireHopRawItem[]> {
  const { token, domain } = getHireHopConfig()
  
  const url = `https://${domain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodeURIComponent(token)}`
  
  const response = await fetch(url)
  
  if (!response.ok) {
    throw new Error(`Failed to fetch job items: HTTP ${response.status}`)
  }
  
  const text = await response.text()
  
  if (text.trim().startsWith('<')) {
    throw new Error('HireHop authentication failed - received HTML')
  }
  
  return JSON.parse(text) as HireHopRawItem[]
}

/**
 * Find an existing header that matches our keywords
 */
function findExistingHeader(items: HireHopRawItem[]): { id: string; name: string } | null {
  // Headers have kind: "0" and no parent (or parent: "0")
  const headers = items.filter(item => 
    item.kind === '0' && 
    (!item.parent || item.parent === '0')
  )
  
  console.log(`HireHop Items: Found ${headers.length} top-level headers`)
  
  for (const header of headers) {
    const headerName = (header.NAME || header.title || '').toLowerCase()
    
    for (const keyword of HEADER_KEYWORDS) {
      if (headerName.includes(keyword)) {
        console.log(`HireHop Items: Found matching header "${header.NAME || header.title}" (ID: ${header.ID})`)
        return { 
          id: header.ID, 
          name: header.NAME || header.title || '' 
        }
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
  
  if (result.items && result.items.length > 0) {
    const createdHeader = result.items[0]
    console.log(`HireHop Items: Created header with ID ${createdHeader.ID}`)
    return createdHeader.ID
  }
  
  throw new Error('Header created but no ID returned')
}

/**
 * Build the item note in format: "6 Feb - 09:30 - Venue Name"
 */
function buildItemNote(date?: string, time?: string, venue?: string): string {
  const parts: string[] = []
  
  if (date) {
    // Convert YYYY-MM-DD to "6 Feb" format
    const d = new Date(date + 'T12:00:00')
    const day = d.getDate()
    const month = d.toLocaleDateString('en-GB', { month: 'short' })
    parts.push(`${day} ${month}`)
  }
  
  if (time) {
    parts.push(time)
  }
  
  if (venue) {
    parts.push(venue)
  }
  
  return parts.join(' - ')
}

/**
 * Add a labour item using TWO-STEP approach:
 * Step 1: Add via save_job.php with items parameter
 * Step 2: Edit via items_save.php to set price and note
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
  
  console.log(`HireHop Items: Adding ${itemType} (list_id=${listId}) to job ${jobId}`)
  console.log(`HireHop Items: Price=${price}, Note="${note}"`)
  
  try {
    // =========================================================================
    // STEP 1: Get current items to track what exists
    // =========================================================================
    const itemsBefore = await fetchJobItems(jobId)
    const existingIds = new Set(itemsBefore.map(i => i.ID))
    console.log(`HireHop Items: Job has ${itemsBefore.length} items before adding`)
    
    // =========================================================================
    // STEP 2: Add the item using save_job.php with items parameter
    // =========================================================================
    // Format: items = { "c{list_id}": quantity } where c = labour/crew item
    const itemsToAdd = { [`c${listId}`]: 1 }
    
    console.log(`HireHop Items: Step 1 - Adding via save_job.php:`, JSON.stringify(itemsToAdd))
    
    const step1Params = new URLSearchParams({
      job: jobId,
      items: JSON.stringify(itemsToAdd),
      token: token,
    })
    
    const step1Response = await fetch(`https://${domain}/api/save_job.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: step1Params.toString(),
    })
    
    if (!step1Response.ok) {
      return { 
        itemId: '', 
        success: false, 
        error: `Step 1 failed: HTTP ${step1Response.status}` 
      }
    }
    
    const step1Text = await step1Response.text()
    console.log(`HireHop Items: Step 1 response (first 300 chars):`, step1Text.substring(0, 300))
    
    if (step1Text.trim().startsWith('<')) {
      return { 
        itemId: '', 
        success: false, 
        error: 'Step 1: Authentication failed - received HTML' 
      }
    }
    
    const step1Result = JSON.parse(step1Text)
    
    if (step1Result.error) {
      return {
        itemId: '',
        success: false,
        error: `Step 1 error: ${step1Result.error}`
      }
    }
    
    // =========================================================================
    // STEP 3: Fetch items again to find the new one
    // =========================================================================
    const itemsAfter = await fetchJobItems(jobId)
    console.log(`HireHop Items: Job has ${itemsAfter.length} items after adding`)
    
    // Find the new item (ID that didn't exist before, matching list_id and kind=4)
    const newItem = itemsAfter.find(item => 
      !existingIds.has(item.ID) && 
      item.LIST_ID === String(listId) && 
      item.kind === '4'
    )
    
    if (!newItem) {
      // Maybe the response contains it directly?
      if (step1Result.items && Array.isArray(step1Result.items)) {
        const fromResponse = step1Result.items.find((i: HireHopRawItem) => 
          i.LIST_ID === String(listId) && i.kind === '4' && !existingIds.has(i.ID)
        )
        if (fromResponse) {
          console.log(`HireHop Items: Found new item in response: ${fromResponse.ID}`)
        }
      }
      
      console.log(`HireHop Items: Could not find new item. Looking for LIST_ID=${listId}, kind=4`)
      console.log(`HireHop Items: New items after add:`, 
        itemsAfter.filter(i => !existingIds.has(i.ID)).map(i => ({ 
          ID: i.ID, 
          LIST_ID: i.LIST_ID, 
          kind: i.kind,
          name: i.NAME || i.title 
        }))
      )
      
      return {
        itemId: '',
        success: false,
        error: 'Item may have been added but could not find its ID'
      }
    }
    
    const newItemId = newItem.ID
    console.log(`HireHop Items: Found new item ID: ${newItemId}`)
    
    // =========================================================================
    // STEP 4: Edit the item to set price, note, and parent header
    // =========================================================================
    console.log(`HireHop Items: Step 2 - Editing item ${newItemId}`)
    
    const now = new Date()
    const localDateTime = now.toISOString().slice(0, 19).replace('T', ' ')
    
    const step2Params = new URLSearchParams({
      job: jobId,
      kind: '4',                    // Labour item
      id: newItemId,                // Edit this existing item
      list_id: String(listId),
      qty: '1',
      unit_price: String(price),
      price: String(price),
      price_type: '0',
      add: note,                    // Item note (ADDITIONAL field)
      cust_add: '',
      memo: '',
      name: '',
      parent: headerId,             // Move under this header
      acc_nominal: '29',
      acc_nominal_po: '30',
      vat_rate: '0',
      value: '0',
      cost_price: '0',
      weight: '0',
      start: '',
      end: '',
      duration: '0',
      country_origin: '',
      hs_code: '',
      flag: '0',
      priority_confirm: '0',
      no_shortfall: '1',
      no_availability: '0',
      ignore: '0',
      local: localDateTime,
      token: token,
    })
    
    const step2Response = await fetch(`https://${domain}/php_functions/items_save.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: step2Params.toString(),
    })
    
    if (!step2Response.ok) {
      return { 
        itemId: newItemId, 
        success: true,  // Item was created, just couldn't edit
        error: `Item created but edit failed: HTTP ${step2Response.status}` 
      }
    }
    
    const step2Text = await step2Response.text()
    console.log(`HireHop Items: Step 2 response (first 200 chars):`, step2Text.substring(0, 200))
    
    if (step2Text.trim().startsWith('<')) {
      return { 
        itemId: newItemId, 
        success: true,
        error: 'Item created but edit auth failed' 
      }
    }
    
    const step2Result = JSON.parse(step2Text)
    
    if (step2Result.error) {
      return {
        itemId: newItemId,
        success: true,
        error: `Item created but edit error: ${step2Result.error}`
      }
    }
    
    console.log(`HireHop Items: Successfully added and edited item ${newItemId}`)
    return { 
      itemId: newItemId, 
      success: true 
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
// POST HANDLER
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

    const body = await request.json() as AddItemRequest
    const { jobId, items } = body

    if (!jobId || !items || items.length === 0) {
      return NextResponse.json(
        { success: false, error: 'Missing jobId or items' },
        { status: 400 }
      )
    }

    console.log('='.repeat(60))
    console.log(`HireHop Items: Adding ${items.length} item(s) to job ${jobId}`)
    console.log('='.repeat(60))

    // =========================================================================
    // Find or create header
    // =========================================================================
    console.log('HireHop Items: Fetching items for job', jobId)
    const existingItems = await fetchJobItems(jobId)
    
    let headerId: string
    const existingHeader = findExistingHeader(existingItems)
    
    if (existingHeader) {
      headerId = existingHeader.id
    } else {
      console.log('HireHop Items: Creating new "Crew & transport" header')
      headerId = await createHeader(jobId, 'Crew & transport')
    }

    // =========================================================================
    // Add each item
    // =========================================================================
    const results: ItemResult[] = []
    
    for (const item of items) {
      const note = buildItemNote(item.date, item.time, item.venue)
      
      const result = await addLabourItem(
        jobId,
        headerId,
        item.type,
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

    const successCount = results.filter(r => r.success).length
    console.log(`HireHop Items: Completed - ${successCount}/${items.length} items added`)

    return NextResponse.json({
      success: successCount === items.length,
      partial: successCount > 0 && successCount < items.length,
      headerId,
      results,
    })

  } catch (error) {
    console.error('HireHop Items: Fatal error:', error)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      },
      { status: 500 }
    )
  }
}