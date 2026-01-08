/**
 * Debug Endpoint for Jobs
 * 
 * GET /api/debug/jobs
 * 
 * Returns raw data from Monday.com to help diagnose issues.
 * REMOVE THIS IN PRODUCTION - it exposes internal data!
 */

import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { mondayQuery, getBoardIds, DC_COLUMNS } from '@/lib/monday'

export async function GET(): Promise<NextResponse> {
  const startTime = Date.now()
  
  try {
    // Get the logged-in user from session
    const user = await getSessionUser()
    
    if (!user) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    }

    const boardId = getBoardIds().deliveries
    
    if (!boardId) {
      return NextResponse.json({ 
        error: 'MONDAY_BOARD_ID_DELIVERIES not configured',
        boardIds: getBoardIds()
      }, { status: 500 })
    }

    // Simplified query - just get a few items to test
    const query = `
      query ($boardId: [ID!]!) {
        boards(ids: $boardId) {
          name
          items_page(limit: 10) {
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

    console.log('Debug: Starting Monday query for board:', boardId)
    const queryStart = Date.now()
    
    const result = await mondayQuery<{
      boards: Array<{
        name: string
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
    }>(query, { boardId: [boardId] })

    const queryTime = Date.now() - queryStart
    console.log('Debug: Monday query completed in', queryTime, 'ms')

    const board = result.boards[0]
    const items = board?.items_page?.items || []

    // Extract relevant info from first few items
    const itemSummaries = items.map(item => {
      const getCol = (colId: string) => {
        const col = item.column_values.find(c => c.id === colId)
        return col?.text || '(empty)'
      }

      return {
        id: item.id,
        name: item.name,
        status: getCol(DC_COLUMNS.status),
        statusColumnId: DC_COLUMNS.status,
        driverEmail: getCol(DC_COLUMNS.driverEmailMirror),
        driverEmailColumnId: DC_COLUMNS.driverEmailMirror,
        date: getCol(DC_COLUMNS.date),
        allColumns: item.column_values.map(c => ({
          id: c.id,
          text: c.text?.substring(0, 50) || '(empty)'
        }))
      }
    })

    const totalTime = Date.now() - startTime

    return NextResponse.json({
      success: true,
      debug: {
        loggedInUser: user,
        boardId,
        boardName: board?.name,
        queryTimeMs: queryTime,
        totalTimeMs: totalTime,
        itemCount: items.length,
        columnIds: {
          status: DC_COLUMNS.status,
          driverEmailMirror: DC_COLUMNS.driverEmailMirror,
          date: DC_COLUMNS.date,
        }
      },
      items: itemSummaries
    })

  } catch (error) {
    const totalTime = Date.now() - startTime
    console.error('Debug endpoint error:', error)
    
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      totalTimeMs: totalTime
    }, { status: 500 })
  }
}
