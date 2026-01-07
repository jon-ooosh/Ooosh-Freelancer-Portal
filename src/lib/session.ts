/**
 * Session Utilities
 * 
 * Server-side utilities for reading and validating session tokens.
 * The session is stored as an HTTP-only cookie containing a JWT.
 */

import { jwtVerify } from 'jose'
import { cookies } from 'next/headers'

// Session payload structure (matches what we store in the JWT)
export interface SessionUser {
  id: string
  email: string
  name: string
}

interface JWTPayload extends SessionUser {
  iat: number
  exp: number
}

/**
 * Get the session secret for JWT verification
 */
function getSessionSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET
  if (!secret) {
    throw new Error('SESSION_SECRET environment variable is not set')
  }
  return new TextEncoder().encode(secret)
}

/**
 * Get the current user from the session cookie
 * 
 * Returns the user object if session is valid, null otherwise.
 * Use this in API routes and server components.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies()
    const sessionToken = cookieStore.get('session')?.value

    if (!sessionToken) {
      return null
    }

    const secret = getSessionSecret()
    const { payload } = await jwtVerify(sessionToken, secret)
    
    // Extract user info from the JWT payload
    const jwtPayload = payload as unknown as JWTPayload
    
    return {
      id: jwtPayload.id,
      email: jwtPayload.email,
      name: jwtPayload.name,
    }
  } catch (error) {
    // Invalid or expired token
    console.error('Session validation error:', error)
    return null
  }
}

/**
 * Require a valid session, returning user or throwing an error
 * 
 * Use this when you want to ensure authentication and handle
 * the error case in a try/catch.
 */
export async function requireSession(): Promise<SessionUser> {
  const user = await getSessionUser()
  
  if (!user) {
    throw new Error('Authentication required')
  }
  
  return user
}
