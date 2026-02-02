/**
 * Crew & Transport API
 * 
 * POST /api/staff/crew-transport
 * 
 * Creates or updates a Crewed Jobs item in Monday.com
 * with the calculated costs from the wizard.
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const CREW_JOBS_BOARD_ID = process.env.MONDAY_BOARD_ID_CREW_JOBS || '18398014629'

// Column IDs for Crewed Jobs board
const COLUMNS = {
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
  workDurationHours: 'numeric_mm06qxty',
  workDescription: 'text_mm06f0bj',
  jobDate: 'date_mm067tnh',
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

// Map form values to Monday status labels
const JOB_TYPE_LABELS: Record<string, string> = {
  'delivery': 'Delivery',
  'collection': 'Collection',
  'crewed_job': 'Crewed Job',
}

const TRANSPORT_MODE_LABELS: Record<string, string> = {
  'one_way': 'One-way',
  'there_and_back': 'There and back',
  'na': 'N/A',
}

const RETURN_METHOD_LABELS: Record<string, string> = {
  'same_vehicle': 'Same vehicle',
  'public_transport': 'Public transport',
  'stays_overnight': 'Stays overnight',
  'na': 'N/A',
}

const WORK_TYPE_LABELS: Record<string, string> = {
  'backline_tech': 'Backline Tech',
  'general_assist': 'General Assist',
  'load_in_out': 'Load-in/out',
  'driving_only': 'Driving Only',
  'other': 'Other',
}

const CALC_MODE_LABELS: Record<string, string> = {
  'hourly': 'Hourly',
  'day_rate': 'Day Rate',
}

const EXPENSE_ARRANGEMENT_LABELS: Record<string, string> = {
  'all_in_fixed': 'All-in fixed',
  'fee_plus_reimbursed': 'Fee + reimbursed',
  'dry_hire_actuals': 'Dry hire + actuals',
}

const PD_ARRANGEMENT_LABELS: Record<string, string> = {
  'no_pd': 'No PD',
  'we_pay': 'We pay',
  'client_pays_direct': 'Client pays direct',
  'in_fee': 'In fee',
}

interface FormData {
  hirehopJobNumber: string
  jobType: string
  transportMode: string
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  returnMethod: string
  returnTravelTimeMins: number
  returnTravelCost: number
  workType: string
  workDurationHours: number
  workDescription: string
  jobDate: string
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
  collectionDate: string
}

interface Costs {
  clientChargeTotal: number
  freelancerFee: number
  expectedFuelCost: number
  expectedOtherExpenses: number
  ourMargin: number
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

    console.log('Crew Transport: Creating item for job', formData.hirehopJobNumber)

    // Build item name
    const jobTypeLabel = JOB_TYPE_LABELS[formData.jobType] || 'Job'
    const itemName = formData.hirehopJobNumber 
      ? `Job ${formData.hirehopJobNumber} - ${jobTypeLabel} - ${formData.destination || 'TBC'}`
      : `${jobTypeLabel} - ${formData.destination || 'New Job'}`

    // Calculate total expected expenses
    const totalExpectedExpenses = costs.expectedFuelCost + costs.expectedOtherExpenses

    // Build column values object
    const columnValues: Record<string, unknown> = {
      // Text columns
      [COLUMNS.destination]: formData.destination,
      [COLUMNS.workDescription]: formData.workDescription,
      [COLUMNS.expenseNotes]: formData.expenseNotes + (formData.costingNotes ? `\n\nNotes: ${formData.costingNotes}` : ''),
      
      // Numeric columns
      [COLUMNS.hirehopJobNumber]: formData.hirehopJobNumber ? parseInt(formData.hirehopJobNumber) : null,
      [COLUMNS.distanceMiles]: formData.distanceMiles || null,
      [COLUMNS.driveTimeMinutes]: formData.driveTimeMinutes || null,
      [COLUMNS.returnTravelTimeMins]: formData.returnTravelTimeMins || null,
      [COLUMNS.returnTravelCost]: formData.returnTravelCost || null,
      [COLUMNS.workDurationHours]: formData.workDurationHours || null,
      [COLUMNS.numberOfDays]: formData.numberOfDays || null,
      [COLUMNS.earlyStartMinutes]: formData.earlyStartMinutes || null,
      [COLUMNS.lateFinishMinutes]: formData.lateFinishMinutes || null,
      [COLUMNS.clientChargeTotal]: costs.clientChargeTotal,
      [COLUMNS.freelancerFee]: costs.freelancerFee,
      [COLUMNS.expectedExpenses]: totalExpectedExpenses,
      [COLUMNS.ourMargin]: costs.ourMargin,
      [COLUMNS.pdAmount]: formData.pdAmount || null,
      
      // Date column
      [COLUMNS.jobDate]: formData.jobDate ? { date: formData.jobDate } : null,
      
      // Status columns (these need label format)
      [COLUMNS.jobType]: formData.jobType ? { label: JOB_TYPE_LABELS[formData.jobType] } : null,
      [COLUMNS.status]: { label: 'Draft' },
      [COLUMNS.transportMode]: formData.transportMode ? { label: TRANSPORT_MODE_LABELS[formData.transportMode] } : null,
      [COLUMNS.returnMethod]: formData.returnMethod ? { label: RETURN_METHOD_LABELS[formData.returnMethod] } : null,
      [COLUMNS.workType]: formData.workType ? { label: WORK_TYPE_LABELS[formData.workType] } : null,
      [COLUMNS.calculationMode]: formData.calculationMode ? { label: CALC_MODE_LABELS[formData.calculationMode] } : null,
      [COLUMNS.expenseArrangement]: formData.expenseArrangement ? { label: EXPENSE_ARRANGEMENT_LABELS[formData.expenseArrangement] } : null,
      [COLUMNS.pdArrangement]: formData.pdArrangement ? { label: PD_ARRANGEMENT_LABELS[formData.pdArrangement] } : null,
    }

    // Remove null values to avoid API issues
    Object.keys(columnValues).forEach(key => {
      if (columnValues[key] === null || columnValues[key] === undefined) {
        delete columnValues[key]
      }
    })

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

    console.log('Crew Transport: Created item', result.create_item.id)

    // If addCollection is true, create a second item for the collection
    if (formData.addCollection && formData.collectionDate) {
      const collectionName = formData.hirehopJobNumber 
        ? `Job ${formData.hirehopJobNumber} - Collection - ${formData.destination}`
        : `Collection - ${formData.destination}`

      // Collection has same transport costs, just different date and type
      const collectionColumnValues: Record<string, unknown> = {
        ...columnValues,
        [COLUMNS.jobType]: { label: 'Collection' },
        [COLUMNS.jobDate]: { date: formData.collectionDate },
      }

      await mondayQuery(mutation, {
        boardId: CREW_JOBS_BOARD_ID,
        itemName: collectionName,
        columnValues: JSON.stringify(collectionColumnValues),
      })

      console.log('Crew Transport: Also created collection item')
    }

    return NextResponse.json({
      success: true,
      itemId: result.create_item.id,
      itemName: result.create_item.name,
    })

  } catch (error) {
    console.error('Crew Transport API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to save' },
      { status: 500 }
    )
  }
}

// GET endpoint to fetch existing item for editing
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
    const itemId = searchParams.get('itemId')

    if (!itemId) {
      return NextResponse.json(
        { success: false, error: 'Item ID required' },
        { status: 400 }
      )
    }

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

  } catch (error) {
    console.error('Crew Transport GET error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch item' },
      { status: 500 }
    )
  }
}