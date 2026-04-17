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
import { isOpMode, verifyResetTokenOP, reportFallback } from '@/lib/op-api'

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
        console.error('Verify-reset-token: OP backend error, falling back:', opError)
        reportFallback('verify-reset-token', opError)
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
