/**
 * Multi-Drop Run API Endpoint
 * 
 * GET /api/jobs/run?group=A&date=2026-01-22
 * 
 * Fetches all jobs for the logged-in freelancer that share the same
 * Run Group letter and date (i.e., a multi-drop run).
 * 
 * Query params:
 * - group: The run group letter (A, B, C, D, E)
 * - date: The job date (YYYY-MM-DD format)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobsForFreelancer, getVenueById, JobRecord, VenueRecord } from '@/lib/monday'

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

/**
 * Parse a time string to total minutes for proper numeric sorting
 * Handles both 24-hour format (14:30) and 12-hour format with AM/PM (2:30 PM)
 * e.g., "10:00 AM" -> 600, "09:00 PM" -> 1260
 * Returns 9999 for missing/invalid times to push them to the end
 */
function parseTimeToMinutes(timeStr: string | undefined): number {
  if (!timeStr) return 9999
  
  // Match time with optional AM/PM
  const match = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i)
  if (!match) return 9999
  
  let hours = parseInt(match[1])
  const minutes = parseInt(match[2])
  const period = match[3]?.toUpperCase()
  
  // Convert to 24-hour format if AM/PM is present
  if (period === 'PM' && hours !== 12) {
    hours += 12  // 9 PM → 21
  } else if (period === 'AM' && hours === 12) {
    hours = 0    // 12 AM → 0
  }
  
  return hours * 60 + minutes
}

interface JobWithVenue extends JobRecord {
  venue?: {
    id: string
    name: string
    address?: string
    whatThreeWords?: string
    contact1?: string
    contact2?: string
    phone?: string | null
    phone2?: string | null
    phoneHidden?: boolean
    phoneVisibleFrom?: string | null
    email?: string
    accessNotes?: string
    stageNotes?: string
  } | null
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const runGroup = searchParams.get('group')
    const date = searchParams.get('date')

    // Validate params
    if (!runGroup || !date) {
      return NextResponse.json(
        { success: false, error: 'Missing required parameters: group and date' },
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

    console.log('Run API: Fetching jobs for run group', runGroup, 'on', date, 'for', session.email)

    // Fetch all jobs for this freelancer
    const allJobs = await getJobsForFreelancer(session.email)

    // Filter to jobs matching this run group and date
    const runJobs = allJobs.filter(job => {
      const jobDate = job.date?.split('T')[0] // Normalize to YYYY-MM-DD
      const matchesGroup = job.runGroup?.toUpperCase() === runGroup.toUpperCase()
      const matchesDate = jobDate === date
      return matchesGroup && matchesDate
    })

    console.log('Run API: Found', runJobs.length, 'jobs in run')

    if (runJobs.length === 0) {
      return NextResponse.json(
        { success: false, error: 'No jobs found for this run' },
        { status: 404 }
      )
    }

    // Sort jobs by time (numeric comparison with AM/PM handling)
    runJobs.sort((a, b) => parseTimeToMinutes(a.time) - parseTimeToMinutes(b.time))

    // Fetch venue details for each job
    const contactsVisible = isWithin48Hours(date)
    const contactVisibleFrom = !contactsVisible ? getContactVisibleDate(date) : null

    const jobsWithVenues: JobWithVenue[] = await Promise.all(
      runJobs.map(async (job) => {
        let venue: VenueRecord | null = null
        if (job.venueId) {
          venue = await getVenueById(job.venueId)
        }

        // Apply 48-hour privacy rule
        const venueDetails = venue ? {
          id: venue.id,
          name: venue.name,
          address: venue.address,
          whatThreeWords: venue.whatThreeWords,
          contact1: venue.contact1,
          contact2: venue.contact2,
          phone: contactsVisible ? venue.phone : null,
          phone2: contactsVisible ? venue.phone2 : null,
          phoneHidden: !contactsVisible,
          phoneVisibleFrom: contactVisibleFrom,
          email: venue.email,
          accessNotes: venue.accessNotes,
          stageNotes: venue.stageNotes,
        } : null

        return {
          ...job,
          venue: venueDetails,
        }
      })
    )

    // Calculate total fee for the run
    const totalFee = runJobs.reduce((sum, job) => sum + (job.driverPay || 0), 0)

    return NextResponse.json({
      success: true,
      runGroup,
      date,
      jobs: jobsWithVenues,
      jobCount: jobsWithVenues.length,
      totalFee,
      contactsVisible,
    })

  } catch (error) {
    console.error('Run API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch run jobs' },
      { status: 500 }
    )
  }
}