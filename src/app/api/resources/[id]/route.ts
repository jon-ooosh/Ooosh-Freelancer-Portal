/**
 * Resource Detail API Endpoint
 *
 * GET /api/resources/[id]
 *
 * Returns a single shareable staff document — the markdown body for the
 * in-portal reader, or a fresh presigned url for a file-backed doc. OP-only.
 *
 * Requires authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  isOpMode,
  getResourceDetailFromOP,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    if (!isOpMode()) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Session token missing' },
        { status: 401 }
      )
    }

    const { id } = await params

    try {
      const data = await getResourceDetailFromOP(sessionToken, id)
      return NextResponse.json({ success: true, resource: data.resource })
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP resource detail error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load this document. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Resource detail API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch resource' },
      { status: 500 }
    )
  }
}
