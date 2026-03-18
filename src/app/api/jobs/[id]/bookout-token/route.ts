/**
 * Vehicle Book-Out Token API
 *
 * POST /api/jobs/[id]/bookout-token
 *
 * Generates a signed HMAC token for the vehicle management app.
 * The token allows the freelancer to access the book-out flow
 * scoped to a specific HireHop job.
 *
 * Token format: {expiry}.{hhJobNumber}.{driverEmail}.{signature}
 * Signed with FREELANCER_HUB_SECRET (shared with vehicle app).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHmac } from 'node:crypto'
import { getSessionUser } from '@/lib/session'
import { getJobById } from '@/lib/monday'

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

    // Verify the job exists and is assigned to this user
    const job = await getJobById(jobId, session.email)

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found or not assigned to you' },
        { status: 404 }
      )
    }

    console.log(`Bookout: job ${jobId} — whatIsIt="${job.whatIsIt}", hhRef="${job.hhRef}", type="${job.type}"`)

    // Must have a HireHop reference
    // Strip any leading '#' or whitespace (Monday column may store "#12345")
    const hhRef = job.hhRef?.replace(/^#?\s*/, '').trim()
    if (!hhRef) {
      return NextResponse.json(
        { success: false, error: `No HireHop job reference found for this job (raw hhRef: "${job.hhRef}")` },
        { status: 400 }
      )
    }

    const secret = process.env.FREELANCER_HUB_SECRET
    if (!secret) {
      console.error('FREELANCER_HUB_SECRET is not configured')
      return NextResponse.json(
        { success: false, error: 'Book-out is not configured' },
        { status: 500 }
      )
    }

    const vehicleAppUrl = process.env.VEHICLE_APP_URL
    if (!vehicleAppUrl) {
      console.error('VEHICLE_APP_URL is not configured')
      return NextResponse.json(
        { success: false, error: 'Vehicle app URL is not configured' },
        { status: 500 }
      )
    }

    // Generate token: {expiry}.{hhJobNumber}.{driverEmail}.{signature}
    const expiry = Date.now() + 24 * 60 * 60 * 1000 // 24 hours
    const payload = `${expiry}.${hhRef}.${session.email}`
    const signature = createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .substring(0, 32)
    const token = `${payload}.${signature}`

    // Check if this is a van-only book-out (no equipment to follow)
    let vanOnly = false
    try {
      const body = await request.json()
      vanOnly = body.vanOnly === true
    } catch {
      // No body or invalid JSON — default to false
    }

    // Build the return URL (where the driver goes after completing book-out)
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app').replace(/\/$/, '')
    const returnUrl = `${appUrl}/job/${jobId}/complete${vanOnly ? '?vanOnly=true' : ''}`

    // Build the full deep-link URL
    const bookoutUrl = `${vehicleAppUrl.replace(/\/$/, '')}/book-out?freelancerToken=${encodeURIComponent(token)}&returnUrl=${encodeURIComponent(returnUrl)}`

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
