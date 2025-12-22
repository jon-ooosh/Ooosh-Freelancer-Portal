import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { SignJWT } from 'jose'
import { 
  findFreelancerByEmail, 
  updateFreelancerDateColumn,
  FREELANCER_COLUMNS 
} from '@/lib/monday'

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

    // Find freelancer in Monday
    const freelancer = await findFreelancerByEmail(normalizedEmail)

    if (!freelancer) {
      recordFailedAttempt(normalizedEmail)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Check if email is verified
    if (!freelancer.emailVerified) {
      return NextResponse.json(
        { error: 'Please complete registration first. Check your email for verification.' },
        { status: 401 }
      )
    }

    // Check password
    if (!freelancer.passwordHash) {
      return NextResponse.json(
        { error: 'Account not set up. Please register first.' },
        { status: 401 }
      )
    }

    const passwordValid = await bcrypt.compare(password, freelancer.passwordHash)

    if (!passwordValid) {
      recordFailedAttempt(normalizedEmail)
      return NextResponse.json(
        { error: 'Invalid email or password' },
        { status: 401 }
      )
    }

    // Clear failed attempts on successful login
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
      sameSite: 'strict',
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
