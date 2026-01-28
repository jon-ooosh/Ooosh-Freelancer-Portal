/**
 * Forgot Password API Endpoint
 * 
 * POST /api/auth/forgot-password
 * 
 * Initiates a password reset by:
 * 1. Validating the email exists in Monday.com
 * 2. Generating a secure reset token
 * 3. Sending a reset email with a link
 * 
 * Always returns success to prevent email enumeration attacks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { findFreelancerByEmail } from '@/lib/monday'
import { sendPasswordResetEmail } from '@/lib/email'
import { createResetToken, checkResetRateLimit } from '@/lib/password-reset'

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

    // Check rate limit (max 3 requests per hour)
    if (!checkResetRateLimit(normalizedEmail)) {
      return NextResponse.json(
        { error: 'Too many reset requests. Please try again later.' },
        { status: 429 }
      )
    }

    // Always return success to prevent email enumeration
    // But only send email if account exists and is verified
    try {
      const freelancer = await findFreelancerByEmail(normalizedEmail)

      // Only proceed if account exists, is verified, and has a password
      if (freelancer && freelancer.emailVerified && freelancer.passwordHash) {
        // Generate reset token
        const token = createResetToken(normalizedEmail, freelancer.id)

        // Build reset URL
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://ooosh-freelancer-portal.netlify.app'
        const resetUrl = `${appUrl.replace(/\/$/, '')}/reset-password?token=${token}`

        // Send reset email
        await sendPasswordResetEmail(normalizedEmail, resetUrl, freelancer.name)

        console.log(`Password reset email sent to ${normalizedEmail}`)
      } else {
        console.log(`Password reset requested for non-existent or unverified email: ${normalizedEmail}`)
      }
    } catch (err) {
      // Log but don't expose errors to prevent enumeration
      console.error('Error processing password reset:', err)
    }

    // Always return success
    return NextResponse.json({
      success: true,
      message: 'If an account exists, a reset email will be sent.',
    })

  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}