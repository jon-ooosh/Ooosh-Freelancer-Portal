/**
 * "I've read and understood this"
 *
 * POST /api/resources/[id]/read
 *
 * Records that the logged-in freelancer has read a document's current version
 * (OP services/freelancer-document-reads.ts). A new version asks again.
 * OP-only. Requires authentication.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { markResourceReadInOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }
    const { id } = await params
    try {
      const data = await markResourceReadInOP(sessionToken, id)
      return NextResponse.json({ success: true, readAt: data.readAt })
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP resource read error:', opError)
      return NextResponse.json({ success: false, error: 'That did not save. Please try again.' }, { status: 502 })
    }
  } catch (error) {
    console.error('Resource read API error:', error)
    return NextResponse.json({ success: false, error: 'That did not save. Please try again.' }, { status: 500 })
  }
}
