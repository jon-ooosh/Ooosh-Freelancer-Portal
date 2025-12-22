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
  venueConnect: 'connect_boards6',
  driverConnect: 'connect_boards3',
  driverEmailMirror: 'mirror1',            // Mirrored email from Freelance Crew
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
 */
export async function getJobsForFreelancer(freelancerEmail: string): Promise<JobRecord[]> {
  const boardId = getBoardIds().deliveries

  if (!boardId) {
    throw new Error('MONDAY_BOARD_ID_DELIVERIES is not configured')
  }

  // Fetch all items - we'll filter by email in code
  // In future, could optimize with Monday's query_params if needed
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
  const normalizedEmail = freelancerEmail.toLowerCase().trim()
  
  // Filter and transform items
  return items
    .filter(item => {
      // Check if this freelancer is assigned (via mirrored email column)
      const driverEmailCol = item.column_values.find(col => col.id === DC_COLUMNS.driverEmailMirror)
      const driverEmail = driverEmailCol?.text?.toLowerCase().trim()
      return driverEmail === normalizedEmail
    })
    .map(item => {
      const columnMap = item.column_values.reduce((acc, col) => {
        acc[col.id] = { text: col.text, value: col.value }
        return acc
      }, {} as Record<string, { text: string; value: string }>)

      // Determine job type from status
      const deliverCollectText = columnMap[DC_COLUMNS.deliverCollect]?.text?.toLowerCase() || ''
      const jobType = deliverCollectText.includes('delivery') ? 'delivery' : 'collection'

      // Parse agreed fee override
      const feeText = columnMap[DC_COLUMNS.agreedFeeOverride]?.text
      const agreedFeeOverride = feeText ? parseFloat(feeText) : undefined

      return {
        id: item.id,
        name: item.name,
        hhRef: columnMap[DC_COLUMNS.hhRef]?.text,
        type: jobType,
        date: columnMap[DC_COLUMNS.date]?.text,
        time: columnMap[DC_COLUMNS.timeToArrive]?.text,
        venueName: columnMap[DC_COLUMNS.venueConnect]?.text,
        status: columnMap[DC_COLUMNS.status]?.text || 'unknown',
        runGroup: columnMap[DC_COLUMNS.runGroup]?.text,
        agreedFeeOverride,
        driverEmail: columnMap[DC_COLUMNS.driverEmailMirror]?.text,
        keyNotes: columnMap[DC_COLUMNS.keyPoints]?.text,
        completedAtDate: columnMap[DC_COLUMNS.completedAtDate]?.text,
        completedAtTime: columnMap[DC_COLUMNS.completedAtTime]?.text,
        completionNotes: columnMap[DC_COLUMNS.completionNotes]?.text,
      }
    })
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
