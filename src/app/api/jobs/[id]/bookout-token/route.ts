/**
 * Vehicle Book-Out Token API
 *
 * POST /api/jobs/[id]/bookout-token
 *
 * Generates a signed HMAC token for the vehicle book-out flow.
 *
 *   Token format: {expiry}.op.{quoteId}.{driverEmail}.{signature}
 *   Redirect: {OP_BACKEND_URL}/vehicles/book-out?freelancerToken=...
 *   The OP backend validates the signature, checks the freelancer is
 *   assigned to the quote, and resolves the allocated vehicle +
 *   vehicle_hire_assignment on its side (portal doesn't need to know).
 *
 * Signed with FREELANCER_HUB_SECRET (shared with OP backend).
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
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    // Check session
    const session = await getSessionUser()

    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    // Parse vanOnly so the return URL can skip the equipment /complete.
    let vanOnly = false
    try {
      const body = await request.clone().json()
      vanOnly = body.vanOnly === true
    } catch {
      // No body or invalid JSON — default to false
    }

    const secret = process.env.FREELANCER_HUB_SECRET
    if (!secret) {
      console.error('FREELANCER_HUB_SECRET is not configured')
      return NextResponse.json(
        { success: false, error: 'Book-out is not configured' },
        { status: 500 }
      )
    }

    // The jobId from the portal is the OP quote UUID (portal job list
    // returns OP quote IDs). We mint a token carrying the quote UUID,
    // and the OP backend resolves the allocated vehicle + hire
    // assignment on its side.
    const opUrl = (process.env.OP_BACKEND_URL || '').replace(/\/$/, '')
    if (!opUrl) {
      console.error('OP_BACKEND_URL is not configured')
      return NextResponse.json(
        { success: false, error: 'OP backend URL is not configured' },
        { status: 500 }
      )
    }

    const expiry = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    // Prefix with "op" so the OP-side token verifier can distinguish
    // the new format from any legacy hh-job-based token still in
    // flight during the transition.
    const payload = `${expiry}.op.${jobId}.${session.email}`
    const signature = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .substring(0, 32)
    const token = `${payload}.${signature}`

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
    const returnUrl = `${appUrl}/job/${jobId}/complete${vanOnly ? '?vanOnly=true' : ''}`

    const bookoutUrl = `${opUrl}/vehicles/book-out?freelancerToken=${encodeURIComponent(token)}&returnUrl=${encodeURIComponent(returnUrl)}`

    return NextResponse.json({
      success: true,
      bookoutUrl,
    })
  } catch (error) {
    console.error('Bookout token error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to generate book-out token' },
      { status: 500 }
    )
  }
}
