/**
 * Single Job API Endpoint
 *
 * GET /api/jobs/[id] - Fetch a specific job from the OP backend.
 *
 * Returns job details including venue information if the logged-in user is assigned to it.
 * Security: Users can only view jobs assigned to them.
 * Privacy: Contact phone numbers are only visible within 48 hours of the job date.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobDetailFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Get the job ID from the URL
    const { id: jobId } = await params

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    // Check session
    const session = await getSessionUser()

    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    console.log('Job API: Fetching job', jobId, 'for user', session.email)

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Session token missing' },
        { status: 401 }
      )
    }

    try {
      const opData = await getJobDetailFromOP(sessionToken, jobId)
      return NextResponse.json(opData)
    } catch (opError) {
      // 4xx from OP = legitimate negative response (404 not found / not
      // assigned, 401 session expired, etc.). NOT an OP outage —
      // propagate to the user as-is, no alert.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json(
          { success: false, error: opError.message },
          { status }
        )
      }
      console.error('OP backend job detail error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load this job. Please refresh and try again.' },
        { status: 502 }
      )
    }

  } catch (error) {
    console.error('Job API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch job' },
      { status: 500 }
    )
  }
}