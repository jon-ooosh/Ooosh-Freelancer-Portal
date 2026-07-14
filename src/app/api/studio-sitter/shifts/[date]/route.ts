/**
 * Studio Sitter Shift Detail API Endpoint
 *
 * GET /api/studio-sitter/shifts/[date]   (date = YYYY-MM-DD)
 *
 * One evening's detail for the logged-in sitter: envelope times, the per-night
 * fee, and who's in each room that night with each job's shared specs/files.
 *
 * OP-only. Access is enforced on the OP side — the sitter must be rostered to
 * this evening (or be the shared staff account), otherwise OP returns 403.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  isOpMode,
  getSitterShiftDetailFromOP,
  isOpClientError,
  OpApiError,
  reportFallback,
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
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const detail = await getSitterShiftDetailFromOP(sessionToken, date)
      return NextResponse.json(detail)
    } catch (opError) {
      // 4xx = legitimate negative response (403 not rostered, 400 bad date,
      // 401 session expired) — propagate as-is, no alert.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP sitter shift detail error:', opError)
      reportFallback('sitter-shift-detail', opError, { email: user.email })
      return NextResponse.json(
        { success: false, error: 'Unable to load this shift. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter shift detail API error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load shift' }, { status: 500 })
  }
}
