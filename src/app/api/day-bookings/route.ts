/**
 * Yard days for the logged-in freelancer (spec §9.3).
 *
 * GET /api/day-bookings
 *
 * Proxies to the OP backend. Mirrors /api/studio-sitter/shifts: an independent
 * fetch whose failure must never break the jobs dashboard, so the section
 * simply hides when this cannot be loaded.
 */
import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { getDayBookingsFromOP } from '@/lib/op-api'
import { readSince } from '@/lib/history'

export async function GET(request: NextRequest) {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not signed in' }, { status: 401 })
  }
  const sessionToken = (await cookies()).get('session')?.value || ''
  try {
    // `since` adds `done`, the days the Completed page lists (lib/history.ts).
    return NextResponse.json(await getDayBookingsFromOP(sessionToken, readSince(request.nextUrl.searchParams.get('since'))))
  } catch (error) {
    console.error('Failed to fetch day bookings:', error)
    return NextResponse.json({ success: false, error: 'Could not load your days' }, { status: 502 })
  }
}
