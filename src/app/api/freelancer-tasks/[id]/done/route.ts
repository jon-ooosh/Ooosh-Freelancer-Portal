/**
 * Tick off a task on a yard day or a sitter evening (STAFF-CALENDAR-SPEC §21).
 *
 * POST /api/freelancer-tasks/:id/done
 *
 * The OP backend owns every rule — that the task is theirs, that it is not a
 * van prep (saving the prep sheet ticks those). This route only carries the
 * session through, so those rules live in one place.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { markFreelancerTaskDoneFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

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
    return NextResponse.json(await markFreelancerTaskDoneFromOP(sessionToken, id))
  } catch (error) {
    // A 4xx from OP is a real answer and must reach the person.
    if (isOpClientError(error)) {
      const err = error as OpApiError
      return NextResponse.json({ success: false, error: err.message }, { status: err.status ?? 400 })
    }
    console.error('Failed to tick off freelancer task:', error)
    return NextResponse.json({ success: false, error: 'That did not save' }, { status: 502 })
  }
}
