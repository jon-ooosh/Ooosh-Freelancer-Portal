/**
 * Jobs API Endpoint
 *
 * GET /api/jobs
 *
 * Fetches all jobs for the logged-in freelancer from the OP backend,
 * organised into categories (today / upcoming / completed / cancelled).
 *
 * Multi-drop runs (same date + Run Group) are grouped together (D&C only).
 * Crew jobs are always displayed individually (no run grouping).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { getJobsFromOP, isOpClientError, OpApiError } from '@/lib/op-api'

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
  // Combined run fees from OP. When set, groupJobs uses these instead
  // of summing individual driverPay values — the combined fee is what
  // the freelancer is actually being paid for the whole run.
  runCombinedFreelancerFee?: number | null
  runCombinedClientFee?: number | null
  runNotes?: string | null
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
  // totalFee is what the freelancer is being paid for the entire run.
  // Prefers runCombinedFreelancerFee (single contractual figure agreed
  // with staff) over the sum of individual driverPay values.
  totalFee: number
  // True when totalFee came from the OP combined fee override rather
  // than summing individual fees — used by the UI to hint "combined".
  hasCombinedFee?: boolean
  // Sum of individual driverPay values, so the UI can show the
  // standalone total struck through next to the combined fee.
  standaloneTotalFee?: number
  runNotes?: string | null
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
      const standaloneTotalFee = groupedJobs.reduce((sum, j) => sum + (j.driverPay || 0), 0)
      // Prefer the OP combined fee when set (it's what the freelancer
      // was actually offered for the run — e.g. "£50 all-in" instead
      // of £30 + £30). Every sibling carries the same combined fee.
      const combinedFee = groupedJobs.find((j) => j.runCombinedFreelancerFee != null)?.runCombinedFreelancerFee
      const totalFee = combinedFee != null ? combinedFee : standaloneTotalFee
      const runNotes = groupedJobs.find((j) => j.runNotes)?.runNotes ?? null

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
        hasCombinedFee: combinedFee != null,
        standaloneTotalFee,
        runNotes,
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

export async function GET(request: NextRequest): Promise<NextResponse<JobsApiResponse>> {
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

    console.log('Jobs API: Using OP backend for', user.email)
    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Session token missing' },
        { status: 401 }
      )
    }

    try {
      const opData = await getJobsFromOP(sessionToken)
      console.log('Jobs API: OP backend took', Date.now() - startTime, 'ms')

      // The OP portal API returns flat jobs (not grouped).
      // Apply the run-grouping logic before returning.
      const groupedToday = groupJobs((opData.today || []) as unknown as OrganisedJob[])
      const groupedUpcoming = groupJobs((opData.upcoming || []) as unknown as OrganisedJob[])
      const groupedCompleted = groupJobs((opData.completed || []) as unknown as OrganisedJob[])
      const groupedCancelled = groupJobs((opData.cancelled || []) as unknown as OrganisedJob[])

      return NextResponse.json({
        success: true,
        user: opData.user,
        today: groupedToday,
        upcoming: groupedUpcoming,
        completed: groupedCompleted,
        cancelled: groupedCancelled,
      })
    } catch (opError) {
      // 4xx = legit negative response (e.g. 401 session expired) — propagate as-is
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json(
          { success: false, error: opError.message },
          { status }
        )
      }
      console.error('OP backend error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load jobs. Please refresh and try again, or contact us if it persists.' },
        { status: 502 }
      )
    }

  } catch (error) {
    console.error('Jobs API error after', Date.now() - startTime, 'ms:', error)
    return NextResponse.json(
      { success: false, error: 'An error occurred while fetching jobs' },
      { status: 500 }
    )
  }
}
