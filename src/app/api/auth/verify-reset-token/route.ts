/**
 * Verify Reset Token API Endpoint
 * 
 * GET /api/auth/verify-reset-token?token=xxx
 * 
 * Checks if a password reset token is valid without consuming it.
 * Used by the reset-password page to validate the token before showing the form.
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateResetToken } from '@/lib/password-reset'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json({ valid: false })
    }

    const tokenData = validateResetToken(token)

    return NextResponse.json({
      valid: !!tokenData,
    })

  } catch (error) {
    console.error('Verify reset token error:', error)
    return NextResponse.json({ valid: false })
  }
}