/**
 * Studio Sitter — recent handover carry-forward
 *
 * GET /api/studio-sitter/shifts/[date]/recent-handover → the last few nights'
 *   handover notes (read-only), so a sitter arriving fresh sees prior context
 *   the per-night thread anchor doesn't carry across.
 *
 * OP-only. Access enforced OP-side (rostered sitter or shared staff account).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  isOpMode,
  getSitterRecentHandoverFromOP,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const { date } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    if (!isOpMode()) {
      return NextResponse.json({ success: true, nights: [] })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const data = await getSitterRecentHandoverFromOP(sessionToken, date)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP sitter recent-handover error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load recent handover notes.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter recent-handover GET error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load recent handover notes' }, { status: 500 })
  }
}
