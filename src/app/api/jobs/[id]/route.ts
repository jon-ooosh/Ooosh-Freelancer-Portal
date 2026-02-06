/**
 * Single Job API Endpoint
 * 
 * GET /api/jobs/[id] - Fetch a specific job by Monday.com item ID
 * 
 * Supports both D&C jobs and Crew jobs:
 * - Default (no query param): Fetches from D&C board
 * - ?board=crew: Fetches from Crewed Jobs board
 * 
 * Returns job details including venue information if the logged-in user is assigned to it.
 * Security: Users can only view jobs assigned to them.
 * Privacy: Contact phone numbers are only visible within 48 hours of the job date.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobById, getCrewJobById, getVenueById, VenueRecord } from '@/lib/monday'

/**
 * Check if a date is within 48 hours of now (before or after)
 * Used to implement the privacy rule for contact phone numbers
 */
function isWithin48Hours(jobDateStr: string | undefined): boolean {
  if (!jobDateStr) return false
  
  const jobDate = new Date(jobDateStr)
  if (isNaN(jobDate.getTime())) return false
  
  const now = new Date()
  const hoursDiff = Math.abs(now.getTime() - jobDate.getTime()) / (1000 * 60 * 60)
  
  return hoursDiff <= 48
}

/**
 * Calculate when contact info will become visible
 */
function getContactVisibleDate(jobDateStr: string | undefined): string | null {
  if (!jobDateStr) return null
  
  const jobDate = new Date(jobDateStr)
  if (isNaN(jobDate.getTime())) return null
  
  // Contact becomes visible 48 hours before the job
  const visibleDate = new Date(jobDate.getTime() - (48 * 60 * 60 * 1000))
  
  return visibleDate.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Get the job ID from the URL
    const { id: jobId } = await params

    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'Job ID is required' },
        { status: 400 }
      )
    }

    // Check for board type in query params
    const searchParams = request.nextUrl.searchParams
    const boardType = searchParams.get('board') || 'dc'

    // Check session
    const session = await getSessionUser()
    
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Not authenticated' },
        { status: 401 }
      )
    }

    console.log('Job API: Fetching', boardType, 'job', jobId, 'for user', session.email)

    // Fetch the job from the appropriate Monday.com board
    let job: Awaited<ReturnType<typeof getJobById>> | Awaited<ReturnType<typeof getCrewJobById>> = null

    if (boardType === 'crew') {
      job = await getCrewJobById(jobId, session.email)
    } else {
      job = await getJobById(jobId, session.email)
    }

    if (!job) {
      return NextResponse.json(
        { success: false, error: 'Job not found or not assigned to you' },
        { status: 404 }
      )
    }

    // Fetch venue details if we have a venue ID
    // Both D&C and Crew jobs can have a venueId from their connect columns
    let venue: VenueRecord | null = null
    if (job.venueId) {
      console.log('Job API: Fetching venue', job.venueId)
      venue = await getVenueById(job.venueId)
    }

    // Apply 48-hour privacy rule for contact phone numbers
    const jobDate = job.date
    const contactsVisible = isWithin48Hours(jobDate)
    const contactVisibleFrom = !contactsVisible ? getContactVisibleDate(jobDate) : null

    // Build the response with venue details
    // Phone numbers are redacted if outside the 48-hour window
    const venueDetails = venue ? {
      id: venue.id,
      name: venue.name,
      address: venue.address,
      whatThreeWords: venue.whatThreeWords,
      contact1: venue.contact1,
      contact2: venue.contact2,
      // Only include phones if within 48-hour window
      phone: contactsVisible ? venue.phone : null,
      phone2: contactsVisible ? venue.phone2 : null,
      phoneHidden: !contactsVisible,
      phoneVisibleFrom: contactVisibleFrom,
      email: venue.email,
      accessNotes: venue.accessNotes,
      stageNotes: venue.stageNotes,
      // Include files (array of {assetId, name})
      files: venue.files || [],
    } : null

    return NextResponse.json({
      success: true,
      job,
      venue: venueDetails,
      contactsVisible,
      boardType,
    })

  } catch (error) {
    console.error('Job API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch job' },
      { status: 500 }
    )
  }
}