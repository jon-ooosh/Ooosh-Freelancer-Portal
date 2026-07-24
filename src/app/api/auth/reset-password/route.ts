/**
 * Reset Password API Endpoint
 *
 * POST /api/auth/reset-password
 *
 * Consumes the token on the OP backend which hashes and stores the new
 * password, then issues a session cookie so the user is logged in.
 */

import { NextRequest, NextResponse } from 'next/server'
import { SignJWT } from 'jose'
import { clearFailedAttempts } from '@/lib/login-rate-limit'
import { resetPasswordOP, isOpClientError, OpApiError } from '@/lib/op-api'

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

    try {
      const opResult = await resetPasswordOP(token, password)
      if (opResult.success && opResult.user) {
        // A successful reset proves the user owns this email — clear any
        // failed-login lockout so they're not blocked by a 429 from earlier
        // wrong-password attempts (the auto-login below papers over this, but
        // a fresh login on another device would otherwise hit the stale count).
        clearFailedAttempts(opResult.user.email)

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

      // OP returned success without a user — unexpected, treat as a soft failure.
      return NextResponse.json(
        { error: 'Unable to reset password right now. Please try again in a moment.' },
        { status: 502 }
      )
    } catch (opError: unknown) {
      // Any 4xx (token expired, validation failure, forbidden) is a
      // legit response — return it to the user.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ error: opError.message }, { status })
      }
      console.error('Reset-password: OP backend error:', opError)
      return NextResponse.json(
        { error: 'Unable to reset password right now. Please try again in a moment.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Reset password error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
