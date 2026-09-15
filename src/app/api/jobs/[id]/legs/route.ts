/**
 * Declare Job Legs API
 *
 * POST /api/jobs/[id]/legs   body: { van: boolean, equipment: boolean }
 *
 * The /start wizard ("van only / backline only / both") declares which legs a
 * D&C job involves. We forward that to OP so it can close the quote server-side
 * the moment the last required leg lands (van book-out and/or equipment
 * /complete) — no cross-domain return hop required.
 *
 * Best-effort: a failure here MUST NOT block the freelancer starting their
 * book-out / completion — the caller ignores errors and proceeds.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { declareLegsOP } from '@/lib/op-api'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: quoteId } = await params
    if (!quoteId) {
      return NextResponse.json({ success: false, error: 'Job ID is required' }, { status: 400 })
    }

    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    let van = false
    let equipment = false
    try {
      const body = await request.json()
      van = body.van === true
      equipment = body.equipment === true
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid body' }, { status: 400 })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    const result = await declareLegsOP(sessionToken, quoteId, { van, equipment })
    return NextResponse.json(result)
  } catch (error) {
    console.error('Declare legs error:', error)
    return NextResponse.json({ success: false, error: 'Failed to record job legs' }, { status: 500 })
  }
}
