/**
 * Monday.com Webhook Endpoint - Job Confirmed
 * 
 * POST /api/webhooks/monday/job-confirmed?secret=YOUR_SECRET
 * 
 * Called by Monday.com automation when a job's status changes to
 * "All arranged & email driver" (or similar).
 * 
 * This endpoint:
 * 1. Handles Monday's challenge verification (required for webhook setup)
 * 2. Verifies the webhook secret for security
 * 3. Extracts the job (pulse) ID from the event
 * 4. Fetches job details from Monday
 * 5. Looks up the driver's name from Freelance Crew board
 * 6. Sends notification email to the assigned driver
 * 
 * Security:
 * - Webhook secret must match MONDAY_WEBHOOK_SECRET env var
 * - Without valid secret, returns 401 Unauthorized
 * 
 * Monday Webhook Payload Structure (status change):
 * {
 *   "event": {
 *     "pulseId": 123456789,        // Item ID
 *     "boardId": 987654321,        // Board ID
 *     "pulseName": "Job Name",     // Item name
 *     "columnId": "status90",      // Column that changed
 *     "value": { "label": { "text": "All arranged..." } },
 *     "previousValue": { "label": { "text": "Arranging" } },
 *     "type": "update_column_value"
 *   }
 * }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getJobByIdInternal, getFreelancerNameByEmail } from '@/lib/monday'
import { sendJobConfirmedNotification } from '@/lib/email'

/**
 * Verify the webhook secret from query params
 */
function verifyWebhookSecret(request: NextRequest): boolean {
  const secret = request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.MONDAY_WEBHOOK_SECRET
  
  if (!expectedSecret) {
    console.error('Webhook: MONDAY_WEBHOOK_SECRET environment variable not configured')
    return false
  }
  
  if (!secret) {
    console.error('Webhook: No secret provided in request')
    return false
  }
  
  return secret === expectedSecret
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  console.log('Webhook: Received request')
  
  try {
    const body = await request.json()
    
    // ===========================================
    // STEP 1: Handle Monday's challenge verification
    // ===========================================
    // When setting up the webhook in Monday, it sends a challenge
    // that we must echo back to verify we control this endpoint.
    // This happens BEFORE the webhook is active, so no auth needed.
    if (body.challenge) {
      console.log('Webhook: Responding to Monday challenge verification')
      return NextResponse.json({ challenge: body.challenge })
    }
    
    // ===========================================
    // STEP 2: Verify webhook secret
    // ===========================================
    // All actual webhook calls (not challenges) must have valid secret
    if (!verifyWebhookSecret(request)) {
      console.error('Webhook: Invalid or missing secret - rejecting request')
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      )
    }
    
    // ===========================================
    // STEP 3: Extract event data
    // ===========================================
    const event = body.event
    
    if (!event) {
      console.error('Webhook: No event object in payload')
      return NextResponse.json(
        { success: false, error: 'No event data' },
        { status: 400 }
      )
    }
    
    // pulseId is Monday's internal name for item ID
    const itemId = event.pulseId?.toString()
    const boardId = event.boardId?.toString()
    const itemName = event.pulseName || 'Unknown'
    
    if (!itemId) {
      console.error('Webhook: No pulseId in event payload')
      return NextResponse.json(
        { success: false, error: 'No item ID in payload' },
        { status: 400 }
      )
    }
    
    console.log(`Webhook: Processing job confirmed for item ${itemId} (${itemName}) on board ${boardId}`)
    
    // ===========================================
    // STEP 4: Fetch full job details from Monday
    // ===========================================
    // The webhook only gives us the item ID - we need to fetch
    // the full job details including venue, date, time, etc.
    const job = await getJobByIdInternal(itemId)
    
    if (!job) {
      console.error(`Webhook: Job ${itemId} not found in Monday`)
      return NextResponse.json(
        { success: false, error: 'Job not found' },
        { status: 404 }
      )
    }
    
    console.log(`Webhook: Job fetched - ${job.type} to ${job.venueName} on ${job.date}`)
    
    // ===========================================
    // STEP 5: Get driver email and name
    // ===========================================
    const driverEmail = job.driverEmail
    
    if (!driverEmail) {
      console.error(`Webhook: No driver email assigned to job ${itemId}`)
      return NextResponse.json(
        { success: false, error: 'No driver assigned to job' },
        { status: 400 }
      )
    }
    
    // Look up driver's name from Freelance Crew board for personalization
    let driverName: string | null = null
    try {
      driverName = await getFreelancerNameByEmail(driverEmail)
      console.log(`Webhook: Driver name resolved: ${driverName || '(not found)'}`)
    } catch (nameError) {
      // Non-fatal - we can still send email without the name
      console.warn('Webhook: Could not look up driver name:', nameError)
    }
    
    // ===========================================
    // STEP 6: Send notification email
    // ===========================================
    console.log(`Webhook: Sending job confirmed email to ${driverEmail}`)
    
    await sendJobConfirmedNotification(
      driverEmail,
      {
        venueName: job.venueName || job.name,
        date: job.date || 'TBC',
        time: job.time,
        type: job.type,
      },
      driverName || undefined
    )
    
    const duration = Date.now() - startTime
    console.log(`Webhook: Email sent successfully to ${driverEmail} (${duration}ms)`)
    
    return NextResponse.json({
      success: true,
      message: 'Notification sent',
      itemId,
      recipient: driverEmail,
      duration: `${duration}ms`,
    })
    
  } catch (error) {
    const duration = Date.now() - startTime
    console.error(`Webhook: Error after ${duration}ms:`, error)
    
    // Return 200 even on error to prevent Monday from retrying
    // (we've logged it, and retrying likely won't help)
    return NextResponse.json(
      { 
        success: false, 
        error: error instanceof Error ? error.message : 'Internal server error',
        duration: `${duration}ms`,
      },
      { status: 200 } // Return 200 to acknowledge receipt
    )
  }
}