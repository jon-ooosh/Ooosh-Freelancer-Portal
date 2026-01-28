/**
 * HireHop Items API Endpoint
 * 
 * GET /api/hirehop/items/[jobId]?filter=equipment|vehicles|all
 * 
 * Fetches equipment/supply list for a HireHop job.
 * Requires authentication - either user session OR internal secret header.
 * 
 * Query params:
 *   filter: 'equipment' | 'vehicles' | 'all' (default: 'all')
 *     - 'equipment': Excludes vehicles, delivery charges, crew items
 *     - 'vehicles': Only shows vehicle items
 *     - 'all': Shows everything (excluding virtual items)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobItemsFiltered, ItemFilterMode } from '@/lib/hirehop'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    // Get the HireHop job ID from the URL
    const { jobId } = await params

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    // Check for internal authentication (background functions)
    // This allows server-to-server calls without a user session
    const internalSecret = request.headers.get('x-background-secret')
    const expectedSecret = process.env.BACKGROUND_FUNCTION_SECRET || process.env.MONDAY_WEBHOOK_SECRET
    const isInternalCall = internalSecret && expectedSecret && internalSecret === expectedSecret

    // Check session - user must be authenticated (unless internal call)
    if (!isInternalCall) {
      const session = await getSessionUser()
      
      if (!session) {
        return NextResponse.json(
          { success: false, error: 'Not authenticated' },
          { status: 401 }
        )
      }
      
      console.log(`HireHop Items API: Fetching items for HH job ${jobId} with filter (user: ${session.email})`)
    } else {
      console.log(`HireHop Items API: Fetching items for HH job ${jobId} (internal call)`)
    }

    // Get filter mode from query params (default to 'all')
    const searchParams = request.nextUrl.searchParams
    const filterParam = searchParams.get('filter') || 'all'
    
    // Validate filter mode
    const validFilters: ItemFilterMode[] = ['all', 'equipment', 'vehicles']
    const filterMode: ItemFilterMode = validFilters.includes(filterParam as ItemFilterMode) 
      ? (filterParam as ItemFilterMode) 
      : 'all'

    // Fetch items from HireHop with filtering
    const result = await getJobItemsFiltered(jobId, filterMode)

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      jobId,
      items: result.items,
      totalItems: result.totalItems,
      filterApplied: filterMode,
    })

  } catch (error) {
    console.error('HireHop Items API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch items' },
      { status: 500 }
    )
  }
}