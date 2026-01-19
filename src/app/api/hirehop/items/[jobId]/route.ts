/**
 * HireHop Items API Endpoint
 * 
 * GET /api/hirehop/items/[jobId]
 * 
 * Fetches equipment/supply list for a HireHop job.
 * Requires authentication - only returns items if user is logged in.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobItems } from '@/lib/hirehop'

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

    // Check session - user must be authenticated
    const session = await getSessionUser()
    
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    console.log(`HireHop Items API: Fetching items for HH job ${jobId} (user: ${session.email})`)

    // Fetch items from HireHop
    const result = await getJobItems(jobId)

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
      totalItems: result.totalItems
    })

  } catch (error) {
    console.error('HireHop Items API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch items' },
      { status: 500 }
    )
  }
}
