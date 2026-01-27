/**
 * Monday.com Webhook Endpoint - Job Confirmed
 * 
 * POST /api/webhooks/monday/job-confirmed?secret=YOUR_SECRET
 * 
 * Called by Monday.com automation when a job's status changes to
 * "All arranged & email driver" (or similar confirmed status).
 * 
 * Sends confirmation email to the assigned driver (unless muted).
 */

import { NextRequest, NextResponse } from 'next/server'
import { 
  getJobByIdInternal, 
  getFreelancerByEmail,
  getVenueById,
} from '@/lib/monday'
import { sendJobConfirmedNotification } from '@/lib/email'

/**
 * Verify the webhook secret from query params
 */
function verifyWebhookSecret(request: NextRequest): boolean {
  const secret = request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.MONDAY_WEBHOOK_SECRET
  
  if (!expectedSecret) {
    console.error('Webhook (confirmed): MONDAY_WEBHOOK_SECRET not configured')
    return false
  }
  
  return secret === expectedSecret
}

/**
 * Check if freelancer has notifications muted (global mute)
 */
function isGloballyMuted(notificationsPausedUntil: string | undefined): boolean {
  if (!notificationsPausedUntil) return false
  
  try {
    const pausedUntil = new Date(notificationsPausedUntil)
    return pausedUntil > new Date()
  } catch {
    return false
  }
}

/**
 * Check if a specific job is muted by this freelancer
 */
function isJobMuted(mutedJobIds: string | undefined, jobId: string): boolean {
  if (!mutedJobIds) return false
  
  const mutedIds = mutedJobIds.split(',').map(id => id.trim())
  return mutedIds.includes(jobId)
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  console.log('Webhook (confirmed): Received request')
  
  try {
    const body = await request.json()
    
    // Handle Monday's challenge verification
    if (body.challenge) {
      console.log('Webhook (confirmed): Responding to challenge')
      return NextResponse.json({ challenge: body.challenge })
    }
    
    // Verify webhook secret
    if (!verifyWebhookSecret(request)) {
      console.error('Webhook (confirmed): Invalid secret')
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    
    // Extract event data
    const event = body.event
    if (!event?.pulseId) {
      console.error('Webhook (confirmed): No pulseId in payload')
      return NextResponse.json({ success: false, error: 'No item ID' }, { status: 400 })
    }
    
    const itemId = event.pulseId.toString()
    console.log(`Webhook (confirmed): Processing job ${itemId}`)
    
    // Fetch job details
    const job = await getJobByIdInternal(itemId)
    if (!job) {
      console.error(`Webhook (confirmed): Job ${itemId} not found`)
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
    }
    
    // Check driver assigned
    const driverEmail = job.driverEmail
    if (!driverEmail) {
      console.log(`Webhook (confirmed): No driver assigned to job ${itemId}`)
      return NextResponse.json({ success: true, message: 'No driver assigned', skipped: true })
    }
    
    // Fetch freelancer to check mute settings
    const freelancer = await getFreelancerByEmail(driverEmail)
    if (!freelancer) {
      console.error(`Webhook (confirmed): Freelancer ${driverEmail} not found`)
      return NextResponse.json({ success: false, error: 'Freelancer not found' }, { status: 404 })
    }
    
    // Check global mute
    if (isGloballyMuted(freelancer.notificationsPausedUntil)) {
      console.log(`Webhook (confirmed): Skipped - ${driverEmail} has global mute until ${freelancer.notificationsPausedUntil}`)
      return NextResponse.json({
        success: true,
        message: 'Skipped - notifications muted',
        skipped: true,
        mutedUntil: freelancer.notificationsPausedUntil,
      })
    }
    
    // Check per-job mute
    if (isJobMuted(freelancer.mutedJobIds, itemId)) {
      console.log(`Webhook (confirmed): Skipped - job ${itemId} is muted by ${driverEmail}`)
      return NextResponse.json({
        success: true,
        message: 'Skipped - job notifications muted',
        skipped: true,
      })
    }
    
    // Get venue name
    let venueName = job.venueName || job.name
    if (job.venueId) {
      try {
        const venue = await getVenueById(job.venueId)
        if (venue?.name) venueName = venue.name
      } catch (e) {
        console.warn('Webhook (confirmed): Could not fetch venue:', e)
      }
    }
    
    // Send email - NEW SIGNATURE: (email, name, jobDetails)
    console.log(`Webhook (confirmed): Sending email to ${driverEmail}`)
    
    await sendJobConfirmedNotification(
      driverEmail,
      freelancer.name,
      {
        id: itemId,
        name: job.name,
        type: job.type,
        date: job.date || 'TBC',
        time: job.time,
        venue: venueName,
        keyNotes: job.keyNotes,
      }
    )
    
    const duration = Date.now() - startTime
    console.log(`Webhook (confirmed): Sent to ${driverEmail} (${duration}ms)`)
    
    return NextResponse.json({
      success: true,
      message: 'Confirmation sent',
      itemId,
      recipient: driverEmail,
      duration: `${duration}ms`,
    })
    
  } catch (error) {
    console.error('Webhook (confirmed): Error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 200 } // Return 200 to prevent Monday retries
    )
  }
}