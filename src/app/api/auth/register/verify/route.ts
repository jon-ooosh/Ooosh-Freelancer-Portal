import { NextRequest, NextResponse } from 'next/server'
import { validateCode, markVerified } from '@/lib/verification'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { email, code } = body

    // Validate input
    if (!email || !code) {
      return NextResponse.json(
        { error: 'Email and code are required' },
        { status: 400 }
      )
    }

    const normalizedEmail = email.toLowerCase().trim()
    const normalizedCode = code.trim()

    // Validate the code
    const result = validateCode(normalizedEmail, normalizedCode)

    if (!result.valid) {
      return NextResponse.json(
        { error: result.error },
        { status: 400 }
      )
    }

    // Mark as verified (allows password to be set)
    markVerified(normalizedEmail)

    return NextResponse.json({
      success: true,
      message: 'Email verified. Please set your password.',
    })
  } catch (error) {
    console.error('Verification error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
