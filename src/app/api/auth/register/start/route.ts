import { NextRequest, NextResponse } from 'next/server'
import { findFreelancerByEmail } from '@/lib/monday'
import { sendVerificationEmail } from '@/lib/email'
import {
  generateVerificationCode,
  storeVerificationCode,
  checkEmailRateLimit
} from '@/lib/verification'
import { isOpMode, registerStartOP, reportFallback } from '@/lib/op-api'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email } = body

    // Validate input
    if (!email) {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Check rate limit
    if (!checkEmailRateLimit(normalizedEmail)) {
      return NextResponse.json(
        { error: 'Too many verification emails requested. Please try again later.' },
        { status: 429 }
      )
    }

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      try {
        const result = await registerStartOP(normalizedEmail)
        return NextResponse.json(result)
      } catch (opError: unknown) {
        const status = (opError as { status?: number })?.status
        // 409 = already registered — surface directly, don't fall back
        if (status === 409) {
          const err = opError as Error
          return NextResponse.json({ error: err.message }, { status: 409 })
        }
        // Anything else is a real failure — alert + fall back to Monday.com
        console.error('Register/start: OP backend error, falling back:', opError)
        reportFallback('register-start', opError, { email: normalizedEmail })
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    // Check if email exists in Monday
    const freelancer = await findFreelancerByEmail(normalizedEmail)

    if (!freelancer) {
      return NextResponse.json(
        { error: 'This email is not registered with Ooosh. Please contact us if you think this is an error.' },
        { status: 404 }
      )
    }

    // Check if already registered
    if (freelancer.emailVerified && freelancer.passwordHash) {
      return NextResponse.json(
        { error: 'This email is already registered. Please log in instead.' },
        { status: 400 }
      )
    }

    // Generate and store verification code
    const code = generateVerificationCode()
    storeVerificationCode(normalizedEmail, code, freelancer.id, freelancer.name)

    // Send verification email
    await sendVerificationEmail(normalizedEmail, code, freelancer.name)

    return NextResponse.json({
      success: true,
      message: 'Verification code sent',
    })
  } catch (error) {
    console.error('Registration start error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
