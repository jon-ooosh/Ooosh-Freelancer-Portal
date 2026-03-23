import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import {
  findFreelancerByEmail,
  updateFreelancerDateColumn,
  FREELANCER_COLUMNS
} from '@/lib/monday'
import { isOpMode, loginToOP } from '@/lib/op-api'

// Session secret for JWT signing
const getSessionSecret = () => {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is not set')
  }
  return new TextEncoder().encode(secret)
}

// Rate limiting storage (in production, use Redis or similar)
const loginAttempts = new Map<string, { count: number; lastAttempt: number }>()

const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION = 15 * 60 * 1000 // 15 minutes

function checkRateLimit(email: string): { allowed: boolean; remainingAttempts?: number } {
  const now = Date.now()
  const attempts = loginAttempts.get(email)

  if (!attempts) {
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS }
  }

  // Reset if lockout period has passed
  if (now - attempts.lastAttempt > LOCKOUT_DURATION) {
    loginAttempts.delete(email)
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS }
  }

  // Check if locked out
  if (attempts.count >= MAX_ATTEMPTS) {
    return { allowed: false }
  }

  return { allowed: true, remainingAttempts: MAX_ATTEMPTS - attempts.count }
}

function recordFailedAttempt(email: string) {
  const now = Date.now()
  const attempts = loginAttempts.get(email)

  if (!attempts) {
    loginAttempts.set(email, { count: 1, lastAttempt: now })
  } else {
    loginAttempts.set(email, { count: attempts.count + 1, lastAttempt: now })
  }
}

function clearFailedAttempts(email: string) {
  loginAttempts.delete(email)
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
        { error: 'Too many login attempts. Please try again in 15 minutes.' },
        { status: 429 }
      )
    }

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      try {
        console.log('Login: OP mode enabled, trying OP backend for:', normalizedEmail)
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

        // OP backend returned failure — fall through to Monday.com
        // During transition, freelancers may only exist in Monday.com
        console.log('Login: OP backend rejected credentials for:', normalizedEmail, '- falling back to Monday.com')
      } catch (opError) {
        console.error('Login: OP backend error, falling back to Monday.com:', opError)
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    // Find freelancer in Monday.com
    console.log('Login: Looking up freelancer in Monday.com:', normalizedEmail)
    const freelancer = await findFreelancerByEmail(normalizedEmail)

    if (!freelancer) {
      console.log('Login: Freelancer not found in Monday.com:', normalizedEmail)
      recordFailedAttempt(normalizedEmail)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Check if email is verified
    if (!freelancer.emailVerified) {
      console.log('Login: Freelancer email not verified:', normalizedEmail)
      return NextResponse.json(
        { error: 'Please complete registration first. Check your email for verification.' },
        { status: 401 }
      )
    }

    // Check password
    if (!freelancer.passwordHash) {
      console.log('Login: Freelancer has no password hash set:', normalizedEmail)
      return NextResponse.json(
        { error: 'Account not set up. Please register first.' },
        { status: 401 }
      )
    }

    const passwordValid = await bcrypt.compare(password, freelancer.passwordHash)

    if (!passwordValid) {
      console.log('Login: Password mismatch for:', normalizedEmail)
      recordFailedAttempt(normalizedEmail)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Clear failed attempts on successful login
    console.log('Login: Monday.com login successful for:', normalizedEmail)
    clearFailedAttempts(normalizedEmail)

    // Update last login timestamp in Monday
    try {
      await updateFreelancerDateColumn(
        freelancer.id,
        FREELANCER_COLUMNS.lastLogin,
        new Date()
      )
    } catch (err) {
      // Don't fail login if this update fails
      console.error('Failed to update last login:', err)
    }

    // Create session token
    const sessionToken = await new SignJWT({
      id: freelancer.id,
      email: freelancer.email,
      name: freelancer.name,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('30d')
      .sign(getSessionSecret())

    // Create response with cookie
    const response = NextResponse.json({
      success: true,
      user: {
        id: freelancer.id,
        name: freelancer.name,
        email: freelancer.email,
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
    console.error('Login error:', error)
    return NextResponse.json(
      { error: 'An error occurred during login' },
      { status: 500 }
    )
  }
}
