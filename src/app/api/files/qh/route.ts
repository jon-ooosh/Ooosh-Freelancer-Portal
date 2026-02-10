/**
 * Q&H Files API Endpoint
 * 
 * GET /api/files/qh?hhRef=12345 - Get files from the Q&H board for a specific HireHop job
 * 
 * Looks up the Q&H board (2431480012) by HireHop job number (column text7),
 * then returns any files from column files1.
 * 
 * These are typically band/job-specific files like tech riders, stage plots, etc.
 * Security: Requires authenticated session.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { mondayQuery, extractFileAssets, FileAsset } from '@/lib/monday'

// Q&H board constants
const QH_BOARD_ID = '2431480012'
const QH_COLUMNS = {
  hhRef: 'text7',       // HireHop job number
  files: 'files1',      // Files column
} as const

export async function GET(request: NextRequest) {
  try {
    // Check session
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const hhRef = searchParams.get('hhRef')

    if (!hhRef) {
      return NextResponse.json(
        { success: false, error: 'HireHop reference is required' },
        { status: 400 }
      )
    }

    console.log('Q&H Files API: Looking up files for HireHop job', hhRef)
    const startTime = Date.now()

    // Query Q&H board for items matching the HireHop ref
    const query = `
      query {
        items_page_by_column_values (
          board_id: ${QH_BOARD_ID},
          columns: [
            {
              column_id: "${QH_COLUMNS.hhRef}",
              column_values: ["${hhRef}"]
            }
          ],
          limit: 10
        ) {
          items {
            id
            name
            column_values(ids: ["${QH_COLUMNS.files}"]) {
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
    console.log('Q&H Files API: Query completed in', queryTime, 'ms, found', items.length, 'matching items')

    // Collect all files from all matching Q&H items
    const allFiles: Array<FileAsset & { sourceName: string }> = []

    for (const item of items) {
      const filesCol = item.column_values.find(c => c.id === QH_COLUMNS.files)
      const files = extractFileAssets(filesCol?.value)
      
      if (files.length > 0) {
        console.log(`Q&H Files API: Found ${files.length} files on "${item.name}"`)
        files.forEach(f => {
          allFiles.push({
            ...f,
            sourceName: item.name,  // Include the Q&H item name for context
          })
        })
      }
    }

    console.log('Q&H Files API: Total files found:', allFiles.length)

    return NextResponse.json({
      success: true,
      files: allFiles,
      itemCount: items.length,
    })

  } catch (error) {
    console.error('Q&H Files API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch Q&H files' },
      { status: 500 }
    )
  }
}