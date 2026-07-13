/**
 * Studio Sitter Shift Handover Thread API
 *
 * GET  /api/studio-sitter/shifts/[date]/thread   → the evening's handover log
 * POST /api/studio-sitter/shifts/[date]/thread   → add a note ({ content })
 *
 * OP-only. Access + the freelancer-author attribution are enforced OP-side.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSessionUser } from '@/lib/session'
import {
  isOpMode,
  getSitterThreadFromOP,
  postSitterThreadOP,
  isOpClientError,
  OpApiError,
  reportFallback,
} from '@/lib/op-api'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const { date } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    if (!isOpMode()) {
      return NextResponse.json({ success: true, messages: [] })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    try {
      const data = await getSitterThreadFromOP(sessionToken, date)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      console.error('OP sitter thread read error:', opError)
      reportFallback('sitter-thread-read', opError, { email: user.email })
      return NextResponse.json(
        { success: false, error: 'Unable to load handover notes. Please refresh and try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter thread GET error:', error)
    return NextResponse.json({ success: false, error: 'Failed to load handover notes' }, { status: 500 })
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  try {
    const { date } = await params
    if (!DATE_RE.test(date)) {
      return NextResponse.json({ success: false, error: 'Invalid date' }, { status: 400 })
    }

    const user = await getSessionUser()
    if (!user) {
      return NextResponse.json({ success: false, error: 'Authentication required' }, { status: 401 })
    }
    if (!isOpMode()) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }

    const sessionToken = request.cookies.get('session')?.value
    if (!sessionToken) {
      return NextResponse.json({ success: false, error: 'Session token missing' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const content = typeof body?.content === 'string' ? body.content.trim() : ''
    if (!content) {
      return NextResponse.json({ success: false, error: 'A message is required' }, { status: 400 })
    }

    try {
      const data = await postSitterThreadOP(sessionToken, date, content)
      return NextResponse.json(data)
    } catch (opError) {
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ success: false, error: opError.message }, { status })
      }
      // POSTs aren't retried by opFetch — surface a clean, retryable error.
      console.error('OP sitter thread post error:', opError)
      reportFallback('sitter-thread-post', opError, { email: user.email })
      return NextResponse.json(
        { success: false, error: 'Unable to post your note. Please try again.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Sitter thread POST error:', error)
    return NextResponse.json({ success: false, error: 'Failed to post note' }, { status: 500 })
  }
}
