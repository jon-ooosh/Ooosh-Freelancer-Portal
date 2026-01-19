/**
 * Monday.com API Client
 * 
 * All Monday.com API interactions go through this module.
 * The API token is kept server-side only - never exposed to the browser.
 * 
 * Column IDs are specific to the Ooosh Monday.com boards.
 */

const MONDAY_API_URL = 'https://api.monday.com/v2'

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
} as const

// Deliveries & Collections board columns
export const DC_COLUMNS = {
  hhRef: 'text2',
  deliverCollect: 'status_1',              // "Delivery" or "Collection"
  date: 'date4',
  timeToArrive: 'hour',
  venueConnect: 'connect_boards6',         // Connect column linking to Address Book
  driverConnect: 'connect_boards3',
  driverEmailMirror: 'driver_email__gc_',  // Text column populated by General Caster from mirror
  status: 'status90',
  keyPoints: 'key_points___summary',
  runGroup: 'color_mkxvwn11',              // Status: A, B, C, D, E
  agreedFeeOverride: 'numeric_mky3z4gm',
  completionNotes: 'long_text_mkyweafm',
  completionPhotos: 'file_mkyww89n',
  signature: 'file_mkywf297',
  completedAtDate: 'date_mkywpv0h',
  completedAtTime: 'hour_mkywgx0x',
  extraCharges: 'numeric_mkyws6s',
  extraChargesReason: 'long_text_mkywkth4',
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

// List of column IDs we need to fetch for jobs
// This dramatically reduces response size and speeds up queries
const DC_COLUMNS_TO_FETCH = [
  DC_COLUMNS.hhRef,
  DC_COLUMNS.deliverCollect,
  DC_COLUMNS.date,
  DC_COLUMNS.timeToArrive,
  DC_COLUMNS.venueConnect,        // Need this to get linked venue ID
  DC_COLUMNS.driverEmailMirror,
  DC_COLUMNS.status,
  DC_COLUMNS.keyPoints,
  DC_COLUMNS.runGroup,
  DC_COLUMNS.agreedFeeOverride,
  DC_COLUMNS.completedAtDate,
  DC_COLUMNS.completionNotes,
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
  VENUE_COLUMNS.files,            // Include files column
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
      'API-Version': '2024-01',
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
  }
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
// FILE/ASSET QUERIES
// =============================================================================

export interface FileAsset {
  assetId: string
  name: string
}

export interface FileAssetWithUrl extends FileAsset {
  publicUrl: string
}

/**
 * Extract asset IDs from a Monday.com file column value
 * File columns store JSON like: {"files":[{"assetId":123456789,"name":"file.pdf"}]}
 */
export function extractFileAssets(fileColumnValue: string | undefined): FileAsset[] {
  if (!fileColumnValue) return []
  
  try {
    const parsed = typeof fileColumnValue === 'string' 
      ? JSON.parse(fileColumnValue) 
      : fileColumnValue
    
    if (!parsed.files || !Array.isArray(parsed.files)) {
      return []
    }
    
    return parsed.files
      .filter((f: any) => f.assetId)
      .map((f: any) => ({
        assetId: String(f.assetId),
        name: f.name || 'Unknown file'
      }))
  } catch (e) {
    console.error('Failed to parse file column value:', e)
    return []
  }
}

/**
 * Get public URL for a Monday.com asset
 * The public_url is a temporary signed S3 URL (expires in ~minutes)
 * so fetch immediately after getting it.
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
  
  try {
    const result = await mondayQuery<{
      assets: Array<{
        id: string
        name: string
        public_url: string
      }>
    }>(query, { assetIds: [assetId] })
    
    const asset = result.assets?.[0]
    
    if (!asset || !asset.public_url) {
      console.log('Monday: Asset not found or no public URL:', assetId)
      return null
    }
    
    return {
      assetId: asset.id,
      name: asset.name,
      publicUrl: asset.public_url
    }
  } catch (error) {
    console.error('Monday: Failed to get asset public URL:', error)
    return null
  }
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
  files?: FileAsset[]           // Array of file assets
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

  // Extract file assets from the files column
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
    files: files.length > 0 ? files : undefined,
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
  date?: string
  time?: string
  venueName?: string
  venueId?: string              // ID of linked venue for fetching details
  status: string
  runGroup?: string
  agreedFeeOverride?: number
  driverEmail?: string
  keyNotes?: string
  completedAtDate?: string
  completedAtTime?: string
  completionNotes?: string
}

/**
 * Get all jobs for a specific freelancer (by email)
 * 
 * OPTIMIZED: Only fetches the columns we need, not all 80+ columns
 */
export async function getJobsForFreelancer(freelancerEmail: string): Promise<JobRecord[]> {
  const boardId = getBoardIds().deliveries

  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_DELIVERIES is not configured')
  }

  console.log('Monday: Fetching jobs for', freelancerEmail, 'from board', boardId)
  const startTime = Date.now()

  // OPTIMIZED: Only request specific columns we need
  // This dramatically reduces response size and query time
  const query = `
    query ($boardId: [ID!]!, $columnIds: [String!]) {
      boards(ids: $boardId) {
        items_page(limit: 500) {
          items {
            id
            name
            column_values(ids: $columnIds) {
              id
              text
              value
              ... on MirrorValue {
                display_value
              }
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
          column_values: Array<{
            id: string
            text: string
            value: string
            display_value?: string
          }>
        }>
      }
    }>
  }>(query, { 
    boardId: [boardId],
    columnIds: DC_COLUMNS_TO_FETCH
  })

  const queryTime = Date.now() - startTime
  console.log('Monday: Query completed in', queryTime, 'ms')
  
  const items = result.boards[0]?.items_page?.items || []
  console.log('Monday: Retrieved', items.length, 'total items')
  
  const normalizedEmail = freelancerEmail.toLowerCase().trim()
  
  // Filter items where this freelancer is assigned
  const matchingItems = items.filter(item => {
    const driverEmailCol = item.column_values.find(col => col.id === DC_COLUMNS.driverEmailMirror)
    const driverEmail = (driverEmailCol?.display_value || driverEmailCol?.text || '').toLowerCase().trim()
    return driverEmail === normalizedEmail
  })

  console.log('Monday: Found', matchingItems.length, 'jobs assigned to', freelancerEmail)

  // Transform matching items to JobRecord format
  return matchingItems.map(item => {
    const columnMap = item.column_values.reduce((acc, col) => {
      acc[col.id] = { 
        text: col.text, 
        value: col.value,
        display_value: col.display_value 
      }
      return acc
    }, {} as Record<string, { text: string; value: string; display_value?: string }>)

    const getColText = (colId: string) => {
      const col = columnMap[colId]
      return col?.display_value || col?.text || ''
    }

    // Determine job type from status
    const deliverCollectText = getColText(DC_COLUMNS.deliverCollect).toLowerCase()
    const jobType = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

    // Parse agreed fee override
    const feeText = getColText(DC_COLUMNS.agreedFeeOverride)
    const agreedFeeOverride = feeText ? parseFloat(feeText) : undefined

    // Extract venue ID from connect column
    // Connect columns store linked item IDs in the value as JSON
    let venueId: string | undefined
    const venueConnectValue = columnMap[DC_COLUMNS.venueConnect]?.value
    if (venueConnectValue) {
      try {
        const parsed = JSON.parse(venueConnectValue)
        // Connect column value is like: {"linkedPulseIds":[{"linkedPulseId":123456}]}
        venueId = parsed?.linkedPulseIds?.[0]?.linkedPulseId?.toString()
      } catch {
        // If parsing fails, ignore
      }
    }

    return {
      id: item.id,
      name: item.name,
      hhRef: getColText(DC_COLUMNS.hhRef),
      type: jobType,
      date: getColText(DC_COLUMNS.date),
      time: getColText(DC_COLUMNS.timeToArrive),
      venueName: getColText(DC_COLUMNS.venueConnect),
      venueId,
      status: getColText(DC_COLUMNS.status) || 'unknown',
      runGroup: getColText(DC_COLUMNS.runGroup),
      agreedFeeOverride,
      driverEmail: getColText(DC_COLUMNS.driverEmailMirror),
      keyNotes: getColText(DC_COLUMNS.keyPoints),
      completedAtDate: getColText(DC_COLUMNS.completedAtDate),
      completionNotes: getColText(DC_COLUMNS.completionNotes),
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
      display_value: col.display_value 
    }
    return acc
  }, {} as Record<string, { text: string; value: string; display_value?: string }>)

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

  // Parse agreed fee
  const feeText = getColText(DC_COLUMNS.agreedFeeOverride)
  const agreedFeeOverride = feeText ? parseFloat(feeText) : undefined

  // Extract venue ID from connect column
  let venueId: string | undefined
  const venueConnectValue = columnMap[DC_COLUMNS.venueConnect]?.value
  if (venueConnectValue) {
    try {
      const parsed = JSON.parse(venueConnectValue)
      venueId = parsed?.linkedPulseIds?.[0]?.linkedPulseId?.toString()
    } catch {
      // If parsing fails, ignore
    }
  }

  return {
    id: item.id,
    name: item.name,
    hhRef: getColText(DC_COLUMNS.hhRef),
    type: jobType,
    date: getColText(DC_COLUMNS.date),
    time: getColText(DC_COLUMNS.timeToArrive),
    venueName: getColText(DC_COLUMNS.venueConnect),
    venueId,
    status: getColText(DC_COLUMNS.status) || 'unknown',
    runGroup: getColText(DC_COLUMNS.runGroup),
    agreedFeeOverride,
    driverEmail: driverEmail,
    keyNotes: getColText(DC_COLUMNS.keyPoints),
    completedAtDate: getColText(DC_COLUMNS.completedAtDate),
    completionNotes: getColText(DC_COLUMNS.completionNotes),
  }
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
 * Update job completion fields
 */
export async function updateJobCompletion(
  itemId: string,
  notes: string,
  completedDate: Date
): Promise<void> {
  const boardId = getBoardIds().deliveries
  
  const dateStr = completedDate.toISOString().split('T')[0]
  const timeStr = completedDate.toTimeString().slice(0, 5) // HH:MM format

  // Update multiple columns
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
    [DC_COLUMNS.completionNotes]: notes,
    [DC_COLUMNS.completedAtDate]: { date: dateStr },
    [DC_COLUMNS.completedAtTime]: { hour: parseInt(timeStr.split(':')[0]), minute: parseInt(timeStr.split(':')[1]) },
  }

  await mondayQuery(mutation, { 
    boardId, 
    itemId, 
    columnValues: JSON.stringify(columnValues)
  })
}
