import { NextRequest, NextResponse } from 'next/server'
import { SignJWT } from 'jose'
import { loginToOP } from '@/lib/op-api'
import { checkRateLimit, recordFailedAttempt, clearFailedAttempts } from '@/lib/login-rate-limit'

// Session secret for JWT signing
const getSessionSecret = () => {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is not set')
  }
  return new TextEncoder().encode(secret)
}

// Shown when the account is already locked out (15-min cooldown). Steers the
// user to the reset flow rather than letting them keep hammering a 429.
const LOCKOUT_MESSAGE =
  'Sign-in is paused after too many attempts. Please reset your password using "Forgot your password?" below, or try again in 15 minutes.'

// Wrong-password copy. As the user approaches the lockout we tell them how many
// attempts remain and, on the final one, point them straight at Forgot Password.
function wrongPasswordMessage(remainingAttempts: number): string {
  if (remainingAttempts <= 0) {
    return 'Incorrect password. For security we\'ve paused sign-in for this account — please reset your password using "Forgot your password?" below.'
  }
  const attempts = remainingAttempts === 1 ? '1 attempt' : `${remainingAttempts} attempts`
  return `Incorrect password — ${attempts} left before you'll need to reset your password.`
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, password } = body

    // Validate input
    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Check rate limit
    const rateLimit = checkRateLimit(normalizedEmail)
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: LOCKOUT_MESSAGE },
        { status: 429 }
      )
    }

    try {
      console.log('Login: trying OP backend for:', normalizedEmail)
      const opResult = await loginToOP(normalizedEmail, password)

      if (opResult.success && opResult.user) {
        clearFailedAttempts(normalizedEmail)

        // Always create a LOCAL session token signed with SESSION_SECRET.
        // The OP backend's token is signed with PORTAL_SESSION_SECRET which
        // differs from the SESSION_SECRET used by Next.js middleware to verify
        // sessions. Using the OP token directly causes verification failures
        // and login redirect loops.
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

        console.log('Login: OP backend login successful for:', normalizedEmail)
        return response
      }

      // OP returned 401 — credentials definitively wrong (or account not in
      // OP yet). A freelancer who genuinely only exists elsewhere should use
      // Forgot Password to register on OP.
      if (opResult.status === 401) {
        const remaining = recordFailedAttempt(normalizedEmail)
        return NextResponse.json(
          { error: wrongPasswordMessage(remaining) },
          { status: 401 }
        )
      }

      // Any other OP failure that wasn't a thrown error.
      return NextResponse.json(
        { error: "Incorrect password — please try again, or use \"Forgot your password?\" below if you've forgotten it." },
        { status: 401 }
      )
    } catch (opError) {
      console.error('Login: OP backend error:', opError)
      return NextResponse.json(
        { error: 'Login service temporarily unavailable. Please try again in a moment.' },
        { status: 502 }
      )
    }
  } catch (error) {
    console.error('Login error:', error)
    return NextResponse.json(
      { error: "Something went wrong on our end. Please try again in a moment, or email info@oooshtours.co.uk if it keeps happening." },
      { status: 500 }
    )
  }
}
