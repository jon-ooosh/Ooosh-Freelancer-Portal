/**
 * Staff Authentication API with Rate Limiting
 * 
 * POST /api/staff/auth - Verify staff PIN
 * 
 * Rate limiting: 5 failed attempts per IP address within 15 minutes
 * Results in 15 minute lockout.
 * 
 * Also accepts '__HUB_AUTH__' marker for Staff Hub authenticated sessions.
 */

import { NextRequest, NextResponse } from 'next/server'

// =============================================================================
// CONSTANTS
// =============================================================================

// Special marker for hub-authenticated sessions
// When a user authenticates via the Staff Hub, this marker is stored instead of the PIN
const HUB_AUTH_MARKER = '__HUB_AUTH__'

// =============================================================================
// RATE LIMITING (In-Memory)
// =============================================================================

interface RateLimitEntry {
  attempts: number
  lastAttempt: number
  lockedUntil: number | null
}

// In-memory store for rate limiting
// Note: This resets on server restart, which is fine for basic protection
// For production scale, consider Redis or similar
const rateLimitStore = new Map<string, RateLimitEntry>()

const RATE_LIMIT_CONFIG = {
  maxAttempts: 5,           // Max failed attempts before lockout
  windowMs: 15 * 60 * 1000, // 15 minute window
  lockoutMs: 15 * 60 * 1000, // 15 minute lockout
}

/**
 * Get client IP address from request
 */
function getClientIP(request: NextRequest): string {
  // Try various headers that might contain the real IP
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  
  const realIP = request.headers.get('x-real-ip')
  if (realIP) {
    return realIP
  }
  
  // Fallback - not ideal but better than nothing
  return 'unknown'
}

/**
 * Check if IP is rate limited
 */
function isRateLimited(ip: string): { limited: boolean; remainingSeconds?: number } {
  const entry = rateLimitStore.get(ip)
  
  if (!entry) {
    return { limited: false }
  }
  
  const now = Date.now()
  
  // Check if currently locked out
  if (entry.lockedUntil && now < entry.lockedUntil) {
    const remainingSeconds = Math.ceil((entry.lockedUntil - now) / 1000)
    return { limited: true, remainingSeconds }
  }
  
  // Check if outside the window - reset if so
  if (now - entry.lastAttempt > RATE_LIMIT_CONFIG.windowMs) {
    rateLimitStore.delete(ip)
    return { limited: false }
  }
  
  return { limited: false }
}

/**
 * Record a failed attempt
 */
function recordFailedAttempt(ip: string): { lockedOut: boolean; remainingAttempts: number } {
  const now = Date.now()
  const entry = rateLimitStore.get(ip)
  
  if (!entry || now - entry.lastAttempt > RATE_LIMIT_CONFIG.windowMs) {
    // New entry or expired window
    rateLimitStore.set(ip, {
      attempts: 1,
      lastAttempt: now,
      lockedUntil: null,
    })
    return { lockedOut: false, remainingAttempts: RATE_LIMIT_CONFIG.maxAttempts - 1 }
  }
  
  // Increment attempts
  entry.attempts += 1
  entry.lastAttempt = now
  
  // Check if should lock out
  if (entry.attempts >= RATE_LIMIT_CONFIG.maxAttempts) {
    entry.lockedUntil = now + RATE_LIMIT_CONFIG.lockoutMs
    console.warn(`Rate limit: IP ${ip} locked out after ${entry.attempts} failed attempts`)
    return { lockedOut: true, remainingAttempts: 0 }
  }
  
  rateLimitStore.set(ip, entry)
  return { 
    lockedOut: false, 
    remainingAttempts: RATE_LIMIT_CONFIG.maxAttempts - entry.attempts 
  }
}

/**
 * Clear rate limit on successful auth
 */
function clearRateLimit(ip: string): void {
  rateLimitStore.delete(ip)
}

// =============================================================================
// POST HANDLER
// =============================================================================

export async function POST(request: NextRequest) {
  const clientIP = getClientIP(request)
  
  // Check if rate limited
  const rateLimitCheck = isRateLimited(clientIP)
  if (rateLimitCheck.limited) {
    console.warn(`Rate limit: Blocked request from ${clientIP}, locked for ${rateLimitCheck.remainingSeconds}s`)
    return NextResponse.json(
      { 
        success: false, 
        error: `Too many failed attempts. Please try again in ${Math.ceil(rateLimitCheck.remainingSeconds! / 60)} minutes.`,
        lockedOut: true,
        remainingSeconds: rateLimitCheck.remainingSeconds,
      },
      { status: 429 }
    )
  }

  try {
    const { pin } = await request.json()
    
    // Validate input
    if (!pin || typeof pin !== 'string') {
      return NextResponse.json(
        { success: false, error: 'PIN is required' },
        { status: 400 }
      )
    }

    // Get staff PIN from environment
    const staffPin = process.env.STAFF_PIN
    
    if (!staffPin) {
      console.error('STAFF_PIN environment variable not set')
      return NextResponse.json(
        { success: false, error: 'Server configuration error' },
        { status: 500 }
      )
    }

    // Verify PIN (also accept hub auth marker for Staff Hub sessions)
    if (pin === staffPin || pin === HUB_AUTH_MARKER) {
      // Success - clear any rate limiting for this IP
      clearRateLimit(clientIP)
      
      return NextResponse.json({
        success: true,
        message: 'Authenticated',
      })
    } else {
      // Failed attempt - record for rate limiting
      const result = recordFailedAttempt(clientIP)
      
      if (result.lockedOut) {
        return NextResponse.json(
          { 
            success: false, 
            error: `Too many failed attempts. Please try again in 15 minutes.`,
            lockedOut: true,
          },
          { status: 429 }
        )
      }
      
      return NextResponse.json(
        { 
          success: false, 
          error: 'Incorrect PIN',
          remainingAttempts: result.remainingAttempts,
        },
        { status: 401 }
      )
    }
  } catch (error) {
    console.error('Staff auth error:', error)
    return NextResponse.json(
      { success: false, error: 'Authentication failed' },
      { status: 500 }
    )
  }
}