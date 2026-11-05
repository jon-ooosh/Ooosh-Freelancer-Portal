/**
 * Documents to read
 *
 * GET /api/resources/unread
 *
 * The Staff Documents this freelancer is asked to confirm they've read and
 * hasn't yet (OP services/freelancer-document-reads.ts). The dashboard shows
 * them as a reminder; nothing is blocked. OP-only. Requires authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getUnreadResourcesFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function GET(request: NextRequest) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }
    try {
      const data = await getUnreadResourcesFromOP(sessionToken)
      return NextResponse.json({ success: true, documents: data.documents || [] })
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP unread resources error:', opError)
      return NextResponse.json({ success: false, error: 'Unable to load documents to read.' }, { status: 502 })
    }
  } catch (error) {
    console.error('Unread resources API error:', error)
    return NextResponse.json({ success: false, error: 'Failed to fetch documents to read' }, { status: 500 })
  }
}
