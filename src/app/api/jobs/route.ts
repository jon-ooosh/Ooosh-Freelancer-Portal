/**
 * Jobs API Endpoint
 * 
 * GET /api/jobs
 * 
 * Fetches all jobs for the logged-in freelancer from Monday.com,
 * including both D&C (Delivery & Collection) jobs and Crewed Jobs.
 * Filters by visibility rules, and organises them into categories:
 * - today: jobs scheduled for today
 * - upcoming: future jobs (next 30 days)
 * - completed: finished jobs (last 30 days)
 * - cancelled: cancelled jobs (last 30 days)
 * 
 * Multi-drop runs (same date + Run Group) are grouped together (D&C only).
 * Crew jobs are always displayed individually (no run grouping).
 */

import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobsForFreelancer, JobRecord, getCrewJobsForFreelancer, CrewJobRecord } from '@/lib/monday'

// =============================================================================
// TYPES
// =============================================================================

interface OrganisedJob {
  id: string
  name: string
  board: 'dc' | 'crew'
  type: 'delivery' | 'collection'
  date: string
  finishDate?: string           // For multi-day crew jobs
  time?: string
  venueName?: string
  driverPay?: number
  runGroup?: string
  hhRef?: string
  keyNotes?: string
  completedAtDate?: string
  // Crew job specific fields
  workType?: string             // e.g. "BACKLINE TECH", or work description if "Other"
  workDurationHours?: number    // Hours of on-site work
  numberOfDays?: number         // For multi-day jobs
  jobType?: string              // "Driving + Crew" or "Crew Only"
}

interface GroupedRun {
  isGrouped: true
  runGroup: string
  date: string
  jobs: OrganisedJob[]
  totalFee: number
  jobCount: number
}

interface SingleJob extends OrganisedJob {
  isGrouped: false
}

type DisplayItem = GroupedRun | SingleJob

interface JobsApiResponse {
  success: boolean
  user?: {
    id: string
    name: string
    email: string
  }
  today?: DisplayItem[]
  upcoming?: DisplayItem[]
  completed?: DisplayItem[]
  cancelled?: DisplayItem[]
  error?: string
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Parse a date string and return a Date object (midnight local time)
 */
function parseJobDate(dateStr: string | undefined): Date | null {
  if (!dateStr) return null
  
  // Monday.com dates come as "YYYY-MM-DD" or similar
  const parsed = new Date(dateStr)
  if (isNaN(parsed.getTime())) return null
  
  return parsed
}

/**
 * Check if a date is today
 */
function isToday(date: Date): boolean {
  const today = new Date()
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  )
}

/**
 * Check if a date is in the future (after today)
 */
function isFuture(date: Date): boolean {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const compareDate = new Date(date)
  compareDate.setHours(0, 0, 0, 0)
  return compareDate > today
}

/**
 * Check if a date is within the last N days
 */
function isWithinLastDays(date: Date, days: number): boolean {
  const now = new Date()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return date >= cutoff && date <= now
}

/**
 * Check if a date is within the next N days
 */
function isWithinNextDays(date: Date, days: number): boolean {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const cutoff = new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
  return date >= now && date <= cutoff
}

/**
 * Map Monday.com status to our visibility/category rules
 * Returns: 'upcoming' | 'completed' | 'cancelled' | null (hidden)
 * 
 * Works for BOTH D&C and Crew job statuses:
 * - D&C: "All arranged & email driver" → upcoming
 * - Crew: "All arranged & email crew" → upcoming
 * - Both: "Working on it" → upcoming
 * - Both: "All done!" → completed
 * - Both: "Now not needed" → cancelled
 * - Both: "TO DO!" → null (hidden from freelancers)
 * 
 * Note: Uses includes() for flexible matching across both boards.
 */
function getJobCategory(status: string): 'upcoming' | 'completed' | 'cancelled' | null {
  const normalised = status.toLowerCase().trim()
  
  // Visible statuses - using includes() for flexible matching
  // "All arranged & email driver" and "All arranged & email crew" both contain "arranged"
  // "Working on it" matches exactly
  if (normalised.includes('arranged') || normalised.includes('working on it')) {
    return 'upcoming'
  }
  
  // "All done" or "All done!" - completed jobs
  if (normalised.includes('all done') || normalised.includes('done')) {
    return 'completed'
  }
  
  // "Now not needed" - cancelled jobs
  if (normalised.includes('not needed') || normalised.includes('cancelled')) {
    return 'cancelled'
  }
  
  // Hidden statuses (TO DO!, Arranging, TBC, etc.)
  return null
}

/**
 * Convert a D&C JobRecord from Monday to our display format
 */
function toOrganisedJob(job: JobRecord): OrganisedJob {
  return {
    id: job.id,
    name: job.name,
    board: 'dc',
    type: job.type,
    date: job.date || '',
    time: job.time,
    venueName: job.venueName,
    driverPay: job.driverPay,
    runGroup: job.runGroup,
    hhRef: job.hhRef,
    keyNotes: job.keyNotes,
    completedAtDate: job.completedAtDate,
  }
}

/**
 * Convert a Crew JobRecord from Monday to our display format
 * 
 * Key differences from D&C:
 * - Uses workType as the display title (not delivery/collection)
 * - If workType is "Other", falls back to workDescription
 * - Translates jobType for freelancer-friendly display
 * - Maps freelancerFee → driverPay for unified fee display
 * - No runGroup (crew jobs don't participate in multi-drop grouping)
 */
function toOrganisedCrewJob(job: CrewJobRecord): OrganisedJob {
  // Determine display work type — if "Other", use the work description instead
  let displayWorkType = job.workType || 'Crew Work'
  if (displayWorkType.toLowerCase() === 'other' && job.workDescription) {
    displayWorkType = job.workDescription
  }
  
  // Translate job type for freelancer-friendly display
  // "Transport + Crew" → "Driving + Crew"
  // "Crew Only" stays as-is
  let displayJobType = job.jobType || ''
  if (displayJobType.toLowerCase().includes('transport')) {
    displayJobType = 'Driving + Crew'
  }
  
  return {
    id: job.id,
    name: job.name,
    board: 'crew',
    type: 'delivery',             // Placeholder — not used for crew job rendering
    date: job.date || '',
    finishDate: job.finishDate,
    time: job.time,
    venueName: job.destination,   // Venue name from destination text column
    driverPay: job.freelancerFee, // Map to same field for unified fee display
    hhRef: job.hhRef,
    completedAtDate: undefined,   // Crew jobs don't have enforced completion
    // Crew-specific fields
    workType: displayWorkType,
    workDurationHours: job.workDurationHours,
    numberOfDays: job.numberOfDays,
    jobType: displayJobType,
  }
}

/**
 * Group jobs by Run Group (for multi-drop runs)
 * Jobs with the same date AND Run Group are combined.
 * 
 * Note: Only D&C jobs participate in run grouping.
 * Crew jobs are always passed through as individual items.
 */
function groupJobs(jobs: OrganisedJob[]): DisplayItem[] {
  const result: DisplayItem[] = []
  const groupMap = new Map<string, OrganisedJob[]>()
  
  for (const job of jobs) {
    // Crew jobs are always displayed individually (no run grouping)
    // D&C jobs without a Run Group are also displayed individually
    if (job.board === 'crew' || !job.runGroup) {
      result.push({ ...job, isGrouped: false })
      continue
    }
    
    // Create a key from date + runGroup
    const groupKey = `${job.date}|${job.runGroup}`
    
    if (!groupMap.has(groupKey)) {
      groupMap.set(groupKey, [])
    }
    groupMap.get(groupKey)!.push(job)
  }
  
  // Convert grouped jobs into GroupedRun objects
  // Using Array.from() for TypeScript compatibility
  Array.from(groupMap.entries()).forEach(([key, groupedJobs]) => {
    if (groupedJobs.length === 1) {
      // Single job in a group - display as individual
      result.push({ ...groupedJobs[0], isGrouped: false })
    } else {
      // Multiple jobs - create a grouped run
      const [date, runGroup] = key.split('|')
      const totalFee = groupedJobs.reduce((sum, j) => sum + (j.driverPay || 0), 0)
      
      // Sort jobs within the group by time
      groupedJobs.sort((a, b) => {
        if (!a.time) return 1
        if (!b.time) return -1
        return a.time.localeCompare(b.time)
      })
      
      result.push({
        isGrouped: true,
        runGroup,
        date,
        jobs: groupedJobs,
        totalFee,
        jobCount: groupedJobs.length,
      })
    }
  })
  
  // Sort by date, then by time
  result.sort((a, b) => {
    const dateA = a.isGrouped ? a.date : a.date
    const dateB = b.isGrouped ? b.date : b.date
    
    if (dateA !== dateB) {
      return dateA.localeCompare(dateB)
    }
    
    // If same date, sort by time (grouped runs use first job's time)
    const timeA = a.isGrouped ? a.jobs[0]?.time : a.time
    const timeB = b.isGrouped ? b.jobs[0]?.time : b.time
    
    if (!timeA) return 1
    if (!timeB) return -1
    return timeA.localeCompare(timeB)
  })
  
  return result
}

// =============================================================================
// API HANDLER
// =============================================================================

export async function GET(): Promise<NextResponse<JobsApiResponse>> {
  const startTime = Date.now()
  console.log('Jobs API: Starting request')
  
  try {
    // Get the logged-in user from session
    const user = await getSessionUser()
    console.log('Jobs API: Session check took', Date.now() - startTime, 'ms')
    
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'Authentication required' },
        { status: 401 }
      )
    }
    
    console.log('Jobs API: Fetching jobs for', user.email)
    
    // Fetch D&C jobs and Crew jobs in parallel
    // Crew job fetch is wrapped in try/catch so D&C jobs still load
    // even if the crew board isn't configured or has issues
    const mondayStart = Date.now()
    let dcJobs: JobRecord[] = []
    let crewJobs: CrewJobRecord[] = []
    
    try {
      const [dcResult, crewResult] = await Promise.all([
        getJobsForFreelancer(user.email).catch(err => {
          console.error('D&C jobs fetch failed:', err)
          return [] as JobRecord[]
        }),
        getCrewJobsForFreelancer(user.email).catch(err => {
          console.error('Crew jobs fetch failed (non-critical):', err)
          return [] as CrewJobRecord[]
        }),
      ])
      
      dcJobs = dcResult
      crewJobs = crewResult
      
      console.log('Jobs API: Monday queries took', Date.now() - mondayStart, 'ms')
      console.log('Jobs API: Found', dcJobs.length, 'D&C jobs and', crewJobs.length, 'crew jobs')
    } catch (mondayError) {
      console.error('Monday API error after', Date.now() - mondayStart, 'ms:', mondayError)
      return NextResponse.json(
        { success: false, error: 'Failed to fetch jobs from Monday.com' },
        { status: 502 }
      )
    }
    
    // Categorise jobs
    const todayJobs: OrganisedJob[] = []
    const upcomingJobs: OrganisedJob[] = []
    const completedJobs: OrganisedJob[] = []
    const cancelledJobs: OrganisedJob[] = []
    
    // Process D&C jobs
    for (const job of dcJobs) {
      console.log('Jobs API: Processing D&C job', job.id, '- status:', job.status, '- date:', job.date)
      
      const category = getJobCategory(job.status)
      
      if (category === null) {
        console.log('Jobs API: D&C job', job.id, 'hidden (status not matched):', job.status)
        continue
      }
      
      const jobDate = parseJobDate(job.date)
      const organisedJob = toOrganisedJob(job)
      
      if (category === 'completed') {
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          completedJobs.push(organisedJob)
        }
      } else if (category === 'cancelled') {
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          cancelledJobs.push(organisedJob)
        }
      } else if (category === 'upcoming') {
        if (jobDate) {
          if (isToday(jobDate)) {
            todayJobs.push(organisedJob)
          } else if (isFuture(jobDate) && isWithinNextDays(jobDate, 30)) {
            upcomingJobs.push(organisedJob)
          }
        }
      }
    }
    
    // Process Crew jobs (same categorisation logic)
    for (const job of crewJobs) {
      console.log('Jobs API: Processing Crew job', job.id, '- status:', job.status, '- date:', job.date)
      
      const category = getJobCategory(job.status)
      
      if (category === null) {
        console.log('Jobs API: Crew job', job.id, 'hidden (status not matched):', job.status)
        continue
      }
      
      const jobDate = parseJobDate(job.date)
      const organisedJob = toOrganisedCrewJob(job)
      
      if (category === 'completed') {
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          completedJobs.push(organisedJob)
        }
      } else if (category === 'cancelled') {
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          cancelledJobs.push(organisedJob)
        }
      } else if (category === 'upcoming') {
        if (jobDate) {
          if (isToday(jobDate)) {
            todayJobs.push(organisedJob)
          } else if (isFuture(jobDate) && isWithinNextDays(jobDate, 30)) {
            upcomingJobs.push(organisedJob)
          }
        }
      }
    }
    
    // Group multi-drop runs and sort
    // (Crew jobs pass through groupJobs as individual items)
    const today = groupJobs(todayJobs)
    const upcoming = groupJobs(upcomingJobs)
    const completed = groupJobs(completedJobs)
    const cancelled = groupJobs(cancelledJobs)
    
    console.log('Jobs API: Total request took', Date.now() - startTime, 'ms')
    
    return NextResponse.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
      today,
      upcoming,
      completed,
      cancelled,
    })
    
  } catch (error) {
    console.error('Jobs API error after', Date.now() - startTime, 'ms:', error)
    return NextResponse.json(
      { success: false, error: 'An error occurred while fetching jobs' },
      { status: 500 }
    )
  }
}