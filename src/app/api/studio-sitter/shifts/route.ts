/**
 * Studio Sitter Shifts API Endpoint
 *
 * GET /api/studio-sitter/shifts
 *
 * Returns the logged-in freelancer's rostered studio-sitter evenings
 * (a small look-back + ~60 days ahead), each with who's in each room that
 * night and the per-night fee.
 *
 * OP-only: studio sitters are an OP-native concept with no Monday equivalent,
 * so there is no Monday fallback. When the portal isn't in OP mode, or the
 * caller simply isn't a sitter, this returns an empty list — the dashboard
 * hides the Studio Shifts section when there's nothing to show.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  isOpMode,
  getSitterShiftsFromOP,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

export async function GET(request: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }

    // OP-only feature — nothing to show outside OP mode.
    if (!isOpMode()) {
      return NextResponse.json({ success: true, shifts: [] })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const data = await getSitterShiftsFromOP(sessionToken)
      return NextResponse.json({ success: true, shifts: data.shifts || [] })
    } catch (opError) {
      // 4xx = legitimate negative response (e.g. session expired) — propagate.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      // 5xx / network — alert staff, but degrade gracefully (no Monday fallback exists).
      console.error('OP sitter shifts error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load shifts. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter shifts API error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load shifts' }, { status: 500 })
  }
}
