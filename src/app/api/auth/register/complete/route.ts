import { NextRequest, NextResponse } from 'next/server'
import { SignJWT } from 'jose'
import { registerCompleteOP, isOpClientError, OpApiError } from '@/lib/op-api'

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

      // OP returned success without a user — unexpected, treat as a soft failure.
      return NextResponse.json(
        { error: 'Unable to complete registration right now. Please try again in a moment.' },
        { status: 502 }
      )
    } catch (opError: unknown) {
      // Any 4xx (bad code, already approved, expired, etc.) is a legit
      // negative response — surface directly.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ error: opError.message }, { status })
      }
      // 5xx / network = real failure.
      console.error('Register/complete: OP backend error:', opError)
      return NextResponse.json(
        { error: 'Unable to complete registration right now. Please try again in a moment.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Registration complete error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
