import { NextRequest, NextResponse } from 'next/server'
import { checkEmailRateLimit } from '@/lib/verification'
import { registerStartOP, isOpClientError, OpApiError } from '@/lib/op-api'

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

    try {
      const result = await registerStartOP(normalizedEmail)
      return NextResponse.json(result)
    } catch (opError: unknown) {
      // Any 4xx (409 already registered, 404 not on approved list, 429
      // rate-limited, etc.) is a legit response — surface as-is.
      if (isOpClientError(opError)) {
        const status = (opError as OpApiError).status
        return NextResponse.json({ error: opError.message }, { status })
      }
      // 5xx / network = real failure. Return generic "code sent" to avoid
      // leaking that OP is down.
      console.error('Register/start: OP backend error:', opError)
      return NextResponse.json({
        success: true,
        message: 'If your email is on our approved list, a verification code is on its way.',
      })
    }
  } catch (error) {
    console.error('Registration start error:', error)
    return NextResponse.json(
      { error: 'An error occurred. Please try again.' },
      { status: 500 }
    )
  }
}
