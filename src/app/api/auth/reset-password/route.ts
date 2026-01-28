/**
 * Reset Password API Endpoint
 * 
 * POST /api/auth/reset-password
 * 
 * Resets a user's password using a valid reset token:
 * 1. Validates and consumes the token
 * 2. Hashes the new password
 * 3. Updates Monday.com with the new password hash
 */

import { NextRequest, NextResponse } from 'next/server'
import bcrypt from 'bcryptjs'
import { updateFreelancerTextColumn, FREELANCER_COLUMNS } from '@/lib/monday'
import { consumeResetToken } from '@/lib/password-reset'

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

    // Validate password length
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      )
    }

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