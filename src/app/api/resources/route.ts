/**
 * Resources API Endpoint
 * 
 * GET /api/resources
 * 
 * Fetches all resources (documents/guides) marked for freelancer sharing
 * from the Staff Training board in Monday.com.
 * 
 * Requires authentication.
 */

import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getResourcesForFreelancers } from '@/lib/monday'

export async function GET() {
  try {
    // Check session - user must be authenticated
    const session = await getSessionUser()
    
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    console.log('Resources API: Fetching resources for', session.email)

    // Fetch resources from Monday
    const resources = await getResourcesForFreelancers()

    return NextResponse.json({
      success: true,
      resources,
      totalCount: resources.length,
    })

  } catch (error) {
    console.error('Resources API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch resources' },
      { status: 500 }
    )
  }
}