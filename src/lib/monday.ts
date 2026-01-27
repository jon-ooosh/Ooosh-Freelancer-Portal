/**
 * Monday.com API Client
 * 
 * All Monday.com API interactions go through this module.
 * The API token is kept server-side only - never exposed to the browser.
 * 
 * Column IDs are specific to the Ooosh Monday.com boards.
 */

const MONDAY_API_URL = 'https://api.monday.com/v2'
const MONDAY_FILE_URL = 'https://api.monday.com/v2/file'

// =============================================================================
// COLUMN ID MAPPINGS
// =============================================================================

// Freelance Crew board columns
export const FREELANCER_COLUMNS = {
  email: 'email',
  phone: 'numbers0',
  passwordHash: 'text_mkywnmqa',
  emailVerified: 'color_mkywshb8',        // Status column - "Done" = verified
  notificationsPausedUntil: 'date_mkywsxdc',
  lastLogin: 'date_mkywyq3h',
  mutedJobIds: 'text_mkzws3r3', 
} as const

// Deliveries & Collections board columns
export const DC_COLUMNS = {
  hhRef: 'text2',
  deliverCollect: 'status_1',              // "Delivery" or "Collection"
  whatIsIt: 'status4',                     // "Equipment" or "A vehicle"
  date: 'date4',
  timeToArrive: 'hour',
  venueConnect: 'connect_boards6',         // Connect column linking to Address Book
  driverConnect: 'connect_boards3',
  driverEmailMirror: 'driver_email__gc_',  // Text column populated by General Caster from mirror
  status: 'status90',
  keyPoints: 'key_points___summary',
  runGroup: 'color_mkxvwn11',              // Status: A, B, C, D, E
  driverPayMirror: 'lookup_mkzsfkg2',      // Mirror column: driver pay from D&C Costings
  groupedRunFee: 'numeric_mky3z4gm',       // Reserved for future: aggregated fee for grouped runs
  completionNotes: 'long_text_mkyweafm',
  completionPhotos: 'file_mkyww89n',
  signature: 'file_mkywf297',
  completedAtDate: 'date_mkywpv0h',
  completedAtTime: 'hour_mkywgx0x',
  extraCharges: 'numeric_mkyws6s',
  extraChargesReason: 'long_text_mkywkth4',
  clientEmail: 'email',                    // Client email for delivery notes
} as const

// Address Book / Venues board columns
export const VENUE_COLUMNS = {
  address: 'long_text',           // Full address ("Load in address")
  whatThreeWords: 'text3',        // What3Words location
  contact1: 'text',               // Contact 1 name
  contact2: 'text4',              // Contact 2 name
  phone: 'phone',                 // Phone number 1
  phone2: 'phone_mkznt3rr',       // Phone number 2
  email: 'email',                 // Email address
  accessNotes: 'long_text9',      // Access notes
  stageNotes: 'long_text7',       // Notes re stage
  files: 'files',                 // Files
} as const

// Resources / Staff Training board columns
export const RESOURCES_COLUMNS = {
  shareWithFreelancers: 'color_mkzs6btf',  // Status column: "Share with freelancers"
  files: 'files',                           // Files column
} as const

// List of column IDs we need to fetch for jobs
// This dramatically reduces response size and speeds up queries
const DC_COLUMNS_TO_FETCH = [
  DC_COLUMNS.hhRef,
  DC_COLUMNS.deliverCollect,
  DC_COLUMNS.whatIsIt,            // Equipment vs Vehicle
  DC_COLUMNS.date,
  DC_COLUMNS.timeToArrive,
  DC_COLUMNS.venueConnect,        // Need this to get linked venue ID
  DC_COLUMNS.driverEmailMirror,
  DC_COLUMNS.status,
  DC_COLUMNS.keyPoints,
  DC_COLUMNS.runGroup,
  DC_COLUMNS.driverPayMirror,
  DC_COLUMNS.completedAtDate,
  DC_COLUMNS.completionNotes,
  DC_COLUMNS.clientEmail,
]

// List of column IDs we need to fetch for venues
const VENUE_COLUMNS_TO_FETCH = [
  VENUE_COLUMNS.address,
  VENUE_COLUMNS.whatThreeWords,
  VENUE_COLUMNS.contact1,
  VENUE_COLUMNS.contact2,
  VENUE_COLUMNS.phone,
  VENUE_COLUMNS.phone2,
  VENUE_COLUMNS.email,
  VENUE_COLUMNS.accessNotes,
  VENUE_COLUMNS.stageNotes,
  VENUE_COLUMNS.files,
]

// List of column IDs we need to fetch for resources
const RESOURCES_COLUMNS_TO_FETCH = [
  RESOURCES_COLUMNS.shareWithFreelancers,
  RESOURCES_COLUMNS.files,
]

// =============================================================================
// API HELPERS
// =============================================================================

// Get API token from environment (server-side only)
function getApiToken(): string {
  const token = process.env.MONDAY_API_TOKEN
  if (!token) {
    throw new Error('MONDAY_API_TOKEN environment variable is not set')
  }
  return token
}

// Generic Monday.com API query function
export async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getApiToken(),
      'API-Version': '2025-04',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    throw new Error(`Monday API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  
  if (data.errors) {
    console.error('Monday API errors:', data.errors)
    throw new Error(`Monday API query error: ${JSON.stringify(data.errors)}`)
  }

  return data.data as T
}

// Board IDs from environment
export function getBoardIds() {
  return {
    deliveries: process.env.MONDAY_BOARD_ID_DELIVERIES || '',
    freelancers: process.env.MONDAY_BOARD_ID_FREELANCERS || '',
    costings: process.env.MONDAY_BOARD_ID_COSTINGS || '',
    venues: process.env.MONDAY_BOARD_ID_VENUES || '',
    resources: '1829209673',  // Staff Training board - hardcoded as it's stable
  }
}

// =============================================================================
// FILE UPLOAD FUNCTIONS
// =============================================================================

export interface FileAsset {
  assetId: string
  name: string
  fileType?: string    // e.g., "ASSET", "MONDAY_DOC", "GOOGLE_DRIVE", etc.
  url?: string         // For link-type files (Google Docs, etc.)
}

export interface FileAssetWithUrl extends FileAsset {
  publicUrl: string
}

/**
 * Extract file assets from a Monday file column value
 * File column values are stored as JSON with different structures:
 * - Regular files: {"files":[{"assetId":123,"name":"file.pdf","fileType":"ASSET"}]}
 * - Monday Docs: {"files":[{"name":"Doc","fileType":"MONDAY_DOC","objectId":"abc"}]}
 * - Google Drive: {"files":[{"name":"Doc","fileType":"GOOGLE_DRIVE","linkToFile":"https://..."}]}
 */
export function extractFileAssets(fileColumnValue: string | undefined): FileAsset[] {
  if (!fileColumnValue) return []
  
  try {
    const parsed = JSON.parse(fileColumnValue)
    if (parsed.files && Array.isArray(parsed.files)) {
      return parsed.files.map((f: Record<string, unknown>) => {
        // Log non-ASSET files to see their full structure
        if (f.fileType && f.fileType !== 'ASSET') {
          console.log('Monday: Non-ASSET file entry:', JSON.stringify(f))
        }
        
        return {
          assetId: f.assetId ? String(f.assetId) : (f.objectId ? String(f.objectId) : ''),
          name: String(f.name || 'Unknown'),
          fileType: String(f.fileType || 'ASSET'),
          // Try multiple possible URL locations
          // linkToFile can be a direct string (Google Drive) or an object with url property
          url: (typeof f.linkToFile === 'string' ? f.linkToFile : null) ||
               (f.linkToFile as { url?: string } | null)?.url || 
               (f.url as string) || 
               (f.link as string) || 
               (f.publicUrl as string) ||
               undefined,
        }
      })
    }
  } catch (e) {
    console.error('Monday: Failed to parse files column:', e)
  }
  
  return []
}

/**
 * Get the public URL for a Monday.com asset
 * Note: These URLs are temporary and expire
 */
export async function getAssetPublicUrl(assetId: string): Promise<FileAssetWithUrl | null> {
  const query = `
    query ($assetIds: [ID!]!) {
      assets(ids: $assetIds) {
        id
        name
        public_url
      }
    }
  `
  
  const result = await mondayQuery<{
    assets: Array<{
      id: string
      name: string
      public_url: string
    }>
  }>(query, { assetIds: [assetId] })
  
  const asset = result.assets?.[0]
  if (!asset) return null
  
  return {
    assetId: asset.id,
    name: asset.name,
    publicUrl: asset.public_url
  }
}

/**
 * Upload a file to a Monday.com file column
 * 
 * Uses Monday's file upload API with multipart form data
 * CRITICAL: Must include the 'map' parameter to link file to GraphQL variable
 * 
 * @param itemId - The item ID to attach the file to
 * @param columnId - The file column ID
 * @param fileBuffer - The file content as a Buffer
 * @param filename - The filename to use
 * @param contentType - MIME type (default: 'image/png')
 * @returns Success status and optional asset ID
 */
export async function uploadFileToColumn(
  itemId: string,
  columnId: string,
  fileBuffer: Buffer,
  filename: string,
  contentType: string = 'image/png'
): Promise<{ success: boolean; assetId?: string; error?: string }> {
  try {
    const token = getApiToken()
    
    // Create the GraphQL mutation with $file variable declaration
    const mutation = `mutation($file: File!) {
      add_file_to_column(
        item_id: ${itemId},
        column_id: "${columnId}",
        file: $file
      ) {
        id
        name
        url
      }
    }`

    // Create form data for multipart upload
    const formData = new FormData()
    
    // 1. Append the query
    formData.append('query', mutation)
    
    // 2. Append variables (file is null here - actual file comes from map)
    formData.append('variables', JSON.stringify({ file: null }))
    
    // 3. THE CRITICAL MAP FIELD - links "0" to variables.file
    // This tells Monday.com which form field contains the file data
    formData.append('map', JSON.stringify({ "0": ["variables.file"] }))
    
    // 4. Append the actual file with key "0" (matches the map)
    // Convert Buffer to Uint8Array for Blob compatibility
    const blob = new Blob([new Uint8Array(fileBuffer)], { type: contentType })
    formData.append('0', blob, filename)

    const isDebug = process.env.DEBUG_MODE === 'true'
    if (isDebug) {
      console.log(`Monday: Uploading file ${filename} (${fileBuffer.length} bytes) to item ${itemId}, column ${columnId}`)
    }

    // POST to the FILE endpoint (not the regular /v2 endpoint!)
    const response = await fetch(MONDAY_FILE_URL, {
      method: 'POST',
      headers: {
        'Authorization': token,
        // DO NOT set Content-Type - fetch will set it with boundary for multipart
      },
      body: formData,
    })

    const responseText = await response.text()
    
    if (!response.ok) {
      console.error('Monday file upload HTTP error:', response.status, responseText)
      return { success: false, error: `Upload failed: HTTP ${response.status}` }
    }

    let data
    try {
      data = JSON.parse(responseText)
    } catch {
      console.error('Monday file upload: Invalid JSON response', responseText)
      return { success: false, error: 'Invalid response from Monday' }
    }
    
    if (data.errors) {
      console.error('Monday file upload GraphQL errors:', data.errors)
      return { success: false, error: data.errors[0]?.message || 'Upload failed' }
    }

    if (isDebug) {
      console.log('Monday file upload success:', data.data?.add_file_to_column)
    }
    
    return { 
      success: true, 
      assetId: data.data?.add_file_to_column?.id 
    }
  } catch (error) {
    console.error('File upload exception:', error)
    return { 
      success: false, 
      error: error instanceof Error ? error.message : 'Upload failed' 
    }
  }
}

/**
 * Upload a base64-encoded image to a Monday.com file column
 * 
 * Convenience wrapper for signature/photo uploads from browser canvas
 * 
 * @param itemId - The Monday item ID
 * @param columnId - The file column ID
 * @param base64Data - Base64-encoded image data (may include data URL prefix)
 * @param filename - The filename to use
 */
export async function uploadBase64ImageToColumn(
  itemId: string,
  columnId: string,
  base64Data: string,
  filename: string
): Promise<{ success: boolean; assetId?: string; error?: string }> {
  // Remove data URL prefix if present (e.g., "data:image/png;base64,")
  const base64Clean = base64Data.replace(/^data:image\/\w+;base64,/, '')
  
  // Convert base64 to Buffer
  const buffer = Buffer.from(base64Clean, 'base64')
  
  const isDebug = process.env.DEBUG_MODE === 'true'
  if (isDebug) {
    console.log(`Monday: Converting base64 image (${buffer.length} bytes) for upload as ${filename}`)
  }
  
  return uploadFileToColumn(itemId, columnId, buffer, filename)
}

// =============================================================================
// FREELANCER QUERIES
// =============================================================================

export interface FreelancerRecord {
  id: string
  name: string
  email: string
  phone?: string
  passwordHash?: string
  emailVerified: boolean
  notificationsPausedUntil?: string
  lastLogin?: string
  mutedJobIds?: string
}

/**
 * Find a freelancer by email address
 */
export async function findFreelancerByEmail(email: string): Promise<FreelancerRecord | null> {
  const boardId = getBoardIds().freelancers
  
  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_FREELANCERS is not configured')
  }

  // Query to find freelancer by email
  const query = `
    query ($boardId: [ID!]!) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
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

  interface QueryResult {
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
  }

  const result = await mondayQuery<QueryResult>(query, { boardId: [boardId] })
  
  const items = result.boards[0]?.items_page?.items || []
  
  // Find the item with matching email (case-insensitive)
  const normalizedEmail = email.toLowerCase().trim()
  const matchingItem = items.find(item => {
    const emailCol = item.column_values.find(col => col.id === FREELANCER_COLUMNS.email)
    return emailCol?.text?.toLowerCase().trim() === normalizedEmail
  })

  if (!matchingItem) {
    return null
  }

  // Extract column values into a map
  const columnMap = matchingItem.column_values.reduce((acc, col) => {
    acc[col.id] = { text: col.text, value: col.value }
    return acc
  }, {} as Record<string, { text: string; value: string }>)

  // Check if email is verified (status column with "Done" label)
  const verifiedStatus = columnMap[FREELANCER_COLUMNS.emailVerified]?.text
  const isVerified = verifiedStatus?.toLowerCase() === 'done'

  return {
    id: matchingItem.id,
    name: matchingItem.name,
    email: columnMap[FREELANCER_COLUMNS.email]?.text || email,
    phone: columnMap[FREELANCER_COLUMNS.phone]?.text,
    passwordHash: columnMap[FREELANCER_COLUMNS.passwordHash]?.text,
    emailVerified: isVerified,
    notificationsPausedUntil: columnMap[FREELANCER_COLUMNS.notificationsPausedUntil]?.text,
    lastLogin: columnMap[FREELANCER_COLUMNS.lastLogin]?.text,
    mutedJobIds: columnMap[FREELANCER_COLUMNS.mutedJobIds]?.text,
  }
}

/**
 * Update a freelancer's text column value
 */
export async function updateFreelancerTextColumn(
  itemId: string, 
  columnId: string, 
  value: string
): Promise<void> {
  const boardId = getBoardIds().freelancers

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(
        board_id: $boardId, 
        item_id: $itemId, 
        column_id: $columnId, 
        value: $value
      ) {
        id
      }
    }
  `

  await mondayQuery(mutation, { boardId, itemId, columnId, value })
}

/**
 * Update a freelancer's status column (like Email Verified)
 */
export async function updateFreelancerStatusColumn(
  itemId: string, 
  columnId: string, 
  label: string
): Promise<void> {
  const boardId = getBoardIds().freelancers

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(
        board_id: $boardId, 
        item_id: $itemId, 
        column_id: $columnId, 
        value: $value
      ) {
        id
      }
    }
  `

  await mondayQuery(mutation, { 
    boardId, 
    itemId, 
    columnId, 
    value: JSON.stringify({ label })
  })
}

/**
 * Update a freelancer's date column
 */
export async function updateFreelancerDateColumn(
  itemId: string, 
  columnId: string, 
  date: Date
): Promise<void> {
  const boardId = getBoardIds().freelancers
  
  // Format date as YYYY-MM-DD for Monday
  const dateStr = date.toISOString().split('T')[0]

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(
        board_id: $boardId, 
        item_id: $itemId, 
        column_id: $columnId, 
        value: $value
      ) {
        id
      }
    }
  `

  await mondayQuery(mutation, { 
    boardId, 
    itemId, 
    columnId, 
    value: JSON.stringify({ date: dateStr })
  })
}

// =============================================================================
// VENUE QUERIES
// =============================================================================

export interface VenueRecord {
  id: string
  name: string
  address?: string
  whatThreeWords?: string
  contact1?: string
  contact2?: string
  phone?: string
  phone2?: string
  email?: string
  accessNotes?: string
  stageNotes?: string
  files?: FileAsset[]
}

/**
 * Parse a phone column value from Monday.com
 * Phone columns store data as JSON like {"phone":"123","countryShortName":"GB"}
 */
function parsePhoneValue(value: string | undefined, text: string | undefined): string {
  if (value) {
    try {
      const phoneData = JSON.parse(value)
      if (phoneData.phone) {
        return phoneData.phone
      }
    } catch {
      // If not JSON, fall through to text
    }
  }
  return text || ''
}

/**
 * Get venue details by ID
 */
export async function getVenueById(venueId: string): Promise<VenueRecord | null> {
  const boardId = getBoardIds().venues

  if (!boardId) {
    console.warn('MONDAY_BOARD_ID_VENUES is not configured')
    return null
  }

  console.log('Monday: Fetching venue', venueId, 'from board', boardId)

  // Query for a specific item by ID
  const query = `
    query ($itemIds: [ID!]!) {
      items(ids: $itemIds) {
        id
        name
        column_values(ids: ${JSON.stringify(VENUE_COLUMNS_TO_FETCH)}) {
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
      column_values: Array<{
        id: string
        text: string
        value: string
      }>
    }>
  }>(query, { itemIds: [venueId] })

  const item = result.items?.[0]
  
  if (!item) {
    console.log('Monday: Venue not found:', venueId)
    return null
  }

  // Build column map
  const columnMap = item.column_values.reduce((acc, col) => {
    acc[col.id] = { text: col.text, value: col.value }
    return acc
  }, {} as Record<string, { text: string; value: string }>)

  // Helper to get text from a column
  const getColText = (colId: string) => columnMap[colId]?.text || ''

  // Parse phone numbers (they're stored as JSON)
  const phone1 = parsePhoneValue(
    columnMap[VENUE_COLUMNS.phone]?.value,
    columnMap[VENUE_COLUMNS.phone]?.text
  )
  const phone2 = parsePhoneValue(
    columnMap[VENUE_COLUMNS.phone2]?.value,
    columnMap[VENUE_COLUMNS.phone2]?.text
  )
  
  // Extract files from the files column
  const files = extractFileAssets(columnMap[VENUE_COLUMNS.files]?.value)

  return {
    id: item.id,
    name: item.name,
    address: getColText(VENUE_COLUMNS.address),
    whatThreeWords: getColText(VENUE_COLUMNS.whatThreeWords),
    contact1: getColText(VENUE_COLUMNS.contact1),
    contact2: getColText(VENUE_COLUMNS.contact2),
    phone: phone1,
    phone2: phone2,
    email: getColText(VENUE_COLUMNS.email),
    accessNotes: getColText(VENUE_COLUMNS.accessNotes),
    stageNotes: getColText(VENUE_COLUMNS.stageNotes),
    files,
  }
}

// =============================================================================
// DELIVERY/COLLECTION QUERIES
// =============================================================================

export interface JobRecord {
  id: string
  name: string
  hhRef?: string
  type: 'delivery' | 'collection'
  whatIsIt?: 'equipment' | 'vehicle'      // Equipment or A vehicle
  date?: string
  time?: string
  venueName?: string
  venueId?: string              // ID of linked venue for fetching details
  status: string
  runGroup?: string
  driverPay?: number
  driverEmail?: string
  keyNotes?: string
  completedAtDate?: string
  completedAtTime?: string
  completionNotes?: string
  clientEmail?: string          // Client email for delivery notes
}

/**
 * Parse the "What is it?" status column into a normalized value
 */
function parseWhatIsIt(text: string | undefined): 'equipment' | 'vehicle' | undefined {
  if (!text) return undefined
  const normalized = text.toLowerCase().trim()
  if (normalized.includes('vehicle')) return 'vehicle'
  if (normalized.includes('equipment')) return 'equipment'
  return undefined
}

/**
 * Get all jobs for a specific freelancer (by email)
 * 
 * OPTIMIZED: Uses items_page_by_column_values to filter on Monday's server
 * instead of fetching all items and filtering locally.
 * This dramatically reduces query time from 6+ seconds to <1 second.
 */
export async function getJobsForFreelancer(freelancerEmail: string): Promise<JobRecord[]> {
  const boardId = getBoardIds().deliveries

  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_DELIVERIES is not configured')
  }

  const normalizedEmail = freelancerEmail.toLowerCase().trim()
  console.log('Monday: Fetching jobs for', normalizedEmail, 'from board', boardId)
  const startTime = Date.now()

  // OPTIMIZED: Use items_page_by_column_values to filter on the server
  // This returns only items where the driver email matches, instead of all 500+ items
  // 
  // API 2025-04 CHANGE: Connect board columns now return null for 'value' field.
  // We use BoardRelationValue fragment with linked_item_ids to get connected item IDs.
  const query = `
    query {
      items_page_by_column_values (
        board_id: ${boardId},
        columns: [
          {
            column_id: "${DC_COLUMNS.driverEmailMirror}",
            column_values: ["${normalizedEmail}"]
          }
        ],
        limit: 100
      ) {
        items {
          id
          name
          column_values(ids: ${JSON.stringify(DC_COLUMNS_TO_FETCH)}) {
            id
            text
            value
            ... on MirrorValue {
              display_value
            }
            ... on BoardRelationValue {
              linked_item_ids
            }
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    items_page_by_column_values: {
      items: Array<{
        id: string
        name: string
        column_values: Array<{
          id: string
          text: string
          value: string
          display_value?: string
          linked_item_ids?: string[]
        }>
      }>
    }
  }>(query)

  const queryTime = Date.now() - startTime
  const items = result.items_page_by_column_values?.items || []
  console.log('Monday: Query completed in', queryTime, 'ms, found', items.length, 'jobs')
  
  // No need to filter - Monday already filtered for us!
  const matchingItems = items

  // Transform matching items to JobRecord format
  return matchingItems.map(item => {
    const columnMap = item.column_values.reduce((acc, col) => {
      acc[col.id] = { 
        text: col.text, 
        value: col.value,
        display_value: col.display_value,
        linked_item_ids: col.linked_item_ids
      }
      return acc
    }, {} as Record<string, { text: string; value: string; display_value?: string; linked_item_ids?: string[] }>)

    const getColText = (colId: string) => {
      const col = columnMap[colId]
      return col?.display_value || col?.text || ''
    }

    // Determine job type from status
    const deliverCollectText = getColText(DC_COLUMNS.deliverCollect).toLowerCase()
    const jobType = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

    // Determine what is it (equipment or vehicle)
    const whatIsIt = parseWhatIsIt(getColText(DC_COLUMNS.whatIsIt))

     // Parse driver pay from mirror column
    const feeText = getColText(DC_COLUMNS.driverPayMirror)
    const driverPay = feeText ? parseFloat(feeText) : undefined

    // Extract venue ID from connect column
    // API 2025-04: Use linked_item_ids from BoardRelationValue fragment
    // (the 'value' field now returns null for connect board columns)
    let venueId: string | undefined
    const venueConnectCol = columnMap[DC_COLUMNS.venueConnect]
    if (venueConnectCol?.linked_item_ids && venueConnectCol.linked_item_ids.length > 0) {
      venueId = venueConnectCol.linked_item_ids[0]
    }

    return {
      id: item.id,
      name: item.name,
      hhRef: getColText(DC_COLUMNS.hhRef),
      type: jobType,
      whatIsIt,
      date: getColText(DC_COLUMNS.date),
      time: getColText(DC_COLUMNS.timeToArrive),
      venueName: getColText(DC_COLUMNS.venueConnect),
      venueId,
      status: getColText(DC_COLUMNS.status) || 'unknown',
      runGroup: getColText(DC_COLUMNS.runGroup),
      driverPay,
      driverEmail: getColText(DC_COLUMNS.driverEmailMirror),
      keyNotes: getColText(DC_COLUMNS.keyPoints),
      completedAtDate: getColText(DC_COLUMNS.completedAtDate),
      completionNotes: getColText(DC_COLUMNS.completionNotes),
      clientEmail: getColText(DC_COLUMNS.clientEmail),
    } as JobRecord
  })
}

/**
 * Get a single job by ID
 * 
 * Only returns the job if the specified email matches the assigned driver.
 * This ensures users can only view their own jobs.
 */
export async function getJobById(jobId: string, freelancerEmail: string): Promise<JobRecord | null> {
  const boardId = getBoardIds().deliveries

  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_DELIVERIES is not configured')
  }

  console.log('Monday: Fetching job', jobId, 'for', freelancerEmail)

  // Query for a specific item by ID
  // API 2025-04 CHANGE: Connect board columns now return null for 'value' field.
  // We use BoardRelationValue fragment with linked_item_ids to get connected item IDs.
  const query = `
    query ($itemIds: [ID!]!) {
      items(ids: $itemIds) {
        id
        name
        column_values(ids: ${JSON.stringify(DC_COLUMNS_TO_FETCH)}) {
          id
          text
          value
          ... on MirrorValue {
            display_value
          }
          ... on BoardRelationValue {
            linked_item_ids
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    items: Array<{
      id: string
      name: string
      column_values: Array<{
        id: string
        text: string
        value: string
        display_value?: string
        linked_item_ids?: string[]
      }>
    }>
  }>(query, { itemIds: [jobId] })

  const item = result.items?.[0]
  
  if (!item) {
    console.log('Monday: Job not found:', jobId)
    return null
  }

  // Build column map
  const columnMap = item.column_values.reduce((acc, col) => {
    acc[col.id] = { 
      text: col.text, 
      value: col.value,
      display_value: col.display_value,
      linked_item_ids: col.linked_item_ids
    }
    return acc
  }, {} as Record<string, { text: string; value: string; display_value?: string; linked_item_ids?: string[] }>)

  // Helper to get text from a column
  const getColText = (colId: string) => {
    const col = columnMap[colId]
    return col?.display_value || col?.text || ''
  }

  // Check if this job is assigned to the requesting user
  const driverEmail = getColText(DC_COLUMNS.driverEmailMirror).toLowerCase().trim()
  const normalizedEmail = freelancerEmail.toLowerCase().trim()

  if (driverEmail !== normalizedEmail) {
    console.log('Monday: Job', jobId, 'not assigned to', freelancerEmail, '(assigned to', driverEmail, ')')
    return null
  }

  // Determine job type
  const deliverCollectText = getColText(DC_COLUMNS.deliverCollect).toLowerCase()
  const jobType = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

  // Determine what is it (equipment or vehicle)
  const whatIsIt = parseWhatIsIt(getColText(DC_COLUMNS.whatIsIt))

  // Parse driver pay from mirror column
  const feeText = getColText(DC_COLUMNS.driverPayMirror)
  const driverPay = feeText ? parseFloat(feeText) : undefined

  // Extract venue ID from connect column
  // API 2025-04: Use linked_item_ids from BoardRelationValue fragment
  // (the 'value' field now returns null for connect board columns)
  let venueId: string | undefined
  const venueConnectCol = columnMap[DC_COLUMNS.venueConnect]
  if (venueConnectCol?.linked_item_ids && venueConnectCol.linked_item_ids.length > 0) {
    venueId = venueConnectCol.linked_item_ids[0]
  }

  return {
    id: item.id,
    name: item.name,
    hhRef: getColText(DC_COLUMNS.hhRef),
    type: jobType,
    whatIsIt,
    date: getColText(DC_COLUMNS.date),
    time: getColText(DC_COLUMNS.timeToArrive),
    venueName: getColText(DC_COLUMNS.venueConnect),
    venueId,
    status: getColText(DC_COLUMNS.status) || 'unknown',
    runGroup: getColText(DC_COLUMNS.runGroup),
    driverPay,
    driverEmail: driverEmail,
    keyNotes: getColText(DC_COLUMNS.keyPoints),
    completedAtDate: getColText(DC_COLUMNS.completedAtDate),
    completionNotes: getColText(DC_COLUMNS.completionNotes),
    clientEmail: getColText(DC_COLUMNS.clientEmail),
  }
}


/**
 * Update a freelancer's notification mute settings (global mute)
 * 
 * @param email - Freelancer's email
 * @param mutedUntil - Date to mute until, or null to unmute
 */
export async function updateFreelancerMuteUntil(
  email: string,
  mutedUntil: Date | null
): Promise<void> {
  // First find the freelancer to get their ID
  const freelancer = await findFreelancerByEmail(email)
  if (!freelancer) {
    throw new Error(`Freelancer not found: ${email}`)
  }

  const boardId = getBoardIds().freelancers

  if (mutedUntil === null) {
    // Clear the date - use empty string
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
        change_simple_column_value(
          board_id: $boardId, 
          item_id: $itemId, 
          column_id: $columnId, 
          value: $value
        ) {
          id
        }
      }
    `
    await mondayQuery(mutation, { 
      boardId, 
      itemId: freelancer.id, 
      columnId: FREELANCER_COLUMNS.notificationsPausedUntil,
      value: ''
    })
  } else {
    // Set the date
    const dateStr = mutedUntil.toISOString().split('T')[0]
    const mutation = `
      mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
        change_column_value(
          board_id: $boardId, 
          item_id: $itemId, 
          column_id: $columnId, 
          value: $value
        ) {
          id
        }
      }
    `
    await mondayQuery(mutation, { 
      boardId, 
      itemId: freelancer.id, 
      columnId: FREELANCER_COLUMNS.notificationsPausedUntil,
      value: JSON.stringify({ date: dateStr })
    })
  }
}

/**
 * Update a freelancer's per-job mute list
 * 
 * @param email - Freelancer's email
 * @param jobId - Job ID to mute/unmute
 * @param mute - true to mute, false to unmute
 */
export async function updateFreelancerJobMute(
  email: string,
  jobId: string,
  mute: boolean
): Promise<void> {
  const freelancer = await findFreelancerByEmail(email)
  if (!freelancer) {
    throw new Error(`Freelancer not found: ${email}`)
  }

  const boardId = getBoardIds().freelancers
  
  // Parse current muted jobs
  const currentMuted = freelancer.mutedJobIds
    ? freelancer.mutedJobIds.split(',').map(id => id.trim()).filter(Boolean)
    : []

  let newMuted: string[]
  if (mute) {
    // Add job ID if not already present
    if (!currentMuted.includes(jobId)) {
      newMuted = [...currentMuted, jobId]
    } else {
      newMuted = currentMuted
    }
  } else {
    // Remove job ID
    newMuted = currentMuted.filter(id => id !== jobId)
  }

  const newValue = newMuted.join(',')

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(
        board_id: $boardId, 
        item_id: $itemId, 
        column_id: $columnId, 
        value: $value
      ) {
        id
      }
    }
  `

  await mondayQuery(mutation, { 
    boardId, 
    itemId: freelancer.id, 
    columnId: FREELANCER_COLUMNS.mutedJobIds,
    value: newValue
  })
}

/**
 * Get freelancer by email - convenience wrapper that includes mute fields
 * 
 * This is the same as findFreelancerByEmail but named more clearly for webhook use.
 */
export async function getFreelancerByEmail(email: string): Promise<FreelancerRecord | null> {
  return findFreelancerByEmail(email)
}

/**
 * Get a job by ID without freelancer email verification
 * 
 * INTERNAL USE ONLY - for trusted webhook calls.
 * This function fetches job details without checking if the requesting user
 * is assigned to the job. Only use when the caller is already authenticated
 * (e.g., via webhook secret).
 */
export async function getJobByIdInternal(jobId: string): Promise<JobRecord | null> {
  const boardId = getBoardIds().deliveries

  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_DELIVERIES is not configured')
  }

  console.log('Monday: Fetching job (internal)', jobId)

  // Query for a specific item by ID
  // Uses same query structure as getJobById but without email verification
  const query = `
    query ($itemIds: [ID!]!) {
      items(ids: $itemIds) {
        id
        name
        column_values(ids: ${JSON.stringify(DC_COLUMNS_TO_FETCH)}) {
          id
          text
          value
          ... on MirrorValue {
            display_value
          }
          ... on BoardRelationValue {
            linked_item_ids
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    items: Array<{
      id: string
      name: string
      column_values: Array<{
        id: string
        text: string
        value: string
        display_value?: string
        linked_item_ids?: string[]
      }>
    }>
  }>(query, { itemIds: [jobId] })

  const item = result.items?.[0]
  
  if (!item) {
    console.log('Monday: Job not found:', jobId)
    return null
  }

  // Build column map
  const columnMap = item.column_values.reduce((acc, col) => {
    acc[col.id] = { 
      text: col.text, 
      value: col.value,
      display_value: col.display_value,
      linked_item_ids: col.linked_item_ids
    }
    return acc
  }, {} as Record<string, { text: string; value: string; display_value?: string; linked_item_ids?: string[] }>)

  // Helper to get text from a column
  const getColText = (colId: string) => {
    const col = columnMap[colId]
    return col?.display_value || col?.text || ''
  }

  // Determine job type
  const deliverCollectText = getColText(DC_COLUMNS.deliverCollect).toLowerCase()
  const jobType = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

  // Determine what is it (equipment or vehicle)
  const whatIsIt = parseWhatIsIt(getColText(DC_COLUMNS.whatIsIt))

  // Parse driver pay from mirror column
  const feeText = getColText(DC_COLUMNS.driverPayMirror)
  const driverPay = feeText ? parseFloat(feeText) : undefined

  // Extract venue ID from connect column
  // API 2025-04: Use linked_item_ids from BoardRelationValue fragment
  let venueId: string | undefined
  const venueConnectCol = columnMap[DC_COLUMNS.venueConnect]
  if (venueConnectCol?.linked_item_ids && venueConnectCol.linked_item_ids.length > 0) {
    venueId = venueConnectCol.linked_item_ids[0]
  }

  // Get driver email (no verification - we trust the webhook caller)
  const driverEmail = getColText(DC_COLUMNS.driverEmailMirror).toLowerCase().trim()

  return {
    id: item.id,
    name: item.name,
    hhRef: getColText(DC_COLUMNS.hhRef),
    type: jobType,
    whatIsIt,
    date: getColText(DC_COLUMNS.date),
    time: getColText(DC_COLUMNS.timeToArrive),
    venueName: getColText(DC_COLUMNS.venueConnect),
    venueId,
    status: getColText(DC_COLUMNS.status) || 'unknown',
    runGroup: getColText(DC_COLUMNS.runGroup),
    driverPay,
    driverEmail,
    keyNotes: getColText(DC_COLUMNS.keyPoints),
    completedAtDate: getColText(DC_COLUMNS.completedAtDate),
    completionNotes: getColText(DC_COLUMNS.completionNotes),
    clientEmail: getColText(DC_COLUMNS.clientEmail),
  }
}

/**
 * Get a freelancer's name by their email address
 * 
 * Used by webhooks to personalize notification emails.
 * Returns the freelancer's name or null if not found.
 */
export async function getFreelancerNameByEmail(email: string): Promise<string | null> {
  const freelancer = await findFreelancerByEmail(email)
  return freelancer?.name || null
}

/**
 * Update a job's status
 */
export async function updateJobStatus(itemId: string, status: string): Promise<void> {
  const boardId = getBoardIds().deliveries

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
      change_column_value(
        board_id: $boardId, 
        item_id: $itemId, 
        column_id: $columnId, 
        value: $value
      ) {
        id
      }
    }
  `

  await mondayQuery(mutation, { 
    boardId, 
    itemId, 
    columnId: DC_COLUMNS.status,
    value: JSON.stringify({ label: status })
  })
}

/**
 * Update job completion fields (notes, date, time, status)
 * Does NOT handle file uploads - those are done separately
 */
export async function updateJobCompletion(
  itemId: string,
  notes: string,
  completedDate: Date,
  customerPresent: boolean
): Promise<void> {
  const boardId = getBoardIds().deliveries
  
  const dateStr = completedDate.toISOString().split('T')[0]
  const hours = completedDate.getHours()
  const minutes = completedDate.getMinutes()
  
  // Add "Customer not present" prefix if applicable
  const finalNotes = customerPresent 
    ? notes 
    : `Customer not present\n\n${notes}`.trim()

  // Update multiple columns at once
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId, 
        item_id: $itemId, 
        column_values: $columnValues
      ) {
        id
      }
    }
  `

  const columnValues = {
    [DC_COLUMNS.completionNotes]: notes ? finalNotes : (customerPresent ? '' : 'Customer not present'),
    [DC_COLUMNS.completedAtDate]: { date: dateStr },
    [DC_COLUMNS.completedAtTime]: { hour: hours, minute: minutes },
    [DC_COLUMNS.status]: { label: 'All done!' },  // Note: exclamation mark to match Monday status label
  }

  await mondayQuery(mutation, { 
    boardId, 
    itemId, 
    columnValues: JSON.stringify(columnValues)
  })
}

// =============================================================================
// RESOURCES QUERIES
// =============================================================================

export interface ResourceRecord {
  id: string
  name: string
  files: FileAsset[]
}

/**
 * Get all resources marked for freelancer sharing
 * 
 * Fetches items from the Staff Training board where the 
 * "Share with freelancers" status is set.
 */
export async function getResourcesForFreelancers(): Promise<ResourceRecord[]> {
  const boardId = getBoardIds().resources

  console.log('Monday: Fetching resources from board', boardId)
  const startTime = Date.now()

  // Use items_page_by_column_values to filter on the server
  const query = `
    query {
      items_page_by_column_values (
        board_id: ${boardId},
        columns: [
          {
            column_id: "${RESOURCES_COLUMNS.shareWithFreelancers}",
            column_values: ["Share with freelancers"]
          }
        ],
        limit: 100
      ) {
        items {
          id
          name
          column_values(ids: ${JSON.stringify(RESOURCES_COLUMNS_TO_FETCH)}) {
            id
            text
            value
          }
        }
      }
    }
  `

  const result = await mondayQuery<{
    items_page_by_column_values: {
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
  }>(query)

  const queryTime = Date.now() - startTime
  const items = result.items_page_by_column_values?.items || []
  console.log('Monday: Resources query completed in', queryTime, 'ms, found', items.length, 'items')

  // Log raw file column data for ALL items (debugging Google Drive)
  items.forEach(item => {
    const filesCol = item.column_values.find(c => c.id === RESOURCES_COLUMNS.files)
    console.log(`Monday: Files for "${item.name}" (${item.id}):`, filesCol?.value)
  })

  // Transform to ResourceRecord format
  return items.map(item => {
    const columnMap = item.column_values.reduce((acc, col) => {
      acc[col.id] = { text: col.text, value: col.value }
      return acc
    }, {} as Record<string, { text: string; value: string }>)

    const files = extractFileAssets(columnMap[RESOURCES_COLUMNS.files]?.value)

    return {
      id: item.id,
      name: item.name,
      files,
    }
  })

  // =============================================================================
// ADD THIS FUNCTION TO THE END OF src/lib/monday.ts (before the final closing brace if any)
// =============================================================================

/**
 * Related job info for driver notes alerts
 */
export interface RelatedJobInfo {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  venue: string
}

/**
 * Find related upcoming jobs for driver notes alert
 * 
 * Finds jobs that share the same venue OR same HireHop reference,
 * with dates from today onwards, excluding the specified job.
 * 
 * @param excludeJobId - The job ID to exclude (the one just completed)
 * @param venueId - Venue ID to match (optional)
 * @param hhRef - HireHop reference to match (optional)
 * @returns Array of related upcoming jobs
 */
export async function getRelatedUpcomingJobs(
  excludeJobId: string,
  venueId?: string,
  hhRef?: string
): Promise<RelatedJobInfo[]> {
  // If we have neither venue nor hhRef, no point querying
  if (!venueId && !hhRef) {
    console.log('Monday: No venueId or hhRef provided, skipping related jobs query')
    return []
  }

  const boardId = getBoardIds().deliveries
  if (!boardId) {
    console.warn('MONDAY_BOARD_ID_DELIVERIES is not configured')
    return []
  }

  console.log(`Monday: Finding related jobs (venueId: ${venueId}, hhRef: ${hhRef}, excluding: ${excludeJobId})`)

  // Get today's date in YYYY-MM-DD format
  const today = new Date()
  const todayStr = today.toISOString().split('T')[0]

  // We need to query jobs and filter manually since Monday doesn't support OR queries well
  // Query jobs from today onwards (limit to recent/upcoming for performance)
  // Using items_page_by_column_values with date filter
  const query = `
    query {
      boards(ids: [${boardId}]) {
        items_page(
          limit: 200,
          query_params: {
            rules: [
              {
                column_id: "${DC_COLUMNS.date}",
                compare_value: ["${todayStr}"],
                operator: greater_than_or_equals
              }
            ]
          }
        ) {
          items {
            id
            name
            column_values(ids: ["${DC_COLUMNS.hhRef}", "${DC_COLUMNS.deliverCollect}", "${DC_COLUMNS.date}", "${DC_COLUMNS.venueConnect}", "${DC_COLUMNS.status}"]) {
              id
              text
              ... on BoardRelationValue {
                linked_item_ids
              }
            }
          }
        }
      }
    }
  `

  try {
    const result = await mondayQuery<{
      boards: Array<{
        items_page: {
          items: Array<{
            id: string
            name: string
            column_values: Array<{
              id: string
              text: string
              linked_item_ids?: string[]
            }>
          }>
        }
      }>
    }>(query)

    const items = result.boards?.[0]?.items_page?.items || []
    console.log(`Monday: Found ${items.length} jobs from ${todayStr} onwards`)

    // Filter to find related jobs
    const relatedJobs: RelatedJobInfo[] = []

    for (const item of items) {
      // Skip the excluded job
      if (item.id === excludeJobId) {
        continue
      }

      // Build column map
      const columnMap = item.column_values.reduce((acc, col) => {
        acc[col.id] = {
          text: col.text,
          linked_item_ids: col.linked_item_ids
        }
        return acc
      }, {} as Record<string, { text: string; linked_item_ids?: string[] }>)

      // Get job's venue ID and hhRef
      const jobVenueId = columnMap[DC_COLUMNS.venueConnect]?.linked_item_ids?.[0]
      const jobHhRef = columnMap[DC_COLUMNS.hhRef]?.text || ''
      const jobDate = columnMap[DC_COLUMNS.date]?.text || ''
      const jobVenueName = columnMap[DC_COLUMNS.venueConnect]?.text || item.name
      const jobStatus = columnMap[DC_COLUMNS.status]?.text?.toLowerCase() || ''

      // Skip completed or cancelled jobs
      if (jobStatus.includes('done') || jobStatus.includes('not needed') || jobStatus.includes('cancelled')) {
        continue
      }

      // Check if this job matches by venue OR hhRef
      const matchesByVenue = venueId && jobVenueId && jobVenueId === venueId
      const matchesByHhRef = hhRef && jobHhRef && jobHhRef === hhRef

      if (matchesByVenue || matchesByHhRef) {
        // Determine job type
        const deliverCollectText = columnMap[DC_COLUMNS.deliverCollect]?.text?.toLowerCase() || ''
        const jobType: 'delivery' | 'collection' = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

        relatedJobs.push({
          id: item.id,
          name: item.name,
          type: jobType,
          date: jobDate,
          venue: jobVenueName,
        })
      }
    }

    // Sort by date
    relatedJobs.sort((a, b) => {
      if (!a.date) return 1
      if (!b.date) return -1
      return a.date.localeCompare(b.date)
    })

    console.log(`Monday: Found ${relatedJobs.length} related upcoming jobs`)
    return relatedJobs

  } catch (error) {
    console.error('Monday: Error querying related jobs:', error)
    return []
  }
}
}