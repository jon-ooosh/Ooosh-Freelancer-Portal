/**
 * DEBUG ENDPOINT - DELETE AFTER TESTING
 * 
 * GET /api/debug/venue?jobId=xxx
 * 
 * Diagnoses venue connection issues
 */

import { NextRequest, NextResponse } from 'next/server'
import { mondayQuery, getBoardIds, DC_COLUMNS, VENUE_COLUMNS } from '@/lib/monday'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DebugInfo = Record<string, any>

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId')
  
  if (!jobId) {
    return NextResponse.json({ 
      error: 'Please provide ?jobId=xxx parameter',
      example: '/api/debug/venue?jobId=10944527600'
    })
  }

  const debug: DebugInfo = {
    jobId,
    boardIds: getBoardIds(),
    steps: []
  }

  try {
    // Step 1: Fetch the raw job data
    const jobQuery = `
      query ($itemIds: [ID!]!) {
        items(ids: $itemIds) {
          id
          name
          column_values {
            id
            text
            value
            type
          }
        }
      }
    `

    const jobResult = await mondayQuery<{
      items: Array<{
        id: string
        name: string
        column_values: Array<{
          id: string
          text: string
          value: string
          type: string
        }>
      }>
    }>(jobQuery, { itemIds: [jobId] })

    const job = jobResult.items?.[0]
    
    if (!job) {
      debug.steps.push({ step: 1, result: 'Job not found' })
      return NextResponse.json(debug)
    }

    debug.steps.push({ 
      step: 1, 
      result: 'Job found',
      jobName: job.name,
      totalColumns: job.column_values.length
    })

    // Step 2: Find the venue connect column
    const venueColumn = job.column_values.find(col => col.id === DC_COLUMNS.venueConnect)
    
    debug.steps.push({
      step: 2,
      result: 'Looking for venue connect column',
      columnIdWeAreLookingFor: DC_COLUMNS.venueConnect,
      venueColumnFound: !!venueColumn,
      venueColumnData: venueColumn ? {
        id: venueColumn.id,
        text: venueColumn.text,
        value: venueColumn.value,
        type: venueColumn.type,
      } : null
    })

    // Step 3: Parse the venue ID
    let venueId: string | null = null
    let parseError: string | null = null

    if (venueColumn?.value) {
      try {
        const parsed = JSON.parse(venueColumn.value)
        debug.steps.push({
          step: 3,
          result: 'Parsed venue column value',
          parsedValue: parsed
        })
        
        if (parsed?.linkedPulseIds?.[0]?.linkedPulseId) {
          venueId = parsed.linkedPulseIds[0].linkedPulseId.toString()
        } else if (Array.isArray(parsed) && parsed[0]) {
          venueId = parsed[0].toString()
        }
        
      } catch (e) {
        parseError = e instanceof Error ? e.message : 'Unknown parse error'
      }
    }

    debug.steps.push({
      step: 4,
      result: 'Extracted venue ID',
      venueId,
      parseError
    })

    // Step 4: Fetch the venue if we have an ID
    if (venueId) {
      const venuesBoardId = getBoardIds().venues
      
      if (!venuesBoardId) {
        debug.steps.push({
          step: 5,
          result: 'ERROR: MONDAY_BOARD_ID_VENUES not configured'
        })
      } else {
        const venueQuery = `
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

        const venueResult = await mondayQuery<{
          items: Array<{
            id: string
            name: string
            column_values: Array<{
              id: string
              text: string
              value: string
            }>
          }>
        }>(venueQuery, { itemIds: [venueId] })

        const venue = venueResult.items?.[0]

        if (!venue) {
          debug.steps.push({
            step: 5,
            result: 'Venue not found in Address Book',
            venueId,
            boardId: venuesBoardId
          })
        } else {
          const venueColumns = venue.column_values.map(col => ({
            id: col.id,
            text: col.text?.substring(0, 100),
            hasValue: !!col.value
          }))

          debug.steps.push({
            step: 5,
            result: 'Venue found!',
            venueId: venue.id,
            venueName: venue.name,
            columnCount: venue.column_values.length,
            columns: venueColumns,
            expectedColumnIds: VENUE_COLUMNS
          })
        }
      }
    } else {
      debug.steps.push({
        step: 5,
        result: 'Skipped venue fetch - no venue ID extracted'
      })
    }

    // Show all connect-type columns
    const connectColumns = job.column_values.filter(col => 
      col.type === 'board-relation' || 
      col.id.includes('connect')
    )

    debug.connectColumnsInJob = connectColumns.map(col => ({
      id: col.id,
      type: col.type,
      text: col.text,
      value: col.value
    }))

    return NextResponse.json(debug, { status: 200 })

  } catch (error) {
    debug.error = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json(debug, { status: 500 })
  }
}
