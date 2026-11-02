/**
 * POST /api/auth/login/code — the second step of two-step sign-in
 * (docs/FREELANCER-PORTAL-SPEC.md §7). Body: { pending, code, trustDevice }.
 *
 * OP checks the code; only then is the session set here. With "Remember this
 * phone" ticked, OP's pass is kept in the portal_device cookie so this phone
 * skips the code for 90 days.
 */

import { NextRequest, NextResponse } from 'next/server'
import { loginCodeOP, isOpClientError, OpApiError } from '@/lib/op-api'
import { setPortalSession, setDeviceCookie, clientUserAgent } from '@/lib/portal-session'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const pending = typeof body.pending === 'string' ? body.pending : ''
    const code = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : ''
    if (!pending) {
      return NextResponse.json({ error: 'Your sign-in has timed out. Please start again.', code: 'pending_expired' }, { status: 400 })
    }
    if (code.length !== 6) {
      return NextResponse.json({ error: 'Enter the 6-digit code' }, { status: 400 })
    }

    try {
      const op = await loginCodeOP(pending, code, body.trustDevice === true, clientUserAgent(request))
      if (!op.success || !op.user) {
        return NextResponse.json({ error: 'Unable to sign in right now. Please try again in a moment.' }, { status: 502 })
      }
      const response = NextResponse.json({ success: true, user: op.user })
      await setPortalSession(response, op.user)
      setDeviceCookie(response, op.deviceToken)
      return response
    } catch (opError: unknown) {
      // A wrong, expired or used-up code, or a sign-in that timed out: OP's
      // own words (and its `code`, so the page can tell a timeout apart).
      if (isOpClientError(opError)) {
        const err = opError as OpApiError
        const opCode = (err.body as { code?: string } | null)?.code
        return NextResponse.json({ error: err.message, ...(opCode ? { code: opCode } : {}) }, { status: err.status })
      }
      console.error('Login code: OP backend error:', opError)
      return NextResponse.json({ error: 'Login service temporarily unavailable. Please try again in a moment.' }, { status: 502 })
    }
  } catch (error) {
    console.error('Login code error:', error)
    return NextResponse.json({ error: 'Something went wrong on our end. Please try again in a moment.' }, { status: 500 })
  }
}
