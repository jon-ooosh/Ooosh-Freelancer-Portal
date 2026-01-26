/**
 * Notifications Settings API
 * 
 * GET /api/settings/notifications - Get current mute status
 * POST /api/settings/notifications - Update mute settings
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import { 
  findFreelancerByEmail, 
  updateFreelancerMuteUntil,
  updateFreelancerJobMute,
} from '@/lib/monday'

// =============================================================================
// GET - Fetch current mute status
// =============================================================================

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const freelancer = await findFreelancerByEmail(user.email)
    if (!freelancer) {
      return NextResponse.json({ success: false, error: 'Freelancer not found' }, { status: 404 })
    }

    // Check if global mute is active
    // Monday only stores dates (no times), so we compare date-to-date
    let globalMuteActive = false
    let globalMuteUntil: string | null = null
    
    if (freelancer.notificationsPausedUntil) {
      const pausedDate = new Date(freelancer.notificationsPausedUntil)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      pausedDate.setHours(0, 0, 0, 0)
      
      // Mute is active if paused date is today or in the future
      // (For "end of today", we store tomorrow's date, so it will show as muted)
      if (pausedDate > today) {
        globalMuteActive = true
        globalMuteUntil = freelancer.notificationsPausedUntil
      }
    }

    // Parse muted job IDs
    const mutedJobIds = freelancer.mutedJobIds
      ? freelancer.mutedJobIds.split(',').map(id => id.trim()).filter(Boolean)
      : []

    return NextResponse.json({
      success: true,
      notifications: {
        globalMuteActive,
        globalMuteUntil,
        mutedJobIds,
        mutedJobCount: mutedJobIds.length,
      },
    })

  } catch (error) {
    console.error('Settings API error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to fetch settings' },
      { status: 500 }
    )
  }
}

// =============================================================================
// POST - Update mute settings
// =============================================================================

interface MuteRequest {
  action: 'mute_global' | 'unmute_global' | 'mute_job' | 'unmute_job'
  // For mute_global:
  muteType?: '7_days' | 'end_of_today' | 'specific_date' | 'indefinite'
  muteUntilDate?: string // For specific_date
  // For mute_job / unmute_job:
  jobId?: string
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const body: MuteRequest = await request.json()
    const { action } = body

    switch (action) {
      case 'mute_global': {
        const { muteType, muteUntilDate } = body
        let mutedUntil: Date

        switch (muteType) {
          case 'end_of_today':
            // Monday only stores DATES, not times!
            // To mute "until end of today", we store TOMORROW's date.
            // The check compares: is pausedDate > today? If tomorrow > today, yes = muted.
            mutedUntil = new Date()
            mutedUntil.setDate(mutedUntil.getDate() + 1)  // Tomorrow
            mutedUntil.setHours(0, 0, 0, 0)
            break
          
          case '7_days':
            mutedUntil = new Date()
            mutedUntil.setDate(mutedUntil.getDate() + 7)
            break
          
          case 'specific_date':
            if (!muteUntilDate) {
              return NextResponse.json(
                { success: false, error: 'Date required for specific_date mute' },
                { status: 400 }
              )
            }
            // User picks a date - we store the day AFTER so they're muted ON that day
            mutedUntil = new Date(muteUntilDate)
            mutedUntil.setDate(mutedUntil.getDate() + 1)  // Day after selected
            break
          
          case 'indefinite':
            // Set to far future date (10 years)
            mutedUntil = new Date()
            mutedUntil.setFullYear(mutedUntil.getFullYear() + 10)
            break
          
          default:
            return NextResponse.json(
              { success: false, error: 'Invalid mute type' },
              { status: 400 }
            )
        }

        await updateFreelancerMuteUntil(user.email, mutedUntil)
        
        return NextResponse.json({
          success: true,
          message: 'Notifications muted',
          mutedUntil: mutedUntil.toISOString(),
        })
      }

      case 'unmute_global': {
        await updateFreelancerMuteUntil(user.email, null)
        return NextResponse.json({
          success: true,
          message: 'Notifications enabled',
        })
      }

      case 'mute_job': {
        const { jobId } = body
        if (!jobId) {
          return NextResponse.json(
            { success: false, error: 'Job ID required' },
            { status: 400 }
          )
        }
        await updateFreelancerJobMute(user.email, jobId, true)
        return NextResponse.json({
          success: true,
          message: 'Job notifications muted',
          jobId,
        })
      }

      case 'unmute_job': {
        const { jobId } = body
        if (!jobId) {
          return NextResponse.json(
            { success: false, error: 'Job ID required' },
            { status: 400 }
          )
        }
        await updateFreelancerJobMute(user.email, jobId, false)
        return NextResponse.json({
          success: true,
          message: 'Job notifications enabled',
          jobId,
        })
      }

      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action' },
          { status: 400 }
        )
    }

  } catch (error) {
    console.error('Settings API error:', error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Failed to update settings' },
      { status: 500 }
    )
  }
}