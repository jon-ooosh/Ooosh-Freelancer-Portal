/**
 * DEBUG ENDPOINT - DELETE AFTER TESTING
 * 
 * GET /api/debug/venue?jobId=xxx
 * 
 * Diagnoses venue connection issues by showing:
 * 1. Raw column data from the job
 * 2. Extracted venue ID
 * 3. Venue fetch result
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
    // Step 1: Fetch the raw job data including venue connect column
    const jobQuery = `
      query ($itemIds: [ID!]!) {
        items(ids: $itemIds) {
          id
          name
          column_values {
            id
            title
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
          title: string
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

    // Step 2: Find the venue connect column specifically
    const venueColumn = job.column_values.find(col => col.id === DC_COLUMNS.venueConnect)
    
    debug.steps.push({
      step: 2,
      result: 'Looking for venue connect column',
      columnIdWeAreLookingFor: DC_COLUMNS.venueConnect,
      venueColumnFound: !!venueColumn,
      venueColumnData: venueColumn ? {
        id: venueColumn.id,
        title: venueColumn.title,
        text: venueColumn.text,
        value: venueColumn.value,
        type: venueColumn.type,
      } : null
    })

    // Step 3: Try to parse the venue ID from the connect column value
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
        
        // Connect columns can have different structures
        // Try linkedPulseIds first (standard connect column)
        if (parsed?.linkedPulseIds?.[0]?.linkedPulseId) {
          venueId = parsed.linkedPulseIds[0].linkedPulseId.toString()
        }
        // Also try direct array format
        else if (Array.isArray(parsed) && parsed[0]) {
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

    // Step 4: If we have a venue ID, try to fetch the venue
    if (venueId) {
      const venuesBoardId = getBoardIds().venues
      
      if (!venuesBoardId) {
        debug.steps.push({
          step: 5,
          result: 'ERROR: MONDAY_BOARD_ID_VENUES not configured',
          envValue: process.env.MONDAY_BOARD_ID_VENUES || '(not set)'
        })
      } else {
        const venueQuery = `
          query ($itemIds: [ID!]!) {
            items(ids: $itemIds) {
              id
              name
              column_values {
                id
                title
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
              title: string
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
          // Show all venue columns so we can verify the column IDs
          const venueColumns = venue.column_values.map(col => ({
            id: col.id,
            title: col.title,
            text: col.text?.substring(0, 100), // Truncate long text
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

    // Also show all connect-type columns to help identify the right one
    const connectColumns = job.column_values.filter(col => 
      col.type === 'board-relation' || 
      col.id.includes('connect') ||
      col.title?.toLowerCase().includes('venue') ||
      col.title?.toLowerCase().includes('address')
    )

    debug.connectColumnsInJob = connectColumns.map(col => ({
      id: col.id,
      title: col.title,
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
