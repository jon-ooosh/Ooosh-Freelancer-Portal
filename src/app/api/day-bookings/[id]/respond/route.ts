/**
 * Accept or decline a yard day from the portal (spec §9.3).
 *
 * POST /api/day-bookings/:id/respond   { response: 'accepted' | 'declined', note?: string }
 *
 * The OP backend owns every rule — ownership, whether the day is still open,
 * whether it has passed. This route only carries the session through, so there
 * is one place those rules live rather than two that can drift.
 */
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { respondToDayBookingFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not signed in' }, { status: 401 })
  }
  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const response = body?.response
  if (response !== 'accepted' && response !== 'declined') {
    return NextResponse.json({ success: false, error: 'Tell us yes or no' }, { status: 400 })
  }

  const sessionToken = (await cookies()).get('session')?.value || ''
  try {
    return NextResponse.json(
      await respondToDayBookingFromOP(sessionToken, id, response, body?.note)
    )
  } catch (error) {
    // A 4xx from OP is a real answer — "already accepted", "that day passed" —
    // and must reach the person rather than becoming a generic 502.
    if (isOpClientError(error)) {
      const err = error as OpApiError
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status ?? 400 },
      )
    }
    console.error('Failed to respond to day booking:', error)
    return NextResponse.json({ success: false, error: 'That did not save' }, { status: 502 })
  }
}
