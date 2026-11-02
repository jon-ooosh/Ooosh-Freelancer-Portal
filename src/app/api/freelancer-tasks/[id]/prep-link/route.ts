/**
 * Get the link that opens a van's prep sheet in OP (STAFF-CALENDAR-SPEC §21.6).
 *
 * POST /api/freelancer-tasks/:id/prep-link  → { success, url }
 *
 * OP checks the task is theirs, open and near its day, and mints a short-lived
 * token into the URL. This route only carries the session through.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { getFreelancerPrepLinkFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not signed in' }, { status: 401 })
  }
  const { id } = await params
  const sessionToken = (await cookies()).get('session')?.value || ''
  try {
    return NextResponse.json(await getFreelancerPrepLinkFromOP(sessionToken, id))
  } catch (error) {
    // A 4xx from OP is a real answer ("already prepped", "opens the day before").
    if (isOpClientError(error)) {
      const err = error as OpApiError
      return NextResponse.json({ success: false, error: err.message }, { status: err.status ?? 400 })
    }
    console.error('Failed to get prep link:', error)
    return NextResponse.json({ success: false, error: 'Could not open the prep sheet' }, { status: 502 })
  }
}
