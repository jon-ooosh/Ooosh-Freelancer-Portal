/**
 * Yard days for the logged-in freelancer (spec §9.3).
 *
 * GET /api/day-bookings
 *
 * Proxies to the OP backend. Mirrors /api/studio-sitter/shifts: an independent
 * fetch whose failure must never break the jobs dashboard, so the section
 * simply hides when this cannot be loaded.
 */
import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import { getDayBookingsFromOP } from '@/lib/op-api'

export async function GET() {
  const user = await getSessionUser()
  if (!user) {
    return NextResponse.json({ success: false, error: 'Not signed in' }, { status: 401 })
  }
  const sessionToken = (await cookies()).get('session')?.value || ''
  try {
    return NextResponse.json(await getDayBookingsFromOP(sessionToken))
  } catch (error) {
    console.error('Failed to fetch day bookings:', error)
    return NextResponse.json({ success: false, error: 'Could not load your days' }, { status: 502 })
  }
}
