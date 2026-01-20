/**
 * Jobs API Endpoint
 * 
 * GET /api/jobs
 * 
 * Fetches all jobs for the logged-in freelancer from Monday.com,
 * filters by visibility rules, and organises them into categories:
 * - today: jobs scheduled for today
 * - upcoming: future jobs (next 30 days)
 * - completed: finished jobs (last 30 days)
 * - cancelled: cancelled jobs (last 30 days)
 * 
 * Multi-drop runs (same date + Run Group) are grouped together.
 */

import { NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobsForFreelancer, JobRecord } from '@/lib/monday'

// =============================================================================
// TYPES
// =============================================================================

interface OrganisedJob {
  id: string
  name: string
  type: 'delivery' | 'collection'
  date: string
  time?: string
  venueName?: string
  agreedFee?: number
  runGroup?: string
  hhRef?: string
  keyNotes?: string
  completedAtDate?: string  // Added for dashboard to know if job is completed
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
 * Note: Monday status values may vary (e.g., "All arranged & email driver" 
 * instead of just "Arranged"), so we use flexible matching.
 */
function getJobCategory(status: string): 'upcoming' | 'completed' | 'cancelled' | null {
  const normalised = status.toLowerCase().trim()
  
  // Visible statuses - using includes() for flexible matching
  // "All arranged & email driver" contains "arranged"
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
  
  // Hidden statuses (TO DO, Arranging, etc.)
  return null
}

/**
 * Convert a JobRecord from Monday to our display format
 */
function toOrganisedJob(job: JobRecord): OrganisedJob {
  return {
    id: job.id,
    name: job.name,
    type: job.type,
    date: job.date || '',
    time: job.time,
    venueName: job.venueName,
    agreedFee: job.agreedFeeOverride,
    runGroup: job.runGroup,
    hhRef: job.hhRef,
    keyNotes: job.keyNotes,
    completedAtDate: job.completedAtDate,  // Pass through for dashboard
  }
}

/**
 * Group jobs by Run Group (for multi-drop runs)
 * Jobs with the same date AND Run Group are combined
 */
function groupJobs(jobs: OrganisedJob[]): DisplayItem[] {
  const result: DisplayItem[] = []
  const groupMap = new Map<string, OrganisedJob[]>()
  
  for (const job of jobs) {
    // Jobs without a Run Group are displayed individually
    if (!job.runGroup) {
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
      const totalFee = groupedJobs.reduce((sum, j) => sum + (j.agreedFee || 0), 0)
      
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
    
    // Fetch all jobs for this freelancer from Monday
    let allJobs: JobRecord[]
    const mondayStart = Date.now()
    try {
      allJobs = await getJobsForFreelancer(user.email)
      console.log('Jobs API: Monday query took', Date.now() - mondayStart, 'ms, found', allJobs.length, 'jobs')
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
    
    for (const job of allJobs) {
      // DEBUG: Log each job's key fields
      console.log('Jobs API: Processing job', job.id, '- status:', job.status, '- date:', job.date)
      
      // Determine category based on status
      const category = getJobCategory(job.status)
      
      // Skip hidden jobs
      if (category === null) {
        console.log('Jobs API: Job', job.id, 'hidden (status not matched):', job.status)
        continue
      }
      
      const jobDate = parseJobDate(job.date)
      const organisedJob = toOrganisedJob(job)
      
      // DEBUG: Log date parsing
      console.log('Jobs API: Job', job.id, '- category:', category, '- parsed date:', jobDate, '- isToday:', jobDate ? isToday(jobDate) : 'N/A')
      
      if (category === 'completed') {
        // Completed jobs - show last 30 days
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          completedJobs.push(organisedJob)
        }
      } else if (category === 'cancelled') {
        // Cancelled jobs - show last 30 days
        if (jobDate && isWithinLastDays(jobDate, 30)) {
          cancelledJobs.push(organisedJob)
        }
      } else if (category === 'upcoming') {
        // Active jobs - categorise by date
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
