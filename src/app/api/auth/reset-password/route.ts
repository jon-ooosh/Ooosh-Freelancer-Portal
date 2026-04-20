/**
 * Reset Password API Endpoint
 *
 * POST /api/auth/reset-password
 *
 * In OP mode: consumes the token on the OP backend which hashes and stores
 * the new password, then issues a session cookie so the user is logged in.
 *
 * In Monday mode: validates token against Monday.com and updates there.
 */

import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { updateFreelancerTextColumn, FREELANCER_COLUMNS } from '@/lib/monday'
import { consumeResetToken } from '@/lib/password-reset'
import { isOpMode, resetPasswordOP, reportFallback, mondayFallbackAllowed } from '@/lib/op-api'

const getSessionSecret = () => {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET environment variable is not set')
  return new TextEncoder().encode(secret)
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, password } = body

    // Validate input
    if (!token || !password) {
      return NextResponse.json(
        { error: 'Token and password are required' },
        { status: 400 }
      )
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      try {
        const opResult = await resetPasswordOP(token, password)
        if (opResult.success && opResult.user) {
          // Re-sign with SESSION_SECRET (see login/route.ts for rationale)
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
            message: 'Password has been reset successfully.',
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
        if (status === 400 || status === 403) {
          const err = opError as Error
          return NextResponse.json({ error: err.message }, { status })
        }
        console.error('Reset-password: OP backend error, falling back:', opError)
        reportFallback('reset-password', opError)
        if (!mondayFallbackAllowed()) {
          return NextResponse.json(
            { error: 'Unable to reset password right now. Please try again in a moment.' },
            { status: 502 }
          )
        }
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    // Consume (validate and invalidate) the token
    const tokenData = consumeResetToken(token)

    if (!tokenData) {
      return NextResponse.json(
        { error: 'Invalid or expired reset link. Please request a new one.' },
        { status: 400 }
      )
    }

    // Hash the new password
    const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12')
    const passwordHash = await bcrypt.hash(password, rounds)

    // Update Monday.com with new password hash
    try {
      await updateFreelancerTextColumn(
        tokenData.freelancerId,
        FREELANCER_COLUMNS.passwordHash,
        passwordHash
      )
    } catch (mondayError) {
      console.error('Failed to update password in Monday:', mondayError)
      return NextResponse.json(
        { error: 'Failed to update password. Please try again.' },
        { status: 500 }
      )
    }

    console.log(`Password reset successful for ${tokenData.email}`)

    return NextResponse.json({
      success: true,
      message: 'Password has been reset successfully.',
    })

  } catch (error) {
    console.error('Reset password error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
