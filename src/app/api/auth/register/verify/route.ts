import { NextRequest, NextResponse } from 'next/server'
import { validateCode, markVerified } from '@/lib/verification'
import { isOpMode, registerVerifyOP, reportFallback } from '@/lib/op-api'

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
        const status = (opError as { status?: number })?.status
        // 400/429 = code wrong / too many attempts — surface directly
        if (status === 400 || status === 429) {
          const err = opError as Error
          return NextResponse.json({ error: err.message }, { status: status })
        }
        // System-level error — alert + fall back to Monday.com
        console.error('Register/verify: OP backend error, falling back:', opError)
        reportFallback('register-verify', opError, { email: normalizedEmail })
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
