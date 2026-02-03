/**
 * Crew & Transport API
 * 
 * POST /api/staff/crew-transport - Create new item
 * GET /api/staff/crew-transport?jobNumber=X - Fetch job info from Q&H board
 * GET /api/staff/crew-transport?itemId=X - Fetch existing crew job item
 * 
 * ROUTING LOGIC:
 * - Delivery or Collection → D&C Board (2028045828)
 * - Crewed Job → Crewed Jobs Board (18398014629)
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'

// Board IDs
const CREW_JOBS_BOARD_ID = process.env.MONDAY_BOARD_ID_CREW_JOBS || '18398014629'
const DC_BOARD_ID = process.env.MONDAY_BOARD_ID_DELIVERIES || '2028045828'
const QH_BOARD_ID = '2431480012'
const VENUES_BOARD_ID = process.env.MONDAY_BOARD_ID_VENUES || '2406443142'

// =============================================================================
// COLUMN IDS - CREWED JOBS BOARD
// =============================================================================
const CREW_COLUMNS = {
  name: 'name',
  hirehopJobNumber: 'numeric_mm06wbtm',
  jobType: 'color_mm062e1x',
  status: 'color_mm06zxg3',
  transportMode: 'color_mm06w09w',
  destination: 'text_mm065ytz',
  distanceMiles: 'numeric_mm06sxeb',
  driveTimeMinutes: 'numeric_mm06d4d0',
  returnMethod: 'color_mm068sv5',
  returnTravelTimeMins: 'numeric_mm061zfs',
  returnTravelCost: 'numeric_mm069v0b',
  workType: 'color_mm063qgs',
  workTypeOther: 'text_mm06542v',
  workDurationHours: 'numeric_mm06qxty',
  workDescription: 'text_mm06f0bj',
  jobDate: 'date_mm067tnh',
  arrivalTime: 'hour_mm06y636',
  calculationMode: 'color_mm06r0np',
  numberOfDays: 'numeric_mm063z0y',
  earlyStartMinutes: 'numeric_mm069427',
  lateFinishMinutes: 'numeric_mm06emw1',
  clientChargeTotal: 'numeric_mm065r44',
  freelancerFee: 'numeric_mm06fx2z',
  expectedExpenses: 'numeric_mm06xg0n',
  ourMargin: 'numeric_mm06nv96',
  expenseArrangement: 'color_mm06em94',
  pdArrangement: 'color_mm06v3fg',
  pdAmount: 'numeric_mm06f93p',
  expenseNotes: 'text_mm06hyba',
  actualFeeClaimed: 'numeric_mm06hkkn',
  actualExpensesClaimed: 'numeric_mm06q1nr',
}

// =============================================================================
// COLUMN IDS - D&C BOARD (Deliveries & Collections)
// =============================================================================
const DC_COLUMNS = {
  name: 'name',
  hirehopJobNumber: 'text2',           // HireHop job number
  deliverCollect: 'status_1',          // Delivery / Collection status
  whatIsIt: 'status4',                 // A vehicle / Equipment / People
  date: 'date4',                       // Job date
  arriveAt: 'hour',                    // Arrival time
  status: 'status90',                  // Job status (TO DO!, Arranging, etc.)
  keyPoints: 'key_points___summary',   // Key points / Flight # etc
  clientCharge: 'numeric_mm06wq2n',    // Client charge (what we bill)
  driverFee: 'numeric_mm0688f9',       // Driver fee (what we pay)
}

// =============================================================================
// COLUMN IDS - VENUES BOARD
// =============================================================================
const VENUE_COLUMNS = {
  name: 'text43',
  distance: 'numeric_mm07y9eq',
  driveTime: 'numeric_mm074a1k',
}

// =============================================================================
// LABEL MAPPINGS - Must match Monday.com exactly
// =============================================================================

// D&C Board labels
const DC_DELIVER_COLLECT_LABELS: Record<string, string> = {
  'delivery': 'Delivery',
  'collection': 'Collection',
}

const DC_WHAT_IS_IT_LABELS: Record<string, string> = {
  'vehicle': 'A vehicle',      // FIXED: lowercase 'v'
  'equipment': 'Equipment',
  'people': 'People',
}

const DC_STATUS_DEFAULT = 'TO DO!'

// Crewed Jobs Board labels
const CREW_JOB_TYPE_LABELS: Record<string, string> = {
  'crewed_job': 'Transport + Crew',
  'crew_only': 'Crew Only',
}

const TRANSPORT_MODE_LABELS: Record<string, string> = {
  'there_and_back': 'There and back',
  'one_way': 'One-way',
  'na': 'N/A',
}

const TRAVEL_METHOD_LABELS: Record<string, string> = {
  'public_transport': 'Public transport',
  'own_way': 'Own way back',
  'na': 'N/A',
}

const WORK_TYPE_LABELS: Record<string, string> = {
  'backline_tech': 'Backline Tech',
  'general_assist': 'General Assist',
  'load_in': 'Load-in',
  'load_out': 'Load-out',
  'set_up': 'Set-up',
  'pack_down': 'Pack-down',
  'engineer_foh': 'Engineer - FOH',
  'engineer_mons': 'Engineer - mons',
  'driving_only': 'Driving Only',
  'other': 'Other',
}

const CALC_MODE_LABELS: Record<string, string> = {
  'hourly': 'Hourly',
  'day_rate': 'Day Rate',
}

// FIXED: These labels now match Monday.com exactly
const EXPENSE_ARRANGEMENT_LABELS: Record<string, string> = {
  'all_in_fixed': 'Fixed fee all-in',           // FIXED: was 'All-in fixed'
  'fee_plus_reimbursed': 'Fee + expenses reimbursed',  // FIXED: was 'Fee + reimbursed'
  'dry_hire_actuals': 'Dry hire + actuals',
}

const PD_ARRANGEMENT_LABELS: Record<string, string> = {
  'no_pd': 'No PD',
  'we_pay': 'We pay',
  'client_pays_direct': 'Client pays direct',
  'in_fee': 'In fee',
}

// =============================================================================
// TYPES
// =============================================================================

interface FormData {
  hirehopJobNumber: string
  clientName: string
  jobType: string
  whatIsIt: string
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  travelMethod: string
  travelTimeMins: number
  travelCost: number
  workType: string
  workTypeOther: string
  workDurationHours: number
  workDescription: string
  jobDate: string
  arrivalTime: string
  collectionDate: string
  collectionArrivalTime: string
  calculationMode: string
  numberOfDays: number
  earlyStartMinutes: number
  lateFinishMinutes: number
  tollsParking: number
  additionalCosts: number
  expenseArrangement: string
  pdArrangement: string
  pdAmount: number
  expenseNotes: string
  costingNotes: string
  addCollection: boolean
  // Venue tracking
  selectedVenueId: string | null
  isNewVenue: boolean
  venueDistanceChanged: boolean
  venueDriveTimeChanged: boolean
}

interface Costs {
  clientChargeTotal: number
  freelancerFee: number
  expectedFuelCost: number
  expectedOtherExpenses: number
  ourMargin: number
}

// =============================================================================
// MONDAY API HELPER
// =============================================================================

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

// =============================================================================
// VENUE HELPERS
// =============================================================================

async function createVenue(name: string, distance: number, driveTime: number): Promise<string> {
  console.log('Creating new venue:', name)
  
  const columnValues: Record<string, unknown> = {
    [VENUE_COLUMNS.name]: name,
  }
  
  if (distance > 0) {
    columnValues[VENUE_COLUMNS.distance] = distance
  }
  if (driveTime > 0) {
    columnValues[VENUE_COLUMNS.driveTime] = driveTime
  }

  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `

  const result = await mondayQuery<{
    create_item: { id: string; name: string }
  }>(mutation, {
    boardId: VENUES_BOARD_ID,
    itemName: name,
    columnValues: JSON.stringify(columnValues),
  })

  console.log('Created venue:', result.create_item.id, '-', result.create_item.name)
  return result.create_item.id
}

async function updateVenue(venueId: string, distance: number | null, driveTime: number | null): Promise<void> {
  console.log('Updating venue:', venueId, '- Distance:', distance, 'Drive Time:', driveTime)
  
  const columnValues: Record<string, unknown> = {}
  
  if (distance !== null) {
    columnValues[VENUE_COLUMNS.distance] = distance
  }
  if (driveTime !== null) {
    columnValues[VENUE_COLUMNS.driveTime] = driveTime
  }

  if (Object.keys(columnValues).length === 0) {
    console.log('No venue changes to update')
    return
  }

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId
        item_id: $itemId
        column_values: $columnValues
      ) {
        id
      }
    }
  `

  await mondayQuery<{ change_multiple_column_values: { id: string } }>(mutation, {
    boardId: VENUES_BOARD_ID,
    itemId: venueId,
    columnValues: JSON.stringify(columnValues),
  })

  console.log('Updated venue:', venueId)
}

// =============================================================================
// CREATE D&C ITEM (Delivery or Collection)
// =============================================================================

async function createDCItem(
  formData: FormData,
  costs: Costs,
  itemType: 'delivery' | 'collection',
  jobDate: string,
  arrivalTime: string
): Promise<{ id: string; name: string }> {
  
  // Build item name: "DEL: ClientName - Destination" or "COL: ClientName - Destination"
  const prefix = itemType === 'delivery' ? 'DEL' : 'COL'
  const clientPart = formData.clientName || `Job ${formData.hirehopJobNumber}`
  const destPart = formData.destination || 'TBC'
  const itemName = `${prefix}: ${clientPart} - ${destPart}`

  // Build column values
  const columnValues: Record<string, unknown> = {}

  // HireHop job number (text column)
  if (formData.hirehopJobNumber) {
    columnValues[DC_COLUMNS.hirehopJobNumber] = formData.hirehopJobNumber
  }

  // Delivery or Collection status
  columnValues[DC_COLUMNS.deliverCollect] = { 
    label: DC_DELIVER_COLLECT_LABELS[itemType] 
  }

  // What is it? (A vehicle / Equipment / People) - FIXED: lowercase 'v'
  if (formData.whatIsIt && DC_WHAT_IS_IT_LABELS[formData.whatIsIt]) {
    columnValues[DC_COLUMNS.whatIsIt] = { 
      label: DC_WHAT_IS_IT_LABELS[formData.whatIsIt] 
    }
  }

  // Job date
  if (jobDate) {
    columnValues[DC_COLUMNS.date] = { date: jobDate }
  }

  // Arrival time (hour column format)
  if (arrivalTime) {
    const [hours, minutes] = arrivalTime.split(':').map(Number)
    columnValues[DC_COLUMNS.arriveAt] = { hour: hours, minute: minutes }
  }

  // Status - default to "TO DO!"
  columnValues[DC_COLUMNS.status] = { label: DC_STATUS_DEFAULT }

  // Key points / notes - combine destination and any notes
  const keyPointsParts = []
  if (formData.destination) keyPointsParts.push(`📍 ${formData.destination}`)
  if (formData.expenseNotes) keyPointsParts.push(formData.expenseNotes)
  if (formData.costingNotes) keyPointsParts.push(`Notes: ${formData.costingNotes}`)
  if (keyPointsParts.length > 0) {
    columnValues[DC_COLUMNS.keyPoints] = keyPointsParts.join('\n')
  }

  // Financial columns
  columnValues[DC_COLUMNS.clientCharge] = costs.clientChargeTotal
  columnValues[DC_COLUMNS.driverFee] = costs.freelancerFee

  console.log('D&C: Creating item:', itemName)
  console.log('D&C: Column values:', JSON.stringify(columnValues, null, 2))

  // Create item mutation
  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `

  const result = await mondayQuery<{
    create_item: { id: string; name: string }
  }>(mutation, {
    boardId: DC_BOARD_ID,
    itemName,
    columnValues: JSON.stringify(columnValues),
  })

  console.log('D&C: Created item', result.create_item.id, '-', result.create_item.name)
  return result.create_item
}

// =============================================================================
// CREATE CREWED JOB ITEM
// =============================================================================

async function createCrewedJobItem(
  formData: FormData,
  costs: Costs
): Promise<{ id: string; name: string }> {
  
  // Determine the job type label based on transport
  const hasTransport = formData.distanceMiles > 0
  const mondayJobType = hasTransport ? 'Transport + Crew' : 'Crew Only'

  // Build item name
  const itemName = formData.hirehopJobNumber 
    ? `Job ${formData.hirehopJobNumber} - Crewed Job - ${formData.destination || 'TBC'}`
    : `Crewed Job - ${formData.destination || 'New Job'}`

  // Calculate total expected expenses
  const totalExpectedExpenses = costs.expectedFuelCost + costs.expectedOtherExpenses

  // Build column values object
  const columnValues: Record<string, unknown> = {}
  
  // Text columns
  if (formData.destination) columnValues[CREW_COLUMNS.destination] = formData.destination
  if (formData.workDescription) columnValues[CREW_COLUMNS.workDescription] = formData.workDescription
  if (formData.workType === 'other' && formData.workTypeOther) {
    columnValues[CREW_COLUMNS.workTypeOther] = formData.workTypeOther
  }
  
  // Combine notes
  const combinedNotes = [formData.expenseNotes, formData.costingNotes ? `Notes: ${formData.costingNotes}` : '']
    .filter(Boolean).join('\n\n')
  if (combinedNotes) columnValues[CREW_COLUMNS.expenseNotes] = combinedNotes
  
  // Numeric columns
  if (formData.hirehopJobNumber) columnValues[CREW_COLUMNS.hirehopJobNumber] = parseInt(formData.hirehopJobNumber)
  if (formData.distanceMiles > 0) columnValues[CREW_COLUMNS.distanceMiles] = formData.distanceMiles
  if (formData.driveTimeMinutes > 0) columnValues[CREW_COLUMNS.driveTimeMinutes] = formData.driveTimeMinutes
  if (formData.travelTimeMins > 0) columnValues[CREW_COLUMNS.returnTravelTimeMins] = formData.travelTimeMins
  if (formData.travelCost > 0) columnValues[CREW_COLUMNS.returnTravelCost] = formData.travelCost
  if (formData.workDurationHours > 0) columnValues[CREW_COLUMNS.workDurationHours] = formData.workDurationHours
  if (formData.numberOfDays > 0) columnValues[CREW_COLUMNS.numberOfDays] = formData.numberOfDays
  if (formData.earlyStartMinutes > 0) columnValues[CREW_COLUMNS.earlyStartMinutes] = formData.earlyStartMinutes
  if (formData.lateFinishMinutes > 0) columnValues[CREW_COLUMNS.lateFinishMinutes] = formData.lateFinishMinutes
  if (formData.pdAmount > 0) columnValues[CREW_COLUMNS.pdAmount] = formData.pdAmount
  
  // Financial columns
  columnValues[CREW_COLUMNS.clientChargeTotal] = costs.clientChargeTotal
  columnValues[CREW_COLUMNS.freelancerFee] = costs.freelancerFee
  columnValues[CREW_COLUMNS.expectedExpenses] = totalExpectedExpenses
  columnValues[CREW_COLUMNS.ourMargin] = costs.ourMargin
  
  // Date column
  if (formData.jobDate) columnValues[CREW_COLUMNS.jobDate] = { date: formData.jobDate }

  // Arrival time (hour column)
  if (formData.arrivalTime) {
    const [hours, minutes] = formData.arrivalTime.split(':').map(Number)
    columnValues[CREW_COLUMNS.arrivalTime] = { hour: hours, minute: minutes }
  }
  
  // Status columns
  columnValues[CREW_COLUMNS.jobType] = { label: mondayJobType }
  columnValues[CREW_COLUMNS.status] = { label: 'TBC' }
  
  // Transport mode - determine from context
  if (hasTransport) {
    columnValues[CREW_COLUMNS.transportMode] = { label: 'There and back' }
  } else {
    columnValues[CREW_COLUMNS.transportMode] = { label: 'N/A' }
  }

  if (formData.travelMethod && TRAVEL_METHOD_LABELS[formData.travelMethod]) {
    columnValues[CREW_COLUMNS.returnMethod] = { label: TRAVEL_METHOD_LABELS[formData.travelMethod] }
  }
  if (formData.workType && WORK_TYPE_LABELS[formData.workType]) {
    columnValues[CREW_COLUMNS.workType] = { label: WORK_TYPE_LABELS[formData.workType] }
  }
  if (formData.calculationMode && CALC_MODE_LABELS[formData.calculationMode]) {
    columnValues[CREW_COLUMNS.calculationMode] = { label: CALC_MODE_LABELS[formData.calculationMode] }
  }
  // FIXED: Expense arrangement labels now match Monday.com exactly
  if (formData.expenseArrangement && EXPENSE_ARRANGEMENT_LABELS[formData.expenseArrangement]) {
    columnValues[CREW_COLUMNS.expenseArrangement] = { label: EXPENSE_ARRANGEMENT_LABELS[formData.expenseArrangement] }
  }
  if (formData.pdArrangement && PD_ARRANGEMENT_LABELS[formData.pdArrangement]) {
    columnValues[CREW_COLUMNS.pdArrangement] = { label: PD_ARRANGEMENT_LABELS[formData.pdArrangement] }
  }

  console.log('Crewed Job: Creating item:', itemName)
  console.log('Crewed Job: Column values:', JSON.stringify(columnValues, null, 2))

  // Create item mutation
  const mutation = `
    mutation ($boardId: ID!, $itemName: String!, $columnValues: JSON!) {
      create_item(
        board_id: $boardId
        item_name: $itemName
        column_values: $columnValues
      ) {
        id
        name
      }
    }
  `

  const result = await mondayQuery<{
    create_item: { id: string; name: string }
  }>(mutation, {
    boardId: CREW_JOBS_BOARD_ID,
    itemName,
    columnValues: JSON.stringify(columnValues),
  })

  console.log('Crewed Job: Created item', result.create_item.id)
  return result.create_item
}

// =============================================================================
// POST HANDLER - Create new item(s)
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

    const { formData, costs } = await request.json() as { formData: FormData; costs: Costs }

    console.log('='.repeat(60))
    console.log('Crew & Transport: Processing', formData.jobType, 'for job', formData.hirehopJobNumber)
    console.log('='.repeat(60))

    // =========================================================================
    // HANDLE VENUE CREATION/UPDATE
    // =========================================================================
    if (formData.destination) {
      if (formData.isNewVenue) {
        // Create new venue
        console.log('Creating new venue:', formData.destination)
        await createVenue(
          formData.destination,
          formData.distanceMiles,
          formData.driveTimeMinutes
        )
      } else if (formData.selectedVenueId && (formData.venueDistanceChanged || formData.venueDriveTimeChanged)) {
        // Update existing venue if values changed
        console.log('Updating venue:', formData.selectedVenueId)
        await updateVenue(
          formData.selectedVenueId,
          formData.venueDistanceChanged ? formData.distanceMiles : null,
          formData.venueDriveTimeChanged ? formData.driveTimeMinutes : null
        )
      }
    }

    // Route to appropriate board based on job type
    if (formData.jobType === 'crewed_job') {
      // =========================================================================
      // CREWED JOB → Crewed Jobs Board
      // =========================================================================
      const result = await createCrewedJobItem(formData, costs)

      return NextResponse.json({
        success: true,
        itemId: result.id,
        itemName: result.name,
        board: 'crewed_jobs',
      })

    } else if (formData.jobType === 'delivery' || formData.jobType === 'collection') {
      // =========================================================================
      // DELIVERY or COLLECTION → D&C Board
      // =========================================================================
      
      // Create the primary item
      const primaryResult = await createDCItem(
        formData, 
        costs, 
        formData.jobType as 'delivery' | 'collection',
        formData.jobDate,
        formData.arrivalTime
      )

      let collectionResult = null

      // If "Add collection from same location" is checked, create a second item
      if (formData.jobType === 'delivery' && formData.addCollection && formData.collectionDate) {
        console.log('D&C: Also creating collection for', formData.collectionDate)
        collectionResult = await createDCItem(
          formData,
          costs,
          'collection',
          formData.collectionDate,
          formData.collectionArrivalTime || ''
        )
      }

      return NextResponse.json({
        success: true,
        itemId: primaryResult.id,
        itemName: primaryResult.name,
        board: 'dc',
        ...(collectionResult && {
          collectionItemId: collectionResult.id,
          collectionItemName: collectionResult.name,
        }),
      })

    } else {
      return NextResponse.json(
        { success: false, error: 'Invalid job type' },
        { status: 400 }
      )
    }

  } catch (error) {
    console.error('Crew Transport API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save' },
      { status: 500 }
    )
  }
}

// =============================================================================
// GET HANDLER - Fetch job info from Q&H board
// =============================================================================

export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url)
    const jobNumber = searchParams.get('jobNumber')
    const itemId = searchParams.get('itemId')

    // If itemId provided, fetch existing crew job item
    if (itemId) {
      const query = `
        query ($itemIds: [ID!]!) {
          items(ids: $itemIds) {
            id
            name
            column_values {
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
      }>(query, { itemIds: [itemId] })

      if (!result.items || result.items.length === 0) {
        return NextResponse.json(
          { success: false, error: 'Item not found' },
          { status: 404 }
        )
      }

      return NextResponse.json({
        success: true,
        item: result.items[0],
      })
    }

    // If jobNumber provided, fetch from Q&H board
    if (jobNumber) {
      console.log('Crew Transport: Looking up job', jobNumber, 'in Q&H board')
      
      const query = `
        query ($boardId: ID!, $columnId: String!, $value: String!) {
          items_page_by_column_values(
            board_id: $boardId
            limit: 1
            columns: [{ column_id: $columnId, column_values: [$value] }]
          ) {
            items {
              id
              name
              column_values(ids: ["date", "dup__of_hire_starts", "text6"]) {
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
      }>(query, { 
        boardId: QH_BOARD_ID, 
        columnId: 'text7',
        value: jobNumber 
      })

      const items = result.items_page_by_column_values?.items || []
      
      if (items.length === 0) {
        console.log('Crew Transport: Job not found in Q&H board')
        return NextResponse.json({
          success: true,
          jobInfo: null,
          message: 'Job not found in Q&H board'
        })
      }

      const item = items[0]
      const columns = item.column_values.reduce((acc, col) => {
        acc[col.id] = col.text
        return acc
      }, {} as Record<string, string>)

      console.log('Crew Transport: Found job:', item.name, 'Client:', columns['text6'])

      return NextResponse.json({
        success: true,
        jobInfo: {
          id: item.id,
          name: item.name,
          clientName: columns['text6'] || '',
          hireStartDate: columns['date'] || '',
          hireEndDate: columns['dup__of_hire_starts'] || '',
        }
      })
    }

    return NextResponse.json(
      { success: false, error: 'Either jobNumber or itemId required' },
      { status: 400 }
    )

  } catch (error) {
    console.error('Crew Transport GET error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch' },
      { status: 500 }
    )
  }
}