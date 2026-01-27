/**
 * HireHop Items API Route
 * 
 * GET /api/hirehop/items/[hhRef]?filter=equipment|vehicles|all
 * 
 * Fetches equipment/supply list from HireHop for a given job.
 * Optionally filters items based on job type (equipment vs vehicle delivery).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getJobItemsFiltered, ItemFilterMode } from '@/lib/hirehop'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hhRef: string }> }
) {
  try {
    const { hhRef } = await params
    
    if (!hhRef) {
      return NextResponse.json(
        { success: false, error: 'HireHop reference is required' },
        { status: 400 }
      )
    }

    // Get filter mode from query params (default to 'all')
    const searchParams = request.nextUrl.searchParams
    const filterParam = searchParams.get('filter') || 'all'
    
    // Validate filter mode
    const validFilters: ItemFilterMode[] = ['all', 'equipment', 'vehicles']
    const filterMode: ItemFilterMode = validFilters.includes(filterParam as ItemFilterMode) 
      ? (filterParam as ItemFilterMode) 
      : 'all'

    console.log(`API: Fetching HireHop items for job ${hhRef} with filter: ${filterMode}`)

    // Fetch items with filtering
    const result = await getJobItemsFiltered(hhRef, filterMode)

    if (!result.success) {
      return NextResponse.json(
        { success: false, error: result.error || 'Failed to fetch items' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      items: result.items,
      totalItems: result.totalItems,
      filterApplied: filterMode,
    })

  } catch (error) {
    console.error('API: Error fetching HireHop items:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}