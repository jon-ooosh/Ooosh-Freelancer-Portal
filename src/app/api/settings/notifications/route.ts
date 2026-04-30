/**
 * Notifications Settings API
 *
 * GET  /api/settings/notifications - Get current mute status
 * POST /api/settings/notifications - Update mute settings
 *
 * In OP mode, settings are stored on the people table. Monday.com path
 * is preserved as a fallback while DATA_BACKEND=op is rolled out.
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import {
  findFreelancerByEmail,
  updateFreelancerMuteUntil,
  updateFreelancerJobMute,
} from '@/lib/monday'
import {
  isOpMode,
  getNotificationSettingsFromOP,
  updateNotificationSettingsOnOP,
  reportFallback,
  mondayFallbackAllowed,
  isOpClientError,
  OpApiError,
} from '@/lib/op-api'

// =============================================================================
// GET - Fetch current mute status
// =============================================================================

export async function GET() {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      const sessionToken = cookies().get('session')?.value
      if (!sessionToken) {
        return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
      }
      try {
        const opData = await getNotificationSettingsFromOP(sessionToken)
        return NextResponse.json(opData)
      } catch (opError) {
        // 4xx = legit response, no alert
        if (isOpClientError(opError)) {
          const status = (opError as OpApiError).status
          return NextResponse.json(
            { success: false, error: opError.message },
            { status }
          )
        }
        console.error('OP backend settings GET error:', opError)
        reportFallback('settings-notifications-get', opError, { email: user.email })
        if (!mondayFallbackAllowed()) {
          return NextResponse.json(
            { success: false, error: 'Unable to load settings. Please refresh and try again.' },
            { status: 502 }
          )
        }
        console.log('Settings API: Falling back to Monday.com')
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    const freelancer = await findFreelancerByEmail(user.email)
    if (!freelancer) {
      return NextResponse.json({ success: false, error: 'Freelancer not found' }, { status: 404 })
    }

    let globalMuteActive = false
    let globalMuteUntil: string | null = null

    if (freelancer.notificationsPausedUntil) {
      const pausedDate = new Date(freelancer.notificationsPausedUntil)
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      pausedDate.setHours(0, 0, 0, 0)

      if (pausedDate > today) {
        globalMuteActive = true
        globalMuteUntil = freelancer.notificationsPausedUntil
      }
    }

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
  muteType?: '7_days' | 'end_of_today' | 'specific_date' | 'indefinite'
  muteUntilDate?: string
  jobId?: string
}

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Not authenticated' }, { status: 401 })
    }

    const body: MuteRequest = await request.json()

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      const sessionToken = cookies().get('session')?.value
      if (!sessionToken) {
        return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
      }
      try {
        const opData = await updateNotificationSettingsOnOP(sessionToken, body as unknown as Record<string, unknown>)
        return NextResponse.json(opData)
      } catch (opError) {
        // 4xx = legit response (validation error, etc.), no alert
        if (isOpClientError(opError)) {
          const status = (opError as OpApiError).status
          return NextResponse.json(
            { success: false, error: opError.message },
            { status }
          )
        }
        console.error('OP backend settings POST error:', opError)
        reportFallback('settings-notifications-post', opError, { email: user.email })
        if (!mondayFallbackAllowed()) {
          return NextResponse.json(
            { success: false, error: 'Unable to update settings. Please try again.' },
            { status: 502 }
          )
        }
        console.log('Settings API: Falling back to Monday.com for write')
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    const { action } = body

    switch (action) {
      case 'mute_global': {
        const { muteType, muteUntilDate } = body
        let mutedUntil: Date

        switch (muteType) {
          case 'end_of_today':
            mutedUntil = new Date()
            mutedUntil.setDate(mutedUntil.getDate() + 1)
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
            mutedUntil = new Date(muteUntilDate)
            mutedUntil.setDate(mutedUntil.getDate() + 1)
            break

          case 'indefinite':
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
