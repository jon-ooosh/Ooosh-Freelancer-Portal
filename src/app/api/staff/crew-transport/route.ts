/**
 * Crew & Transport API
 * 
 * POST /api/staff/crew-transport - Create new item
 * GET /api/staff/crew-transport?jobNumber=X - Fetch job info from Q&H board
 * GET /api/staff/crew-transport?itemId=X - Fetch existing crew job item
 */

import { NextRequest, NextResponse } from 'next/server'

const MONDAY_API_URL = 'https://api.monday.com/v2'
const CREW_JOBS_BOARD_ID = process.env.MONDAY_BOARD_ID_CREW_JOBS || '18398014629'
const QH_BOARD_ID = '2431480012'

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
  workTypeOther: 'text_mm06542v',
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

// Map form values to Monday status labels - MUST match exactly what's in Monday
const JOB_TYPE_LABELS: Record<string, string> = {
  'delivery': 'Transport Only',
  'collection': 'Transport Only',
  'crewed_job': 'Transport + Crew',
  'crew_only': 'Crew Only',
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

// Work type labels - matching the Monday board exactly (from Jon's screenshot)
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
  clientName: string
  jobType: string
  transportMode: string
  destination: string
  distanceMiles: number
  driveTimeMinutes: number
  returnMethod: string
  returnTravelTimeMins: number
  returnTravelCost: number
  workType: string
  workTypeOther: string
  workDurationHours: number
  workDescription: string
  jobDate: string
  collectionDate: string
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

    // Determine the actual job type for Monday based on selection
    let mondayJobType = JOB_TYPE_LABELS[formData.jobType] || 'Transport Only'
    
    // For crewed jobs, check if there's transport or not
    if (formData.jobType === 'crewed_job') {
      if (formData.transportMode === 'na' || !formData.transportMode) {
        mondayJobType = 'Crew Only'
      } else {
        mondayJobType = 'Transport + Crew'
      }
    }

    console.log('Crew Transport: Job type mapping:', formData.jobType, '->', mondayJobType)

    // Build item name
    const typeLabel = formData.jobType === 'delivery' ? 'Delivery' : 
                      formData.jobType === 'collection' ? 'Collection' : 
                      'Crewed Job'
    const itemName = formData.hirehopJobNumber 
      ? `Job ${formData.hirehopJobNumber} - ${typeLabel} - ${formData.destination || 'TBC'}`
      : `${typeLabel} - ${formData.destination || 'New Job'}`

    // Calculate total expected expenses
    const totalExpectedExpenses = costs.expectedFuelCost + costs.expectedOtherExpenses

    // Build column values object - only include non-null values
    const columnValues: Record<string, unknown> = {}
    
    // Text columns
    if (formData.destination) columnValues[COLUMNS.destination] = formData.destination
    if (formData.workDescription) columnValues[COLUMNS.workDescription] = formData.workDescription
    if (formData.workType === 'other' && formData.workTypeOther) {
      columnValues[COLUMNS.workTypeOther] = formData.workTypeOther
    }
    
    // Combine notes
    const combinedNotes = [formData.expenseNotes, formData.costingNotes ? `Notes: ${formData.costingNotes}` : '']
      .filter(Boolean).join('\n\n')
    if (combinedNotes) columnValues[COLUMNS.expenseNotes] = combinedNotes
    
    // Numeric columns - only set if > 0
    if (formData.hirehopJobNumber) columnValues[COLUMNS.hirehopJobNumber] = parseInt(formData.hirehopJobNumber)
    if (formData.distanceMiles > 0) columnValues[COLUMNS.distanceMiles] = formData.distanceMiles
    if (formData.driveTimeMinutes > 0) columnValues[COLUMNS.driveTimeMinutes] = formData.driveTimeMinutes
    if (formData.returnTravelTimeMins > 0) columnValues[COLUMNS.returnTravelTimeMins] = formData.returnTravelTimeMins
    if (formData.returnTravelCost > 0) columnValues[COLUMNS.returnTravelCost] = formData.returnTravelCost
    if (formData.workDurationHours > 0) columnValues[COLUMNS.workDurationHours] = formData.workDurationHours
    if (formData.numberOfDays > 0) columnValues[COLUMNS.numberOfDays] = formData.numberOfDays
    if (formData.earlyStartMinutes > 0) columnValues[COLUMNS.earlyStartMinutes] = formData.earlyStartMinutes
    if (formData.lateFinishMinutes > 0) columnValues[COLUMNS.lateFinishMinutes] = formData.lateFinishMinutes
    if (formData.pdAmount > 0) columnValues[COLUMNS.pdAmount] = formData.pdAmount
    
    // Financial columns - always set these
    columnValues[COLUMNS.clientChargeTotal] = costs.clientChargeTotal
    columnValues[COLUMNS.freelancerFee] = costs.freelancerFee
    columnValues[COLUMNS.expectedExpenses] = totalExpectedExpenses
    columnValues[COLUMNS.ourMargin] = costs.ourMargin
    
    // Date column
    if (formData.jobDate) columnValues[COLUMNS.jobDate] = { date: formData.jobDate }
    
    // Status columns - only set if we have valid values
    columnValues[COLUMNS.jobType] = { label: mondayJobType }
    columnValues[COLUMNS.status] = { label: 'Working on it' }
    
    if (formData.transportMode && TRANSPORT_MODE_LABELS[formData.transportMode]) {
      columnValues[COLUMNS.transportMode] = { label: TRANSPORT_MODE_LABELS[formData.transportMode] }
    }
    if (formData.returnMethod && RETURN_METHOD_LABELS[formData.returnMethod]) {
      columnValues[COLUMNS.returnMethod] = { label: RETURN_METHOD_LABELS[formData.returnMethod] }
    }
    if (formData.workType && WORK_TYPE_LABELS[formData.workType]) {
      columnValues[COLUMNS.workType] = { label: WORK_TYPE_LABELS[formData.workType] }
    }
    if (formData.calculationMode && CALC_MODE_LABELS[formData.calculationMode]) {
      columnValues[COLUMNS.calculationMode] = { label: CALC_MODE_LABELS[formData.calculationMode] }
    }
    if (formData.expenseArrangement && EXPENSE_ARRANGEMENT_LABELS[formData.expenseArrangement]) {
      columnValues[COLUMNS.expenseArrangement] = { label: EXPENSE_ARRANGEMENT_LABELS[formData.expenseArrangement] }
    }
    if (formData.pdArrangement && PD_ARRANGEMENT_LABELS[formData.pdArrangement]) {
      columnValues[COLUMNS.pdArrangement] = { label: PD_ARRANGEMENT_LABELS[formData.pdArrangement] }
    }

    console.log('Crew Transport: Column values:', JSON.stringify(columnValues, null, 2))

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

      // Collection is also Transport Only, with the collection date
      const collectionColumnValues: Record<string, unknown> = { ...columnValues }
      collectionColumnValues[COLUMNS.jobType] = { label: 'Transport Only' }
      collectionColumnValues[COLUMNS.jobDate] = { date: formData.collectionDate }

      await mondayQuery(mutation, {
        boardId: CREW_JOBS_BOARD_ID,
        itemName: collectionName,
        columnValues: JSON.stringify(collectionColumnValues),
      })

      console.log('Crew Transport: Also created collection item for', formData.collectionDate)
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

// GET endpoint to fetch job info from Q&H board
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
      
      // Use items_page_by_column_values for efficient lookup
      // text7 is the HireHop Ref column in Q&H board
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
        columnId: 'text7', // HireHop Ref column
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