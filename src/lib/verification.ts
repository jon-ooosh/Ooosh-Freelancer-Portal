/**
 * Verification Code Store
 * 
 * Manages temporary verification codes for registration and password reset.
 * 
 * NOTE: This in-memory store works for single-instance deployments but will
 * NOT work reliably with multiple serverless function instances. For production
 * scale, consider using Redis or storing codes in Monday.com.
 * 
 * For Ooosh's scale (~60 freelancers), this should work fine initially.
 */

export interface VerificationRecord {
  code: string
  email: string
  freelancerId: string
  freelancerName: string
  createdAt: number
  attempts: number
  verified: boolean  // Set to true after code is verified, before password is set
}

// In-memory store for verification codes
// Key: email (lowercase), Value: verification record
const verificationCodes = new Map<string, VerificationRecord>()

// Constants
export const CODE_EXPIRY_MS = 15 * 60 * 1000 // 15 minutes
export const MAX_CODE_ATTEMPTS = 5
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000 // 1 hour
const MAX_EMAILS_PER_WINDOW = 3

// Track email send rate limits
const emailRateLimits = new Map<string, { count: number; windowStart: number }>()

/**
 * Generate a 6-digit verification code
 */
export function generateVerificationCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString()
}

/**
 * Clean up expired codes
 */
export function cleanExpiredCodes(): void {
  const now = Date.now()
  const expiredEmails: string[] = []
  
  verificationCodes.forEach((record, email) => {
    if (now - record.createdAt > CODE_EXPIRY_MS) {
      expiredEmails.push(email)
    }
  })
  
  expiredEmails.forEach(email => verificationCodes.delete(email))
}

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

/**
 * Store a verification code
 */
export function storeVerificationCode(
  email: string,
  code: string,
  freelancerId: string,
  freelancerName: string
): void {
  verificationCodes.set(email.toLowerCase(), {
    code,
    email: email.toLowerCase(),
    freelancerId,
    freelancerName,
    createdAt: Date.now(),
    attempts: 0,
    verified: false,
  })
}

/**
 * Get a verification record
 */
export function getVerificationRecord(email: string): VerificationRecord | undefined {
  cleanExpiredCodes()
  return verificationCodes.get(email.toLowerCase())
}

/**
 * Mark a verification record as verified (code was correct)
 */
export function markVerified(email: string): void {
  const record = verificationCodes.get(email.toLowerCase())
  if (record) {
    record.verified = true
  }
}

/**
 * Increment failed verification attempts
 */
export function incrementVerificationAttempts(email: string): number {
  const record = verificationCodes.get(email.toLowerCase())
  if (record) {
    record.attempts++
    return record.attempts
  }
  return 0
}

/**
 * Delete a verification record
 */
export function deleteVerificationRecord(email: string): void {
  verificationCodes.delete(email.toLowerCase())
}

/**
 * Check if a code is valid
 */
export function validateCode(email: string, code: string): { 
  valid: boolean
  error?: string
  record?: VerificationRecord
} {
  cleanExpiredCodes()
  
  const record = verificationCodes.get(email.toLowerCase())
  
  if (!record) {
    return { valid: false, error: 'No verification in progress. Please start again.' }
  }
  
  if (Date.now() - record.createdAt > CODE_EXPIRY_MS) {
    deleteVerificationRecord(email)
    return { valid: false, error: 'Code has expired. Please request a new one.' }
  }
  
  if (record.attempts >= MAX_CODE_ATTEMPTS) {
    deleteVerificationRecord(email)
    return { valid: false, error: 'Too many attempts. Please request a new code.' }
  }
  
  if (record.code !== code) {
    incrementVerificationAttempts(email)
    const remaining = MAX_CODE_ATTEMPTS - record.attempts - 1
    return { 
      valid: false, 
      error: remaining > 0 
        ? `Invalid code. ${remaining} attempts remaining.`
        : 'Invalid code. Please request a new one.'
    }
  }
  
  return { valid: true, record }
}
