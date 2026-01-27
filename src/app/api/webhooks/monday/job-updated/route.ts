/**
 * Monday.com Webhook Endpoint - Job Updated
 * 
 * POST /api/webhooks/monday/job-updated?secret=YOUR_SECRET
 * 
 * Called by Monday.com automation when a job's date, time, or venue changes.
 * 
 * IMPORTANT: Only sends notifications if job status is "Arranged" (confirmed).
 * This prevents spam while the job is still being set up.
 * 
 * Set up 3 Monday automations pointing to this endpoint:
 * 1. When Date (date4) changes → trigger webhook
 * 2. When Time (hour) changes → trigger webhook  
 * 3. When Venue (connect_boards6) changes → trigger webhook
 */

import { NextRequest, NextResponse } from 'next/server'
import { 
  getJobByIdInternal, 
  getFreelancerByEmail,
  getVenueById,
} from '@/lib/monday'
import { sendJobUpdatedNotification } from '@/lib/email'

// Column IDs we care about for "job updated" notifications
const WATCHED_COLUMNS = {
  date: 'date4',
  time: 'hour',
  venue: 'connect_boards6',
}

// Status values that mean "job is confirmed"
const CONFIRMED_STATUSES = [
  'all arranged & email driver',
  'arranged',
  'working on it',
]

/**
 * Verify the webhook secret from query params
 */
function verifyWebhookSecret(request: NextRequest): boolean {
  const secret = request.nextUrl.searchParams.get('secret')
  const expectedSecret = process.env.MONDAY_WEBHOOK_SECRET
  
  if (!expectedSecret) {
    console.error('Webhook (updated): MONDAY_WEBHOOK_SECRET not configured')
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

/**
 * Check if the job status indicates it's confirmed/arranged
 */
function isJobConfirmed(status: string): boolean {
  const normalizedStatus = status.toLowerCase().trim()
  return CONFIRMED_STATUSES.some(s => normalizedStatus.includes(s))
}

/**
 * Determine which field changed based on the column ID in the event
 */
function getChangedField(columnId: string): string | null {
  if (columnId === WATCHED_COLUMNS.date) return 'date'
  if (columnId === WATCHED_COLUMNS.time) return 'time'
  if (columnId === WATCHED_COLUMNS.venue) return 'venue'
  return null
}

export async function POST(request: NextRequest) {
  const startTime = Date.now()
  console.log('Webhook (updated): Received request')
  
  try {
    const body = await request.json()
    
    // Handle Monday's challenge verification
    if (body.challenge) {
      console.log('Webhook (updated): Responding to challenge')
      return NextResponse.json({ challenge: body.challenge })
    }
    
    // Verify webhook secret
    if (!verifyWebhookSecret(request)) {
      console.error('Webhook (updated): Invalid secret')
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    
    // Extract event data
    const event = body.event
    if (!event?.pulseId) {
      console.error('Webhook (updated): No pulseId in payload')
      return NextResponse.json({ success: false, error: 'No item ID' }, { status: 400 })
    }
    
    const itemId = event.pulseId.toString()
    const columnId = event.columnId
    
    // Determine what changed
    const changedField = getChangedField(columnId)
    if (!changedField) {
      console.log(`Webhook (updated): Ignoring change to column ${columnId} - not a watched field`)
      return NextResponse.json({ 
        success: true, 
        message: 'Column not watched',
        skipped: true,
        columnId 
      })
    }
    
    console.log(`Webhook (updated): Processing job ${itemId} - ${changedField} changed`)
    
    // Fetch job details
    const job = await getJobByIdInternal(itemId)
    if (!job) {
      console.error(`Webhook (updated): Job ${itemId} not found`)
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
    }
    
    // Only notify if job is in "confirmed" status
    if (!isJobConfirmed(job.status)) {
      console.log(`Webhook (updated): Skipped - job ${itemId} not yet confirmed (status: ${job.status})`)
      return NextResponse.json({
        success: true,
        message: 'Job not yet confirmed - no notification needed',
        skipped: true,
        status: job.status,
      })
    }
    
    // Check driver assigned
    const driverEmail = job.driverEmail
    if (!driverEmail) {
      console.log(`Webhook (updated): No driver assigned to job ${itemId}`)
      return NextResponse.json({ success: true, message: 'No driver assigned', skipped: true })
    }
    
    // Fetch freelancer to check mute settings
    const freelancer = await getFreelancerByEmail(driverEmail)
    if (!freelancer) {
      console.error(`Webhook (updated): Freelancer ${driverEmail} not found`)
      return NextResponse.json({ success: false, error: 'Freelancer not found' }, { status: 404 })
    }
    
    // Check global mute
    if (isGloballyMuted(freelancer.notificationsPausedUntil)) {
      console.log(`Webhook (updated): Skipped - ${driverEmail} has global mute until ${freelancer.notificationsPausedUntil}`)
      return NextResponse.json({
        success: true,
        message: 'Skipped - notifications muted',
        skipped: true,
        mutedUntil: freelancer.notificationsPausedUntil,
      })
    }
    
    // Check per-job mute
    if (isJobMuted(freelancer.mutedJobIds, itemId)) {
      console.log(`Webhook (updated): Skipped - job ${itemId} is muted by ${driverEmail}`)
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
        console.warn('Webhook (updated): Could not fetch venue:', e)
      }
    }
    
    // Send email - NEW SIGNATURE: (email, name, jobDetails)
    console.log(`Webhook (updated): Sending email to ${driverEmail} (${changedField} changed)`)
    
    await sendJobUpdatedNotification(
      driverEmail,
      freelancer.name,
      {
        id: itemId,
        name: job.name,
        type: job.type,
        date: job.date || 'TBC',
        time: job.time,
        venue: venueName,
      }
    )
    
    const duration = Date.now() - startTime
    console.log(`Webhook (updated): Sent to ${driverEmail} (${duration}ms)`)
    
    return NextResponse.json({
      success: true,
      message: 'Update notification sent',
      itemId,
      recipient: driverEmail,
      changedField,
      duration: `${duration}ms`,
    })
    
  } catch (error) {
    console.error('Webhook (updated): Error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Error' },
      { status: 200 } // Return 200 to prevent Monday retries
    )
  }
}