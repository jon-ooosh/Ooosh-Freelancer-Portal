import { NextRequest, NextResponse } from 'next/server'
import { findFreelancerByEmail } from '@/lib/monday'
import { sendVerificationEmail } from '@/lib/email'
import { 
  generateVerificationCode, 
  storeVerificationCode, 
  checkEmailRateLimit 
} from '@/lib/verification'

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
