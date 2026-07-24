/**
 * Vehicle Check-In / Collection Token API
 *
 * POST /api/jobs/[id]/checkin-token
 *
 * Mirror of bookout-token for the COLLECTION side (fixes the Lewis mis-route —
 * a collection is a check-in, not a book-out). Mints the SAME HMAC token format
 * as book-out ({expiry}.op.{quoteId}.{email}.{signature}); the only difference
 * is the redirect target — OP's /vehicles/check-in — whose resolver
 * (freelancer-checkin/resolve) mints a checkin-mode session (soft check-in, no
 * 'returned' flip). Distinguishing by endpoint, not a token discriminator,
 * keeps the signature format identical on both sides (no drift footgun).
 *
 * OP mode only. Signed with FREELANCER_HUB_SECRET (shared with OP).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { getSessionUser } from '@/lib/session'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: jobId } = await params
    if (!jobId) {
      return NextResponse.json({ success: false, error: 'Job ID is required' }, { status: 400 })
    }

    const session = await getSessionUser()
    if (!session) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    // vanOnly = collection with no equipment leg. Kept for parity with
    // bookout-token + so the return URL can skip the equipment /complete.
    let vanOnly = false
    try {
      const body = await request.clone().json()
      vanOnly = body.vanOnly === true
    } catch {
      /* no body — default false */
    }

    const secret = process.env.FREELANCER_HUB_SECRET
    if (!secret) {
      console.error('FREELANCER_HUB_SECRET is not configured')
      return NextResponse.json({ success: false, error: 'Check-in is not configured' }, { status: 500 })
    }

    const opUrl = (process.env.OP_BACKEND_URL || '').replace(/\/$/, '')
    if (!opUrl) {
      console.error('OP_BACKEND_URL is not configured')
      return NextResponse.json({ success: false, error: 'OP backend URL is not configured' }, { status: 500 })
    }

    const expiry = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    const payload = `${expiry}.op.${jobId}.${session.email}`
    const signature = createHmac('sha256', secret).update(payload).digest('hex').substring(0, 32)
    const token = `${payload}.${signature}`

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
    const returnUrl = `${appUrl}/job/${jobId}/complete${vanOnly ? '?vanOnly=true' : ''}`

    const checkinUrl = `${opUrl}/vehicles/check-in?freelancerToken=${encodeURIComponent(token)}&returnUrl=${encodeURIComponent(returnUrl)}`

    return NextResponse.json({ success: true, checkinUrl })
  } catch (error) {
    console.error('Checkin token error:', error)
    return NextResponse.json({ success: false, error: 'Failed to generate check-in token' }, { status: 500 })
  }
}
