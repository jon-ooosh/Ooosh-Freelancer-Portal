/**
 * Registration email rate limit (freelancer portal).
 *
 * At most 3 verification-code emails per address per hour, per serverless
 * instance (in memory, so it resets on a cold start; OP limits per IP as well).
 * The Monday-era in-memory code store that used to live here went in Oct 2026:
 * codes are issued, stored and checked by OP (/api/portal/auth/register/*).
 */

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_EMAILS_PER_WINDOW = 3

const emailRateLimits = new Map<string, { count: number; windowStart: number }>()

/**
 * Check if we can send another email to this address
 */
export function checkEmailRateLimit(email: string): boolean {
  const normalizedEmail = email.toLowerCase()
  const now = Date.now()
  const limit = emailRateLimits.get(normalizedEmail)
  
  if (!limit || now - limit.windowStart > RATE_LIMIT_WINDOW_MS) {
    // Start new window
    emailRateLimits.set(normalizedEmail, { count: 1, windowStart: now })
    return true
  }
  
  if (limit.count >= MAX_EMAILS_PER_WINDOW) {
    return false
  }
  
  limit.count++
  return true
}
