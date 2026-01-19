/**
 * HireHop API Client
 * 
 * All HireHop API interactions go through this module.
 * The API token is kept server-side only - never exposed to the browser.
 */

// =============================================================================
// API HELPERS
// =============================================================================

// Get API token from environment (server-side only)
function getApiToken(): string {
  const token = process.env.HIREHOP_API_TOKEN
  if (!token) {
    throw new Error('HIREHOP_API_TOKEN environment variable is not set')
  }
  return token
}

// Get HireHop domain (defaults to hirehop.net)
function getHireHopDomain(): string {
  return process.env.HIREHOP_DOMAIN || 'hirehop.net'
}

// =============================================================================
// TYPES
// =============================================================================

export interface HireHopItem {
  id: string
  name: string
  quantity: number
  category?: string
  categoryId?: number
  isVirtual?: boolean
  // We intentionally exclude price fields
}

export interface HireHopItemsResponse {
  success: boolean
  items: HireHopItem[]
  totalItems: number
  error?: string
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/**
 * Fetch all items (equipment/supply list) for a HireHop job
 * 
 * @param jobId - The HireHop job ID (e.g., "14829")
 * @returns Array of items with names and quantities (no prices)
 */
export async function getJobItems(jobId: string): Promise<HireHopItemsResponse> {
  try {
    const token = getApiToken()
    const domain = getHireHopDomain()
    const encodedToken = encodeURIComponent(token)
    
    const itemsUrl = `https://${domain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`
    
    console.log(`HireHop: Fetching items for job ${jobId}`)
    const startTime = Date.now()
    
    const response = await fetch(itemsUrl)
    
    if (!response.ok) {
      console.error(`HireHop: Failed to fetch items - HTTP ${response.status}`)
      return {
        success: false,
        items: [],
        totalItems: 0,
        error: `Failed to fetch items: HTTP ${response.status}`
      }
    }
    
    const responseText = await response.text()
    
    let rawItems: any[]
    try {
      const parsed = JSON.parse(responseText)
      // Response could be an array directly or an object with items property
      rawItems = Array.isArray(parsed) ? parsed : (parsed.items || [])
    } catch (parseError) {
      console.error('HireHop: Failed to parse response JSON:', parseError)
      return {
        success: false,
        items: [],
        totalItems: 0,
        error: 'Failed to parse HireHop response'
      }
    }
    
    console.log(`HireHop: Retrieved ${rawItems.length} items in ${Date.now() - startTime}ms`)
    
    // Transform items - extract only what we need (no prices!)
    const items: HireHopItem[] = rawItems.map(item => ({
      id: String(item.ID || item.id || item.ITEM_ID || ''),
      name: item.NAME || item.name || item.title || 'Unknown Item',
      quantity: parseInt(item.qty || item.QTY || item.quantity || item.QUANTITY || '1', 10),
      category: item.CATEGORY || item.category || undefined,
      categoryId: item.CATEGORY_ID ? parseInt(item.CATEGORY_ID, 10) : undefined,
      isVirtual: item.VIRTUAL === '1' || item.VIRTUAL === 1 || item.virtual === true
    }))
    
    // Log raw response structure for debugging (first item only)
    if (rawItems.length > 0) {
      console.log('HireHop: Sample item structure:', JSON.stringify(rawItems[0], null, 2))
    }
    
    return {
      success: true,
      items,
      totalItems: items.length
    }
    
  } catch (error) {
    console.error('HireHop: Error fetching items:', error)
    return {
      success: false,
      items: [],
      totalItems: 0,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
