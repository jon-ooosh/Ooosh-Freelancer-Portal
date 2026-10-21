/**
 * POST /api/auth/login/send-code — "Send a new code" on the login page's code
 * step (docs/FREELANCER-PORTAL-SPEC.md §7). Body: { pending }. OP limits how
 * often (30 seconds apart, 3 in 15 minutes) and says so in its own words.
 */

import { NextRequest, NextResponse } from 'next/server'
import { loginSendCodeOP, isOpClientError, OpApiError } from '@/lib/op-api'
import { clientUserAgent } from '@/lib/portal-session'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}))
    const pending = typeof body.pending === 'string' ? body.pending : ''
    if (!pending) {
      return NextResponse.json({ error: 'Your sign-in has timed out. Please start again.', code: 'pending_expired' }, { status: 400 })
    }
    try {
      await loginSendCodeOP(pending, clientUserAgent(request))
      return NextResponse.json({ success: true })
    } catch (opError: unknown) {
      if (isOpClientError(opError)) {
        const err = opError as OpApiError
        const opCode = (err.body as { code?: string } | null)?.code
        return NextResponse.json({ error: err.message, ...(opCode ? { code: opCode } : {}) }, { status: err.status })
      }
      // OP's 502 ("the code email could not be sent") is worth showing as it is.
      if (opError instanceof OpApiError && opError.status === 502) {
        return NextResponse.json({ error: opError.message }, { status: 502 })
      }
      console.error('Login send-code: OP backend error:', opError)
      return NextResponse.json({ error: 'Could not send a code just now. Please try again in a moment.' }, { status: 502 })
    }
  } catch (error) {
    console.error('Login send-code error:', error)
    return NextResponse.json({ error: 'Something went wrong on our end. Please try again in a moment.' }, { status: 500 })
  }
}
