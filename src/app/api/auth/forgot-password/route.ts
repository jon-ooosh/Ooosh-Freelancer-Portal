/**
 * Forgot Password API Endpoint
 *
 * POST /api/auth/forgot-password
 *
 * Initiates a password reset on the OP backend, which generates the token and
 * sends the reset email. Always returns success to prevent email enumeration
 * attacks.
 */

import { NextRequest, NextResponse } from 'next/server'
import { checkResetRateLimit } from '@/lib/password-reset'
import { forgotPasswordOP, isOpClientError } from '@/lib/op-api'

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

    try {
      const result = await forgotPasswordOP(normalizedEmail)
      return NextResponse.json(result)
    } catch (opError) {
      // 4xx is a legit negative response from OP (e.g. rate limit) — still
      // return the anti-enumeration generic response so we don't leak.
      if (isOpClientError(opError)) {
        return NextResponse.json({
          success: true,
          message: 'If your email is on our approved list, a reset link is on its way.',
        })
      }
      // 5xx / network — don't leak that OP is down. Return the generic
      // response so the attacker can't enumerate emails.
      console.error('Forgot-password: OP backend error:', opError)
      return NextResponse.json({
        success: true,
        message: 'If your email is on our approved list, a reset link is on its way.',
      })
    }
  } catch (error) {
    console.error('Forgot password error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
