/**
 * Password Reset Utilities
 * 
 * Handles generation, storage, and validation of password reset tokens.
 * 
 * In production, consider using Redis or a database for token storage.
 * This in-memory implementation works for single-instance deployments.
 */

import { randomBytes } from 'crypto'

// =============================================================================
// TYPES
// =============================================================================

export interface ResetToken {
  email: string
  freelancerId: string
  createdAt: number
  expiresAt: number
}

// =============================================================================
// TOKEN STORAGE
// =============================================================================

// In-memory token storage (cleared on server restart)
// Key: token string, Value: ResetToken data
const resetTokens = new Map<string, ResetToken>()

// Token expiration time (1 hour)
const TOKEN_EXPIRY_MS = 60 * 60 * 1000

// Rate limiting: max 3 reset requests per email per hour
const resetRequests = new Map<string, { count: number; firstRequest: number }>()
const MAX_REQUESTS_PER_HOUR = 3

// =============================================================================
// TOKEN FUNCTIONS
// =============================================================================

/**
 * Generate a secure random token
 */
function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Check if an email has exceeded the rate limit for reset requests
 */
export function checkResetRateLimit(email: string): boolean {
  const now = Date.now()
  const normalizedEmail = email.toLowerCase().trim()
  const record = resetRequests.get(normalizedEmail)

  if (!record) {
    return true // No previous requests, allowed
  }

  // Reset if an hour has passed since first request
  if (now - record.firstRequest > 60 * 60 * 1000) {
    resetRequests.delete(normalizedEmail)
    return true
  }

  // Check if under the limit
  return record.count < MAX_REQUESTS_PER_HOUR
}

/**
 * Record a reset request for rate limiting
 */
function recordResetRequest(email: string): void {
  const now = Date.now()
  const normalizedEmail = email.toLowerCase().trim()
  const record = resetRequests.get(normalizedEmail)

  if (!record || now - record.firstRequest > 60 * 60 * 1000) {
    resetRequests.set(normalizedEmail, { count: 1, firstRequest: now })
  } else {
    resetRequests.set(normalizedEmail, { count: record.count + 1, firstRequest: record.firstRequest })
  }
}

/**
 * Create a password reset token for a user
 * 
 * @param email - User's email address
 * @param freelancerId - User's Monday.com item ID
 * @returns The generated token string
 */
export function createResetToken(email: string, freelancerId: string): string {
  const normalizedEmail = email.toLowerCase().trim()
  
  // Record the request for rate limiting
  recordResetRequest(normalizedEmail)

  // Invalidate any existing tokens for this email
  const tokensToDelete: string[] = []
  resetTokens.forEach((data, token) => {
    if (data.email === normalizedEmail) {
      tokensToDelete.push(token)
    }
  })
  tokensToDelete.forEach(token => resetTokens.delete(token))

  // Generate new token
  const token = generateToken()
  const now = Date.now()

  resetTokens.set(token, {
    email: normalizedEmail,
    freelancerId,
    createdAt: now,
    expiresAt: now + TOKEN_EXPIRY_MS,
  })

  // Clean up expired tokens periodically
  cleanupExpiredTokens()

  return token
}

/**
 * Validate a reset token
 * 
 * @param token - The token to validate
 * @returns The token data if valid, null otherwise
 */
export function validateResetToken(token: string): ResetToken | null {
  const data = resetTokens.get(token)

  if (!data) {
    return null
  }

  // Check if expired
  if (Date.now() > data.expiresAt) {
    resetTokens.delete(token)
    return null
  }

  return data
}

/**
 * Consume (use and invalidate) a reset token
 * 
 * @param token - The token to consume
 * @returns The token data if valid, null otherwise
 */
export function consumeResetToken(token: string): ResetToken | null {
  const data = validateResetToken(token)

  if (data) {
    resetTokens.delete(token)
  }

  return data
}

/**
 * Clean up expired tokens
 */
function cleanupExpiredTokens(): void {
  const now = Date.now()
  
  // Collect tokens to delete (can't delete while iterating)
  const expiredTokens: string[] = []
  resetTokens.forEach((data, token) => {
    if (now > data.expiresAt) {
      expiredTokens.push(token)
    }
  })
  expiredTokens.forEach(token => resetTokens.delete(token))

  // Clean up old rate limit records
  const expiredEmails: string[] = []
  resetRequests.forEach((record, email) => {
    if (now - record.firstRequest > 60 * 60 * 1000) {
      expiredEmails.push(email)
    }
  })
  expiredEmails.forEach(email => resetRequests.delete(email))
}