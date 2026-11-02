/**
 * HireHop Items API Endpoint
 *
 * GET /api/hirehop/items/[jobId]?job=<quoteId>&filter=equipment|vehicles|all
 *
 * The kit list for a HireHop job, read with the portal's own HireHop token.
 * `jobId` is the HireHop job number; `job` is the OP job (quote) it is shown on.
 * OP must agree that job is the logged-in freelancer's and that its HireHop
 * number is the one asked for (Oct 2026). Before that any logged-in freelancer
 * could read any job's list, and a Monday-era "internal secret" header skipped
 * the login altogether.
 *
 * Query params:
 *   job:    the OP quote id (required)
 *   filter: 'equipment' | 'vehicles' | 'all' (default: 'all')
 *     - 'equipment': Excludes vehicles, delivery charges, crew items
 *     - 'vehicles': Only shows vehicle items
 *     - 'all': Shows everything (excluding virtual items)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobItemsFiltered, ItemFilterMode } from '@/lib/hirehop'
import { getHireHopRefFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    // The HireHop job number from the URL
    const { jobId } = await params
    const quoteId = request.nextUrl.searchParams.get('job') || ''

    if (!jobId || !quoteId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    const session = await getSessionUser()
    const sessionToken = request.cookies.get('session')?.value
    if (!session || !sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    // Is this job theirs, and is this its HireHop job?
    try {
      const ref = await getHireHopRefFromOP(sessionToken, quoteId)
      if (!ref.hhRef || ref.hhRef !== String(jobId)) {
        return NextResponse.json(
          { success: false, error: 'Job not found' },
          { status: 404 }
        )
      }
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json(
          { success: false, error: status === 404 ? 'Job not found' : (opError as Error).message },
          { status }
        )
      }
      throw opError
    }

    // Get filter mode from query params (default to 'all')
    const filterParam = request.nextUrl.searchParams.get('filter') || 'all'

    // Validate filter mode
    const validFilters: ItemFilterMode[] = ['all', 'equipment', 'vehicles']
    const filterMode: ItemFilterMode = validFilters.includes(filterParam as ItemFilterMode)
      ? (filterParam as ItemFilterMode)
      : 'all'

    console.log(`HireHop Items API: Fetching items for HH job ${jobId} (${filterMode}) for ${session.email}`)

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
