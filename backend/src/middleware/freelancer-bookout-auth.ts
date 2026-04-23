import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';

// Freelancer book-out authentication.
//
// Two flows:
//
// 1) Redeem (one-shot): The portal mints an HMAC token at /api/jobs/:id/bookout-token
//    and deep-links the driver to OP's /vehicles/book-out?freelancerToken=...
//    OP validates the token via verifyFreelancerBookoutToken() and mints a
//    short-lived bookout session JWT scoped to a specific vehicle_hire_assignment.
//
// 2) Session (ongoing): Subsequent API calls from the freelancer-mode BookOutPage
//    carry the session JWT in the Authorization header. authenticateFreelancerBookout
//    verifies the JWT and attaches the scoped assignment info to the request.
//
// The session JWT is deliberately narrow: it permits only events/photos/signature
// on the ONE assignment it was minted for. It's NOT a general OP session.

export interface FreelancerBookoutSession {
  scope: 'freelancer_bookout';
  assignmentId: string;
  quoteId: string;
  freelancerEmail: string;
  freelancerPersonId: string;
}

export interface FreelancerBookoutRequest extends Request {
  bookoutSession?: FreelancerBookoutSession;
}

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable is required');
}
const JWT_SECRET: string = process.env.JWT_SECRET;

const HMAC_SECRET: string | undefined = process.env.FREELANCER_HUB_SECRET;
const SESSION_TTL_SECONDS = 4 * 60 * 60; // 4h — book-out usually <30min, 4h buffer covers coffee breaks + photo uploads

export interface VerifiedHmacToken {
  expiry: number;
  quoteId: string;
  freelancerEmail: string;
}

/**
 * Verify an HMAC token minted by the portal's bookout-token endpoint.
 *
 * OP-mode format: {expiry}.op.{quoteId}.{driverEmail}.{signature}
 *   - expiry: millisecond timestamp, token invalid after
 *   - quoteId: OP quote UUID
 *   - driverEmail: freelancer's email
 *   - signature: HMAC-SHA256 first 32 chars of all four dot-separated fields
 *
 * Returns parsed payload on success, null on failure (bad format, bad sig, expired).
 * Never throws — caller gets null and responds with 401/403 as they see fit.
 */
export function verifyFreelancerBookoutToken(token: string): VerifiedHmacToken | null {
  if (!HMAC_SECRET) {
    console.error('FREELANCER_HUB_SECRET not set — cannot verify bookout tokens');
    return null;
  }

  const parts = token.split('.');
  // OP mode has 5 parts: {expiry}.op.{quoteId}.{email}.{sig}
  if (parts.length !== 5 || parts[1] !== 'op') {
    return null;
  }

  const [expiryStr, , quoteId, freelancerEmail, signature] = parts;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    return null;
  }

  const payload = `${expiryStr}.op.${quoteId}.${freelancerEmail}`;
  const expectedSig = createHmac('sha256', HMAC_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 32);

  // Constant-time compare — avoid timing side-channels on signature check.
  if (signature.length !== expectedSig.length) return null;
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (diff !== 0) return null;

  return { expiry, quoteId, freelancerEmail };
}

/**
 * Mint a short-lived session JWT for a freelancer to complete book-out
 * on a specific assignment. Scope is intentionally narrow.
 */
export function mintFreelancerBookoutSession(session: Omit<FreelancerBookoutSession, 'scope'>): string {
  return jwt.sign({ scope: 'freelancer_bookout', ...session }, JWT_SECRET, {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

/**
 * Authenticate a request bearing a freelancer book-out session JWT.
 * Rejects anything that isn't scoped 'freelancer_bookout'.
 */
export function authenticateFreelancerBookout(
  req: FreelancerBookoutRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Freelancer book-out session required' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as FreelancerBookoutSession & { iat?: number; exp?: number };
    if (decoded.scope !== 'freelancer_bookout' || !decoded.assignmentId) {
      res.status(401).json({ error: 'Invalid session scope' });
      return;
    }
    req.bookoutSession = {
      scope: 'freelancer_bookout',
      assignmentId: decoded.assignmentId,
      quoteId: decoded.quoteId,
      freelancerEmail: decoded.freelancerEmail,
      freelancerPersonId: decoded.freelancerPersonId,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}
