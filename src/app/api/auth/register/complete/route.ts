import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import {
  getVerificationRecord,
  deleteVerificationRecord
} from '@/lib/verification'
import {
  updateFreelancerTextColumn,
  updateFreelancerStatusColumn,
  updateFreelancerDateColumn,
  FREELANCER_COLUMNS
} from '@/lib/monday'
import { isOpMode, registerCompleteOP, reportFallback } from '@/lib/op-api'

// Session secret for JWT signing
const getSessionSecret = () => {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is not set')
  }
  return new TextEncoder().encode(secret)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password, code } = body

    // Validate input
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      if (!code) {
        return NextResponse.json(
          { error: 'Verification code is missing. Please start registration again.' },
          { status: 400 }
        )
      }

      try {
        const opResult = await registerCompleteOP(normalizedEmail, code, password)
        if (opResult.success && opResult.user) {
          // Re-sign with SESSION_SECRET so middleware accepts the cookie
          // (same reason as login/route.ts)
          const sessionToken = await new SignJWT({
            id: opResult.user.id,
            email: opResult.user.email,
            name: opResult.user.name,
          })
            .setProtectedHeader({ alg: 'HS256' })
            .setIssuedAt()
            .setExpirationTime('30d')
            .sign(getSessionSecret())

          const response = NextResponse.json({
            success: true,
            user: opResult.user,
          })

          response.cookies.set('session', sessionToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            maxAge: 30 * 24 * 60 * 60,
            path: '/',
          })

          return response
        }
      } catch (opError: unknown) {
        const status = (opError as { status?: number })?.status
        // Client-level errors (bad code, already approved, etc.) — surface
        if (status === 400 || status === 403) {
          const err = opError as Error
          return NextResponse.json({ error: err.message }, { status })
        }
        // System-level error — alert + fall back
        console.error('Register/complete: OP backend error, falling back:', opError)
        reportFallback('register-complete', opError, { email: normalizedEmail })
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    // Get verification record
    const record = getVerificationRecord(normalizedEmail)

    if (!record) {
      return NextResponse.json(
        { error: 'Verification expired. Please start registration again.' },
        { status: 400 }
      )
    }

    if (!record.verified) {
      return NextResponse.json(
        { error: 'Please verify your email first.' },
        { status: 400 }
      )
    }

    // Hash the password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12')
    const passwordHash = await bcrypt.hash(password, rounds)

    // Update Monday with password hash and verified status
    try {
      // Set password hash
      await updateFreelancerTextColumn(
        record.freelancerId,
        FREELANCER_COLUMNS.passwordHash,
        passwordHash
      )

      // Set email verified status to "Done"
      await updateFreelancerStatusColumn(
        record.freelancerId,
        FREELANCER_COLUMNS.emailVerified,
        'Done'
      )

      // Set last login date
      await updateFreelancerDateColumn(
        record.freelancerId,
        FREELANCER_COLUMNS.lastLogin,
        new Date()
      )
    } catch (mondayError) {
      console.error('Failed to update Monday:', mondayError)
      return NextResponse.json(
        { error: 'Failed to save account. Please try again.' },
        { status: 500 }
      )
    }

    // Clean up verification record
    deleteVerificationRecord(normalizedEmail)

    // Create session token
    const sessionToken = await new SignJWT({
      id: record.freelancerId,
      email: normalizedEmail,
      name: record.freelancerName,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(getSessionSecret())

    // Create response with cookie
    const response = NextResponse.json({
      success: true,
      user: {
        id: record.freelancerId,
        name: record.freelancerName,
        email: normalizedEmail,
      },
    })

    // Set secure HTTP-only cookie
    response.cookies.set('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/',
    })

    return response
  } catch (error) {
    console.error('Registration complete error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
