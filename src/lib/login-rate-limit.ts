/**
 * Shared login rate-limit store (freelancer portal).
 *
 * Tracks failed login attempts per email and locks an account out for a
 * cooldown window once the threshold is reached.
 *
 * IMPORTANT — this is in-memory and therefore PER serverless instance. It is
 * not shared across lambda instances and resets on cold start. That's an
 * accepted limitation: it's enough to throttle a single warm instance and,
 * crucially, lets the reset-password route clear the counter after a
 * successful reset so a fresh login with the new password isn't wrongly
 * blocked. It lives in a shared module (rather than inline in the login
 * route) precisely so both the login and reset-password routes operate on
 * the same Map within a given instance.
 */

interface AttemptRecord {
  count: number
  lastAttempt: number
}

const loginAttempts = new Map<string, AttemptRecord>()

export const MAX_ATTEMPTS = 5
const LOCKOUT_DURATION = 15 * 60 * 1000 // 15 minutes

function key(email: string): string {
  return email.toLowerCase().trim()
}

/**
 * Returns whether a login may proceed and how many attempts remain before
 * lockout. A locked-out account returns `{ allowed: false, remainingAttempts: 0 }`.
 */
export function checkRateLimit(email: string): { allowed: boolean; remainingAttempts: number } {
  const now = Date.now()
  const attempts = loginAttempts.get(key(email))

  if (!attempts) {
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS }
  }

  // Reset once the cooldown window has fully elapsed since the last attempt.
  if (now - attempts.lastAttempt > LOCKOUT_DURATION) {
    loginAttempts.delete(key(email))
    return { allowed: true, remainingAttempts: MAX_ATTEMPTS }
  }

  if (attempts.count >= MAX_ATTEMPTS) {
    return { allowed: false, remainingAttempts: 0 }
  }

  return { allowed: true, remainingAttempts: MAX_ATTEMPTS - attempts.count }
}

/**
 * Records a failed attempt and returns how many attempts remain before the
 * account is locked out (0 means this attempt tipped it into lockout).
 */
export function recordFailedAttempt(email: string): number {
  const now = Date.now()
  const attempts = loginAttempts.get(key(email))

  if (!attempts) {
    loginAttempts.set(key(email), { count: 1, lastAttempt: now })
    return MAX_ATTEMPTS - 1
  }

  const count = attempts.count + 1
  loginAttempts.set(key(email), { count, lastAttempt: now })
  return Math.max(0, MAX_ATTEMPTS - count)
}

/**
 * Clears the failed-attempt counter for an email. Call after any event that
 * proves legitimate access — a successful login OR a successful password
 * reset — so the user isn't blocked by stale failures from before they
 * recovered their account.
 */
export function clearFailedAttempts(email: string): void {
  loginAttempts.delete(key(email))
}
