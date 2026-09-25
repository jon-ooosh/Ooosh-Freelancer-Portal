/**
 * Notifications Settings API
 *
 * GET  /api/settings/notifications - Get current mute status
 * POST /api/settings/notifications - Update mute settings
 *
 * Backed by the OP people table (via /api/portal/settings/notifications).
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getSessionUser } from '@/lib/session'
import {
  getNotificationSettingsFromOP,
  updateNotificationSettingsOnOP,
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

    const sessionToken = cookies().get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const opData = await getNotificationSettingsFromOP(sessionToken)
      return NextResponse.json(opData)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP settings GET error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to load settings. Please refresh and try again.' },
        { status: 502 }
      )
    }
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

    const sessionToken = cookies().get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const opData = await updateNotificationSettingsOnOP(sessionToken, body as unknown as Record<string, unknown>)
      return NextResponse.json(opData)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP settings POST error:', opError)
      return NextResponse.json(
        { success: false, error: 'Unable to update settings. Please try again.' },
        { status: 502 }
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
