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
// CATEGORY FILTERING
// =============================================================================

/**
 * HireHop category IDs to EXCLUDE when job type is "Equipment"
 * These are vehicles, delivery charges, crew, etc. - not actual equipment
 */
export const EXCLUDED_CATEGORIES_FOR_EQUIPMENT = [
  // Vehicles
  369,  // VEHICLES (parent category)
  370,  // Vehicles
  371,  // Vehicle accessories
  // Delivery-related items
  496,  // Deliveries and Collections (parent)
  497,  // Deliveries
  498,  // Collections
  499,  // Crew
  500,  // Charges
]

/**
 * HireHop category IDs that ARE vehicles (for vehicle-only jobs)
 */
export const VEHICLE_CATEGORIES = [
  369,  // VEHICLES (parent category)
  370,  // Vehicles
  371,  // Vehicle accessories
]

/**
 * HireHop category IDs that are service/admin items (not physical equipment)
 */
export const SERVICE_CATEGORIES = [
  496,  // Deliveries and Collections (parent)
  497,  // Deliveries
  498,  // Collections
  499,  // Crew
  500,  // Charges
]

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
  barcode?: string
  // We intentionally exclude price fields
}

export interface HireHopItemsResponse {
  success: boolean
  items: HireHopItem[]
  totalItems: number
  error?: string
}

export type ItemFilterMode = 'all' | 'equipment' | 'vehicles'

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
    
    // Check for HTML error (auth failure)
    if (responseText.trim().startsWith('<')) {
      console.error('HireHop: Job items returned HTML - possible auth error')
      return {
        success: false,
        items: [],
        totalItems: 0,
        error: 'Authentication error - received HTML instead of JSON'
      }
    }
    
    let rawItems: Record<string, unknown>[]
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
    
    // Clean logging - just count, not full structure
    console.log(`HireHop: Retrieved ${rawItems.length} items in ${Date.now() - startTime}ms`)
    
    // Transform items - extract only what we need (no prices!)
    const items: HireHopItem[] = rawItems.map(item => ({
      id: String(item.ID || item.id || item.ITEM_ID || item.LIST_ID || ''),
      name: String(item.NAME || item.name || item.title || 'Unknown Item'),
      quantity: parseInt(String(item.qty || item.QTY || item.quantity || item.QUANTITY || '1'), 10),
      category: item.CATEGORY ? String(item.CATEGORY) : undefined,
      categoryId: item.CATEGORY_ID ? parseInt(String(item.CATEGORY_ID), 10) : undefined,
      isVirtual: item.VIRTUAL === '1' || item.VIRTUAL === 1 || item.virtual === true,
      barcode: item.BARCODE ? String(item.BARCODE) : undefined,
    }))
    
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

/**
 * Fetch items for a HireHop job with filtering based on job type
 * 
 * @param jobId - The HireHop job ID
 * @param filterMode - 'equipment' excludes vehicles/services, 'vehicles' shows only vehicles, 'all' shows everything
 * @returns Filtered array of items
 */
export async function getJobItemsFiltered(
  jobId: string, 
  filterMode: ItemFilterMode = 'all'
): Promise<HireHopItemsResponse> {
  // First get all items
  const result = await getJobItems(jobId)
  
  if (!result.success) {
    return result
  }
  
  // Apply filtering based on mode
  let filteredItems: HireHopItem[]
  
  switch (filterMode) {
    case 'equipment':
      // Exclude vehicles, services, crew, charges etc.
      // Also exclude virtual items (placeholders)
      filteredItems = result.items.filter(item => {
        // Skip virtual items
        if (item.isVirtual) return false
        
        // Skip items in excluded categories
        if (item.categoryId && EXCLUDED_CATEGORIES_FOR_EQUIPMENT.includes(item.categoryId)) {
          return false
        }
        
        return true
      })
      console.log(`HireHop: Filtered to ${filteredItems.length} equipment items (from ${result.items.length} total)`)
      break
      
    case 'vehicles':
      // Only show vehicle items
      filteredItems = result.items.filter(item => {
        // Skip virtual items
        if (item.isVirtual) return false
        
        // Only include items in vehicle categories
        if (item.categoryId && VEHICLE_CATEGORIES.includes(item.categoryId)) {
          return true
        }
        
        return false
      })
      console.log(`HireHop: Filtered to ${filteredItems.length} vehicle items (from ${result.items.length} total)`)
      break
      
    case 'all':
    default:
      // No filtering except virtual items
      filteredItems = result.items.filter(item => !item.isVirtual)
      break
  }
  
  return {
    success: true,
    items: filteredItems,
    totalItems: filteredItems.length
  }
}

/**
 * Determine the appropriate filter mode based on the job's "What is it?" value
 * 
 * @param whatIsIt - The job's whatIsIt value from Monday.com ('equipment' | 'vehicle' | undefined)
 * @returns The appropriate filter mode for HireHop items
 */
export function getFilterModeForJob(whatIsIt: 'equipment' | 'vehicle' | undefined): ItemFilterMode {
  switch (whatIsIt) {
    case 'equipment':
      return 'equipment'  // Exclude vehicles and services
    case 'vehicle':
      return 'all'        // Show everything (vehicle + any extras they might want)
    default:
      return 'all'        // Unknown - show everything to be safe
  }
}