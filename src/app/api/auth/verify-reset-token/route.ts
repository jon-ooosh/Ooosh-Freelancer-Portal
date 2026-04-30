/**
 * Verify Reset Token API Endpoint
 *
 * GET /api/auth/verify-reset-token?token=xxx
 *
 * Checks if a password reset token is valid without consuming it. The
 * reset-password page calls this on load to decide whether to show the
 * form or the "expired" message.
 *
 * In OP mode tokens live in OP's portal_password_reset_tokens table —
 * the in-memory Map is Monday-era only and always returns invalid for
 * OP-issued links.
 */

import { NextRequest, NextResponse } from 'next/server'
import { validateResetToken } from '@/lib/password-reset'
import { isOpMode, verifyResetTokenOP, reportFallback, mondayFallbackAllowed, isOpClientError } from '@/lib/op-api'

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token) {
      return NextResponse.json({ valid: false })
    }

    // ── OP Backend mode ──────────────────────────────────────────
    if (isOpMode()) {
      try {
        const result = await verifyResetTokenOP(token)
        return NextResponse.json(result)
      } catch (opError) {
        // 4xx (token not found / expired) is a legit "no" answer — return
        // {valid: false} cleanly without alerting or hitting Monday.
        if (isOpClientError(opError)) {
          return NextResponse.json({ valid: false })
        }
        console.error('Verify-reset-token: OP backend error, falling back:', opError)
        reportFallback('verify-reset-token', opError)
        if (!mondayFallbackAllowed()) {
          return NextResponse.json({ valid: false })
        }
      }
    }
    // ── End OP Backend mode ──────────────────────────────────────

    const tokenData = validateResetToken(token)

    return NextResponse.json({
      valid: !!tokenData,
    })

  } catch (error) {
    console.error('Verify reset token error:', error)
    return NextResponse.json({ valid: false })
  }
}
