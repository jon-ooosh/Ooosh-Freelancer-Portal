/**
 * Verify Reset Token API Endpoint
 *
 * GET /api/auth/verify-reset-token?token=xxx
 *
 * Checks if a password reset token is valid without consuming it. The
 * reset-password page calls this on load to decide whether to show the
 * form or the "expired" message. Tokens live in OP's
 * portal_password_reset_tokens table.
 */

import { NextRequest, NextResponse } from 'next/server'
import { verifyResetTokenOP, isOpClientError } from '@/lib/op-api'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json({ valid: false })
    }

    try {
      const result = await verifyResetTokenOP(token)
      return NextResponse.json(result)
    } catch (opError) {
      // 4xx (token not found / expired) is a legit "no" answer — return
      // {valid: false} cleanly.
      if (isOpClientError(opError)) {
        return NextResponse.json({ valid: false })
      }
      console.error('Verify-reset-token: OP backend error:', opError)
      return NextResponse.json({ valid: false })
    }
  } catch (error) {
    console.error('Verify reset token error:', error)
    return NextResponse.json({ valid: false })
  }
}
