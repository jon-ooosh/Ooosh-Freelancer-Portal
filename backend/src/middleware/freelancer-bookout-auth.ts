import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { query } from '../config/database';

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
  /**
   * Which side of the hire this session is for. 'bookout' (default) = a
   * delivery hand-over; 'checkin' = a collection / soft check-in. The token
   * format + scope are shared; the resolve ENDPOINT sets the mode, and
   * endpoints that behave differently on collection (soft check-in, no
   * 'returned' flip) branch on it. Absent on pre-existing sessions → 'bookout'.
   */
  mode?: 'bookout' | 'checkin';
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
    console.error('[freelancer-bookout] FREELANCER_HUB_SECRET not set — cannot verify bookout tokens');
    return null;
  }

  // Token format: {expiry}.op.{quoteId}.{email}.{signature}
  // The email contains dots ("info@oooshtours.co.uk" → two dots), so a
  // naive split('.') produces 5 + N parts where N is the dot-count in
  // the email. Parse positionally instead: first three parts are fixed
  // (expiry / "op" / UUID quoteId), last part is the signature, and
  // everything between is the email re-joined with dots.
  const parts = token.split('.');
  if (parts.length < 5 || parts[1] !== 'op') {
    console.warn('[freelancer-bookout] Token rejected: bad shape', {
      partCount: parts.length,
      marker: parts[1],
    });
    return null;
  }

  const expiryStr = parts[0];
  const quoteId = parts[2];
  const signature = parts[parts.length - 1];
  const freelancerEmail = parts.slice(3, parts.length - 1).join('.');

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) {
    console.warn('[freelancer-bookout] Token rejected: expired or non-numeric expiry', {
      expiryStr,
      now: Date.now(),
    });
    return null;
  }

  const payload = `${expiryStr}.op.${quoteId}.${freelancerEmail}`;
  const expectedSig = createHmac('sha256', HMAC_SECRET)
    .update(payload)
    .digest('hex')
    .substring(0, 32);

  // Constant-time compare — avoid timing side-channels on signature check.
  if (signature.length !== expectedSig.length) {
    console.warn('[freelancer-bookout] Token rejected: signature length mismatch (likely secret mismatch between portal and OP)');
    return null;
  }
  let diff = 0;
  for (let i = 0; i < signature.length; i++) {
    diff |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i);
  }
  if (diff !== 0) {
    console.warn('[freelancer-bookout] Token rejected: signature mismatch (FREELANCER_HUB_SECRET differs between portal and OP, or token tampered)');
    return null;
  }

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
      mode: decoded.mode ?? 'bookout',
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

/**
 * Flexible auth for vehicle routes that need to accept BOTH staff and
 * freelancer sessions. Tries the staff-JWT shape first (regular `AuthUser`
 * payload); on failure falls back to the freelancer bookout session.
 *
 * Attaches `req.user` for staff or `req.bookoutSession` for freelancers —
 * NEVER both. Endpoints can branch on which one is present to enforce
 * scope (e.g. a freelancer can only touch their own assignment's vehicle,
 * staff can do anything).
 *
 * Import type as:
 *   import type { FlexibleVehicleRequest } from '...freelancer-bookout-auth';
 */
export interface FlexibleVehicleRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
  };
  bookoutSession?: FreelancerBookoutSession;
}

export function authenticateVehicleFlexible(
  req: FlexibleVehicleRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const token = authHeader.slice(7);

  let decoded: { scope?: string; [k: string]: unknown };
  try {
    decoded = jwt.verify(token, JWT_SECRET) as { scope?: string; [k: string]: unknown };
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Freelancer bookout session — narrow scope, assignment-bound.
  if (decoded.scope === 'freelancer_bookout') {
    const fb = decoded as unknown as FreelancerBookoutSession;
    if (!fb.assignmentId) {
      res.status(401).json({ error: 'Invalid session scope' });
      return;
    }
    req.bookoutSession = {
      scope: 'freelancer_bookout',
      assignmentId: fb.assignmentId,
      quoteId: fb.quoteId,
      freelancerEmail: fb.freelancerEmail,
      freelancerPersonId: fb.freelancerPersonId,
      mode: fb.mode ?? 'bookout',
    };
    next();
    return;
  }

  // Staff JWT — shape: { id, email, role }
  const staff = decoded as { id?: string; email?: string; role?: string };
  if (staff.id && staff.email && staff.role) {
    req.user = { id: staff.id, email: staff.email, role: staff.role };
    next();
    return;
  }

  res.status(401).json({ error: 'Invalid token' });
}

/**
 * True if the request is authenticated as a freelancer book-out session
 * (as opposed to a staff user). Use inside handlers to branch behaviour
 * for scope enforcement.
 */
export function isFreelancerBookout(req: FlexibleVehicleRequest): req is FlexibleVehicleRequest & { bookoutSession: FreelancerBookoutSession } {
  return !!req.bookoutSession && !req.user;
}

/**
 * For a freelancer session, load the assignment's vehicle reg + job
 * details so handlers can verify callers are only touching their own
 * scope. Cached on the request for the lifetime of the call.
 *
 * Shared between vehicles routes (book-out, photos, signature) and
 * hire-forms routes (the freelancer-mode write-back at book-out).
 *
 * Returns null if the request isn't a freelancer session, or if the
 * assignment row has been deleted/cancelled out from under the JWT.
 */
export interface BookoutScope {
  assignmentId: string;
  vehicleId: string;
  registration: string;
  hhJobNumber: number | null;
  jobId: string | null;
}

export async function getBookoutScope(req: FlexibleVehicleRequest): Promise<BookoutScope | null> {
  if (!req.bookoutSession) return null;
  const cache = (req as FlexibleVehicleRequest & { _bookoutScope?: unknown })._bookoutScope;
  if (cache) return cache as BookoutScope;

  const result = await query(
    `SELECT vha.id, vha.vehicle_id, fv.reg, vha.hirehop_job_id, vha.job_id
       FROM vehicle_hire_assignments vha
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
      WHERE vha.id = $1
      LIMIT 1`,
    [req.bookoutSession.assignmentId]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  if (!row.vehicle_id || !row.reg) {
    // Session JWT was minted against an assignment whose vehicle has been
    // unlinked since. Treat as no scope — caller responds with 403 / 404
    // rather than letting downstream handlers run with a half-resolved
    // scope.
    return null;
  }
  const scope: BookoutScope = {
    assignmentId: req.bookoutSession.assignmentId,
    vehicleId: row.vehicle_id as string,
    registration: (row.reg as string).toUpperCase(),
    hhJobNumber: row.hirehop_job_id as number | null,
    jobId: row.job_id as string | null,
  };
  (req as FlexibleVehicleRequest & { _bookoutScope?: unknown })._bookoutScope = scope;
  return scope;
}
