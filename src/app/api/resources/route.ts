/**
 * Resources API Endpoint
 *
 * GET /api/resources
 *
 * Fetches staff documents flagged as shareable with freelancers from the
 * Operations Platform (OP). Replaces the old Monday "Staff Training" board read
 * — Monday has been retired, so this is OP-only with no fallback. When the
 * portal isn't in OP mode (shouldn't happen in production) it returns an empty
 * list, and the page shows its empty state.
 *
 * Requires authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  getResourcesFromOP,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Session token missing' },
        { status: 401 }
      )
    }

    try {
      const data = await getResourcesFromOP(sessionToken)
      const resources = data.resources || []
      return NextResponse.json({ success: true, resources, totalCount: resources.length })
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP resources error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load resources. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Resources API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch resources' },
      { status: 500 }
    )
  }
}
