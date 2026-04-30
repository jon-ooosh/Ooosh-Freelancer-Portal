import { NextRequest, NextResponse } from 'next/server'
import { validateCode, markVerified } from '@/lib/verification'
import { isOpMode, registerVerifyOP, reportFallback, mondayFallbackAllowed, isOpClientError, OpApiError } from '@/lib/op-api'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, code } = body

    // Validate input
    if (!email || !code) {
      return NextResponse.json(
        { error: 'Email and code are required' },
        { status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()
    const normalizedCode = code.trim()

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      try {
        await registerVerifyOP(normalizedEmail, normalizedCode)
        return NextResponse.json({
          success: true,
          message: 'Email verified. Please set your password.',
        })
      } catch (opError: unknown) {
        // Any 4xx (code wrong, expired, too many attempts) = legit
        // negative response — surface directly without alerting.
        if (isOpClientError(opError)) {
          const status = (opError as OpApiError).status
          return NextResponse.json({ error: opError.message }, { status })
        }
        // System-level error — alert + (optionally) fall back to Monday.com
        console.error('Register/verify: OP backend error, falling back:', opError)
        reportFallback('register-verify', opError, { email: normalizedEmail })
        if (!mondayFallbackAllowed()) {
          return NextResponse.json(
            { error: 'Unable to verify code right now. Please try again in a moment.' },
            { status: 502 }
          )
        }
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    // Validate the code
    const result = validateCode(normalizedEmail, normalizedCode)

    if (!result.valid) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      )
    }

    // Mark as verified (allows password to be set)
    markVerified(normalizedEmail)

    return NextResponse.json({
      success: true,
      message: 'Email verified. Please set your password.',
    })
  } catch (error) {
    console.error('Verification error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
