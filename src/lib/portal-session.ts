/**
 * Signing in: the session cookie and the remembered-phone cookie
 * (two-step sign-in, docs/FREELANCER-PORTAL-SPEC.md §7, Oct 2026).
 *
 * The session is signed here with SESSION_SECRET so the middleware accepts it
 * (see api/auth/login/route.ts for why OP's own token is not used).
 *
 * `portal_device` is OP's remembered-phone pass. OP signs it and owns the
 * record behind it ("Sign them out everywhere" in OP forgets it); the portal
 * only keeps it, httpOnly, and hands it back to OP at the next sign-in. It is
 * scoped to /api/auth, the only place that needs it, and it survives signing
 * out: that is the point of remembering the phone.
 */

import { SignJWT } from 'jose'
import type { NextRequest, NextResponse } from 'next/server'

export const DEVICE_COOKIE = 'portal_device'
const DEVICE_DAYS = 90

const getSessionSecret = () => {
  const secret = process.env.SESSION_SECRET
  if (!secret) throw new Error('SESSION_SECRET environment variable is not set')
  return new TextEncoder().encode(secret)
}

/** Sign the user in on this response: the same cookie login, sign-up and reset set. */
export async function setPortalSession(
  response: NextResponse,
  user: { id: string; name: string; email: string },
): Promise<void> {
  const sessionToken = await new SignJWT({ id: user.id, email: user.email, name: user.name })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(getSessionSecret())
  response.cookies.set('session', sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60,
    path: '/',
  })
}

/** Keep OP's remembered-phone pass, when OP gave one ("Remember this phone" was ticked). */
export function setDeviceCookie(response: NextResponse, deviceToken: string | undefined): void {
  if (!deviceToken) return
  response.cookies.set(DEVICE_COOKIE, deviceToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: DEVICE_DAYS * 24 * 60 * 60,
    path: '/api/auth',
  })
}

export function readDeviceCookie(request: NextRequest): string | undefined {
  return request.cookies.get(DEVICE_COOKIE)?.value || undefined
}

/** The phone's user agent: OP uses it only to name the phone in the code email ("iPhone · Safari"). */
export function clientUserAgent(request: NextRequest): string | undefined {
  return request.headers.get('user-agent')?.slice(0, 400) || undefined
}
