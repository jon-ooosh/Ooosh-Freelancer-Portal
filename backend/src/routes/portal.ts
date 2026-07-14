/**
 * Portal API Routes — Freelancer Portal Backend
 *
 * These endpoints serve the freelancer-facing Next.js portal app,
 * replacing Monday.com as the data source. The portal authenticates
 * via its own JWT session cookie (not the OP staff JWT).
 *
 * Auth: Portal session JWT (HS256, signed with PORTAL_SESSION_SECRET)
 * Access: Freelancers see only jobs assigned to them via quote_assignments.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import crypto from 'crypto';
import { query } from '../config/database';
import { hhBroker } from '../services/hirehop-broker';
import { emailService } from '../services/email-service';
import { resolveClientEmailTarget, buildFallbackBanner, logFallbackToTimeline } from '../services/money-emails';
import { uploadToR2, isR2Configured, getPresignedDownloadUrl } from '../config/r2';
import { generateDeliveryNotePdf, DeliveryNoteItem } from '../services/delivery-note-pdf';
import { getSitterShifts, getSitterShiftDetail, isSitterAssignedTo } from '../services/studio-sitter';

// Stable UUID seeded by migration 031 — used as created_by for portal-driven
// auto-actions (the freelancer is a `people` row, not a `users` row, so we
// can't attribute interactions directly to them).
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// ── Freelancer "your money on this job" derivation ──────────────────────────
// Turns a quote's three-state expense lines into plain, freelancer-facing
// instructions so it's crystal clear what they pay, claim, and get paid — and
// so we know what to expect when their invoice lands. Per Diem ALWAYS produces
// a line (incl. "No Per Diems on this job"); other lines only when they apply.
type CrewMoneyTone = 'ooosh' | 'client' | 'claim' | 'none';
interface CrewMoneyLine { label: string; message: string; tone: CrewMoneyTone }
interface CrewMoney { perDiem: CrewMoneyLine; expenses: CrewMoneyLine[] }

const CREW_EXPENSE_LABELS: Record<string, string> = {
  fuel: 'Fuel', parking: 'Parking', tolls: 'Tolls / crossings',
  transport_out: 'Travel (outbound)', transport_back: 'Travel (return)',
  hotel: 'Hotel', other: 'Other',
};
const CREW_FRONTED = new Set(['fuel', 'parking', 'tolls']);       // freelancer pays, claims on invoice
const CREW_PREBOOKED = new Set(['transport_out', 'transport_back', 'hotel']); // Ooosh arranges/pays up front

function crewExpenseMode(e: any): 'included' | 'not_included' | 'recharge' | 'na' {
  if (e?.chargeMode) return e.chargeMode;
  return e?.includedInCharge === false ? 'not_included' : 'included';
}

function deriveCrewMoney(rawExpenses: unknown): CrewMoney {
  let arr: any[] = [];
  try {
    arr = Array.isArray(rawExpenses) ? rawExpenses
      : (typeof rawExpenses === 'string' && rawExpenses ? JSON.parse(rawExpenses) : []);
  } catch { arr = []; }

  // Per Diem — always a line.
  const pd = arr.find((e) => e?.type === 'pd');
  const pdMode = pd ? crewExpenseMode(pd) : 'na';
  const pdAmt = Number(pd?.amount || 0);
  const pdAmtStr = pdAmt > 0 ? ` (£${pdAmt.toFixed(0)})` : '';
  let perDiem: CrewMoneyLine;
  if (!pd || pdMode === 'na') {
    perDiem = { label: 'Per Diem', message: 'No Per Diems on this job.', tone: 'none' };
  } else if (pdMode === 'not_included') {
    perDiem = { label: 'Per Diem', message: `The client is paying your Per Diem${pdAmtStr} directly.`, tone: 'client' };
  } else {
    perDiem = { label: 'Per Diem', message: `We're paying your Per Diem${pdAmtStr} — please include it on your invoice to us.`, tone: 'ooosh' };
  }

  // Other expense lines — only when they apply (mode ≠ na and amount > 0).
  const expenses: CrewMoneyLine[] = [];
  for (const e of arr) {
    const type = String(e?.type || '');
    if (type === 'pd') continue;
    const mode = crewExpenseMode(e);
    if (mode === 'na') continue;
    if (!(Number(e?.amount || 0) > 0)) continue;
    const label = CREW_EXPENSE_LABELS[type] || (e?.description ? String(e.description) : 'Other');
    const lower = label.toLowerCase();
    let message: string; let tone: CrewMoneyTone;
    if (mode === 'not_included') {
      message = CREW_PREBOOKED.has(type)
        ? `The client is arranging & paying the ${lower} directly.`
        : `The client covers ${lower} directly — nothing for you to pay or claim.`;
      tone = 'client';
    } else if (CREW_FRONTED.has(type)) {
      message = `Pay for the ${lower} yourself and include it on your invoice to us.`;
      tone = 'claim';
    } else if (CREW_PREBOOKED.has(type)) {
      message = `${label} is booked & paid by Ooosh — nothing for you to arrange.`;
      tone = 'ooosh';
    } else {
      message = `Include the ${lower} on your invoice to us.`;
      tone = 'claim';
    }
    expenses.push({ label, message, tone });
  }
  return { perDiem, expenses };
}

const router = Router();

// ── Portal auth middleware (separate from OP staff auth) ──────────────

interface PortalUser {
  id: string;       // person_id from people table
  email: string;
  name: string;
  /** true = shared staff login (e.g. info@), sees all Ooosh-crew assignments */
  isStaffShared: boolean;
}

interface PortalRequest extends Request {
  portalUser?: PortalUser;
}

const PORTAL_SECRET = process.env.PORTAL_SESSION_SECRET || process.env.SESSION_SECRET || process.env.JWT_SECRET!;

async function portalAuth(req: PortalRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Check session cookie first, then Authorization header
    const token = req.cookies?.session ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    const decoded = jwt.verify(token, PORTAL_SECRET) as { id: string; email: string; name: string; iat: number; exp: number };

    // Look up the shared-account flag fresh on every request — the JWT was
    // minted before the flag existed for some tokens, and this lets us
    // toggle staff access by updating the DB without forcing re-login.
    const flagResult = await query(
      `SELECT is_portal_shared_account FROM people WHERE id = $1`,
      [decoded.id]
    );

    req.portalUser = {
      id: decoded.id,
      email: decoded.email,
      name: decoded.name,
      isStaffShared: flagResult.rows[0]?.is_portal_shared_account === true,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session' });
  }
}

// ── POST /api/portal/auth/login — freelancer login ───────────────────

/**
 * Quotes are UUIDs. Some portal clients (old sessions, Monday fallback
 * round-trips, cached local state) still hand the endpoints a Monday
 * item ID (11-digit int) as the `quoteId`. Without a shape check the
 * UUID cast in the query throws and the endpoint 500s — which triggers
 * a silent Monday fallback on the portal side and a telemetry alert.
 * Cleanly 404 non-UUIDs so legacy IDs are harmless.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuidLike(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value);
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/auth/login', async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const { email, password } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    // Find freelancer in people table
    const result = await query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.portal_password_hash,
              p.is_freelancer, p.is_approved, p.portal_email_verified
       FROM people p
       WHERE LOWER(p.email) = $1 AND p.is_freelancer = true AND p.is_deleted = false
       ORDER BY p.is_approved DESC, p.portal_last_login DESC NULLS LAST
       LIMIT 1`,
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const freelancer = result.rows[0];

    // Check if they have a portal password set
    if (!freelancer.portal_password_hash) {
      // Fallback: check if they have a user account in the OP
      const userResult = await query(
        `SELECT u.password_hash FROM users u
         JOIN people p ON p.id = u.person_id
         WHERE LOWER(u.email) = $1 AND u.is_active = true`,
        [normalizedEmail]
      );

      if (userResult.rows.length > 0) {
        const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
        if (!valid) {
          res.status(401).json({ error: 'Invalid email or password' });
          return;
        }
      } else {
        res.status(401).json({ error: 'Account not set up. Please register first.' });
        return;
      }
    } else {
      const valid = await bcrypt.compare(password, freelancer.portal_password_hash);
      if (!valid) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
    }

    const name = `${freelancer.first_name} ${freelancer.last_name}`.trim();

    // Create session token (compatible with portal's jose-based verification)
    const sessionToken = jwt.sign(
      { id: freelancer.id, email: freelancer.email || normalizedEmail, name },
      PORTAL_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    // Set as cookie (matching portal's existing cookie format)
    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      path: '/',
    });

    // Update last login timestamp (fire and forget)
    query(
      'UPDATE people SET portal_last_login = NOW() WHERE id = $1',
      [freelancer.id]
    ).catch(err => console.error('Failed to update portal_last_login:', err));

    res.json({
      success: true,
      user: {
        id: freelancer.id,
        name,
        email: freelancer.email || normalizedEmail,
      },
    });
  } catch (error) {
    console.error('Portal login error:', error);
    res.status(500).json({ error: 'An error occurred during login' });
  }
});

// ── POST /api/portal/auth/logout ─────────────────────────────────────

router.post('/auth/logout', (_req: Request, res: Response) => {
  res.clearCookie('session', { path: '/' });
  res.json({ success: true });
});

// ── Registration: gate check + OTP ───────────────────────────────────
// Mirrors the two-tick Monday.com gate but against the OP people table:
// is_freelancer = true AND is_approved = true.

const registerStartSchema = z.object({
  email: z.string().email(),
});

router.post('/auth/register/start', async (req: Request, res: Response) => {
  try {
    const parsed = registerStartSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid email address is required' });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();

    // Two-tick gate: must be an approved freelancer in the people table
    const result = await query(
      `SELECT id, first_name, last_name, email, portal_password_hash, is_approved
       FROM people
       WHERE LOWER(email) = $1 AND is_freelancer = true AND is_deleted = false
       ORDER BY is_approved DESC, portal_last_login DESC NULLS LAST
       LIMIT 1`,
      [email]
    );

    // Don't leak whether the email exists — return the same message regardless.
    // (But only send a code if they're a legitimate approved freelancer.)
    const genericResponse = {
      success: true,
      message: 'If your email is on our approved freelancer list, a verification code is on its way.',
    };

    if (result.rows.length === 0 || !result.rows[0].is_approved) {
      res.json(genericResponse);
      return;
    }

    const person = result.rows[0];
    if (person.portal_password_hash) {
      // Already registered — tell them (no leak: they already know they have an account)
      res.status(409).json({
        error: 'An account already exists for this email. Please log in or reset your password.',
      });
      return;
    }

    // Generate 6-digit code, 15 min TTL
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await query(
      `INSERT INTO portal_verification_codes (email, code, expires_at) VALUES ($1, $2, $3)`,
      [email, code, expiresAt]
    );

    const freelancerName = person.first_name || 'there';
    await emailService.send('portal_verification_code', {
      to: email,
      variables: { freelancerName, code },
    });

    res.json(genericResponse);
  } catch (error) {
    console.error('Portal register/start error:', error);
    res.status(500).json({ error: 'Failed to start registration' });
  }
});

const registerVerifySchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
});

router.post('/auth/register/verify', async (req: Request, res: Response) => {
  try {
    const parsed = registerVerifySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Email and 6-digit code are required' });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const code = parsed.data.code;

    // Find the newest unexpired unconsumed code for this email
    const result = await query(
      `SELECT id, code, attempts
       FROM portal_verification_codes
       WHERE LOWER(email) = $1 AND consumed_at IS NULL AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [email]
    );

    if (result.rows.length === 0) {
      res.status(400).json({ error: 'No active code — please request a new one' });
      return;
    }

    const row = result.rows[0];
    if (row.attempts >= 5) {
      res.status(429).json({ error: 'Too many attempts — please request a new code' });
      return;
    }

    if (row.code !== code) {
      await query(
        `UPDATE portal_verification_codes SET attempts = attempts + 1 WHERE id = $1`,
        [row.id]
      );
      res.status(400).json({ error: 'Incorrect code' });
      return;
    }

    // Valid — mark consumed
    await query(
      `UPDATE portal_verification_codes SET consumed_at = NOW() WHERE id = $1`,
      [row.id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Portal register/verify error:', error);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

const registerCompleteSchema = z.object({
  email: z.string().email(),
  code: z.string().length(6),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/auth/register/complete', async (req: Request, res: Response) => {
  try {
    const parsed = registerCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const { code, password } = parsed.data;

    // Require that verify was called within the last 15 min (consumed_at set for this code)
    const codeResult = await query(
      `SELECT id FROM portal_verification_codes
       WHERE LOWER(email) = $1 AND code = $2 AND consumed_at IS NOT NULL
         AND consumed_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [email, code]
    );
    if (codeResult.rows.length === 0) {
      res.status(400).json({ error: 'Please verify your email first' });
      return;
    }

    // Gate again — still must be an approved freelancer
    const personResult = await query(
      `SELECT id, first_name, last_name, email FROM people
       WHERE LOWER(email) = $1 AND is_freelancer = true AND is_approved = true AND is_deleted = false`,
      [email]
    );
    if (personResult.rows.length === 0) {
      res.status(403).json({ error: 'Your account is no longer approved. Please contact us.' });
      return;
    }
    const person = personResult.rows[0];
    const passwordHash = await bcrypt.hash(password, 12);

    await query(
      `UPDATE people
       SET portal_password_hash = $1,
           portal_email_verified = true,
           portal_last_login = NOW()
       WHERE id = $2`,
      [passwordHash, person.id]
    );

    // Issue session token (same shape as login)
    const name = `${person.first_name || ''} ${person.last_name || ''}`.trim();
    const sessionToken = jwt.sign(
      { id: person.id, email: person.email || email, name },
      PORTAL_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({
      success: true,
      user: { id: person.id, name, email: person.email || email },
    });
  } catch (error) {
    console.error('Portal register/complete error:', error);
    res.status(500).json({ error: 'Failed to complete registration' });
  }
});

// ── Forgot / reset password ──────────────────────────────────────────

const PORTAL_FRONTEND_URL = (
  process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk'
).replace(/\/$/, '');

function hashToken(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

const forgotSchema = z.object({
  email: z.string().email(),
});

router.post('/auth/forgot-password', async (req: Request, res: Response) => {
  try {
    const parsed = forgotSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'A valid email address is required' });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();

    const result = await query(
      `SELECT id, first_name, email FROM people
       WHERE LOWER(email) = $1 AND is_freelancer = true AND is_approved = true AND is_deleted = false
       ORDER BY portal_last_login DESC NULLS LAST
       LIMIT 1`,
      [email]
    );

    // Don't leak whether the email exists
    const genericResponse = {
      success: true,
      message: 'If your email is on our approved freelancer list, a reset link is on its way.',
    };

    if (result.rows.length === 0) {
      res.json(genericResponse);
      return;
    }

    const person = result.rows[0];
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1h

    await query(
      `INSERT INTO portal_password_reset_tokens (person_id, token_hash, expires_at, ip_address)
       VALUES ($1, $2, $3, $4)`,
      [person.id, tokenHash, expiresAt, req.ip || null]
    );

    const resetUrl = `${PORTAL_FRONTEND_URL}/reset-password?token=${rawToken}`;
    const freelancerName = person.first_name || 'there';

    await emailService.send('portal_password_reset', {
      to: person.email || email,
      variables: { freelancerName, resetUrl },
    });

    res.json(genericResponse);
  } catch (error) {
    console.error('Portal forgot-password error:', error);
    res.status(500).json({ error: 'Failed to send reset link' });
  }
});

// ── GET /api/portal/auth/verify-reset-token — check a reset token ─
// Validates a password reset token without consuming it. The Next.js
// portal calls this on /reset-password page load to decide whether to
// show the form or the "expired" message. Confirms the token is
// valid + unexpired + unused + belongs to an approved freelancer.

router.get('/auth/verify-reset-token', async (req: Request, res: Response) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!token || token.length < 40) {
      res.json({ valid: false });
      return;
    }
    const tokenHash = hashToken(token);
    const result = await query(
      `SELECT 1
       FROM portal_password_reset_tokens t
       JOIN people p ON p.id = t.person_id
       WHERE t.token_hash = $1
         AND t.used_at IS NULL
         AND t.expires_at > NOW()
         AND p.is_freelancer = true
         AND p.is_approved = true
         AND p.is_deleted = false`,
      [tokenHash]
    );
    res.json({ valid: result.rows.length > 0 });
  } catch (error) {
    console.error('Portal verify-reset-token error:', error);
    res.json({ valid: false });
  }
});

const resetSchema = z.object({
  token: z.string().min(40),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

router.post('/auth/reset-password', async (req: Request, res: Response) => {
  try {
    const parsed = resetSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
      return;
    }
    const { token, password } = parsed.data;
    const tokenHash = hashToken(token);

    const result = await query(
      `SELECT t.id, t.person_id, p.first_name, p.last_name, p.email,
              p.is_freelancer, p.is_approved
       FROM portal_password_reset_tokens t
       JOIN people p ON p.id = t.person_id
       WHERE t.token_hash = $1
         AND t.used_at IS NULL
         AND t.expires_at > NOW()
         AND p.is_deleted = false`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      res.status(400).json({ error: 'This reset link is invalid or has expired.' });
      return;
    }

    const row = result.rows[0];
    if (!row.is_freelancer || !row.is_approved) {
      res.status(403).json({ error: 'Your account is no longer approved. Please contact us.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Transaction: set password + mark token used
    await query('BEGIN');
    try {
      await query(
        `UPDATE people
         SET portal_password_hash = $1,
             portal_email_verified = true,
             portal_last_login = NOW()
         WHERE id = $2`,
        [passwordHash, row.person_id]
      );
      await query(
        `UPDATE portal_password_reset_tokens SET used_at = NOW() WHERE id = $1`,
        [row.id]
      );
      // Invalidate all other pending tokens for this person
      await query(
        `UPDATE portal_password_reset_tokens
         SET used_at = NOW()
         WHERE person_id = $1 AND used_at IS NULL AND id != $2`,
        [row.person_id, row.id]
      );
      await query('COMMIT');
    } catch (err) {
      await query('ROLLBACK');
      throw err;
    }

    // Issue session token so they go straight into the portal
    const name = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    const sessionToken = jwt.sign(
      { id: row.person_id, email: row.email, name },
      PORTAL_SECRET,
      { expiresIn: '30d', algorithm: 'HS256' }
    );

    res.cookie('session', sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({ success: true, user: { id: row.person_id, name, email: row.email } });
  } catch (error) {
    console.error('Portal reset-password error:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

// ── Telemetry: Monday fallback alert ─────────────────────────────────
// Called by the Next.js portal when an OP-backend call fails and it
// falls back to Monday.com. Dedup'd to once per operation per hour.

const fallbackSchema = z.object({
  operation: z.string().min(1).max(50),
  errorMessage: z.string().max(2000).optional(),
  email: z.string().email().optional(),
  stack: z.string().max(4000).optional(),
});

router.post('/telemetry/monday-fallback', async (req: Request, res: Response) => {
  try {
    const headerSecret = req.headers['x-portal-telemetry-key'];
    const expected = process.env.PORTAL_TELEMETRY_SECRET;
    if (!expected || headerSecret !== expected) {
      // Don't leak whether the secret is configured; simple 401.
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const parsed = fallbackSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid payload' });
      return;
    }

    const { operation, errorMessage, email, stack } = parsed.data;
    console.warn(`[PORTAL FALLBACK] operation=${operation} email=${email || 'unknown'} error=${errorMessage || 'unknown'}`);

    // Always record the event for forensics
    await query(
      `INSERT INTO portal_fallback_events (operation, error_message, email)
       VALUES ($1, $2, $3)`,
      [operation, errorMessage || null, email || null]
    );

    // Dedup: suppress further alerts for this operation within the last hour.
    // We count events BEFORE the one we just inserted.
    const dedupResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM portal_fallback_events
       WHERE operation = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [operation]
    );
    const eventsInWindow = dedupResult.rows[0].count as number;
    const shouldAlert = eventsInWindow <= 1; // just the one we inserted

    if (shouldAlert) {
      // Create an inbox notification for all admin/manager users
      const adminUsers = await query(
        `SELECT id FROM users
         WHERE role IN ('admin', 'manager') AND is_active = true`
      );
      for (const user of adminUsers.rows) {
        await query(
          `INSERT INTO notifications (user_id, type, priority, title, content, action_url)
           VALUES ($1, 'portal_fallback', 'high', $2, $3, $4)`,
          [
            user.id,
            `Portal fell back to Monday: ${operation}`,
            `${errorMessage || 'No error message'}${email ? ` — ${email}` : ''}`,
            '/settings',
          ]
        ).catch((err) => {
          // Schema may differ — log and move on. Email is the important alert.
          console.error('Failed to insert portal_fallback notification:', err);
        });
      }

      // Send alert email to ops inbox
      await emailService.send('monday_fallback_alert', {
        to: 'info@oooshtours.co.uk',
        variables: {
          operation,
          errorMessage: errorMessage || 'No error message provided',
          email: email || 'unknown',
        },
      }).catch((err) => console.error('Failed to send monday_fallback_alert:', err));
    }

    res.json({ success: true, alerted: shouldAlert, eventsInWindow });
    if (stack) {
      console.warn(`[PORTAL FALLBACK] stack: ${stack}`);
    }
  } catch (error) {
    console.error('Portal fallback telemetry error:', error);
    res.status(500).json({ error: 'Failed to record fallback' });
  }
});

// ── GET /api/portal/staff/calculator-settings ────────────────────────
//
// Read-only fetch of transport calculator settings, protected by a
// shared API key (header `x-portal-staff-key`, env `PORTAL_STAFF_API_KEY`).
//
// Replaces the legacy Monday.com D&C Settings board — the freelancer
// portal's staff Crew & Transport calculator now reads from OP's
// `calculator_settings` table (the same source the OP-side calculator
// uses, so they can never drift).
//
// Returns the values in the shape the portal page expects (camelCase
// keys matching `CostingSettings` in the portal's staff settings route).
router.get('/staff/calculator-settings', async (req: Request, res: Response) => {
  try {
    const headerSecret = req.headers['x-portal-staff-key'];
    const expected = process.env.PORTAL_STAFF_API_KEY;
    if (!expected || headerSecret !== expected) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const result = await query(
      `SELECT key, value FROM calculator_settings`
    );
    const map: Record<string, number> = {};
    for (const row of result.rows) {
      const v = parseFloat(row.value);
      if (!Number.isNaN(v)) map[row.key] = v;
    }

    // Map OP's `calculator_settings` row keys to the portal's
    // CostingSettings shape. Keep both spellings until the portal page
    // is retired — `freelancer_hourly_day` is the canonical OP key,
    // `hourlyRateFreelancerDay` is what the portal expects.
    res.json({
      success: true,
      settings: {
        hourlyRateFreelancerDay: map.freelancer_hourly_day,
        hourlyRateFreelancerNight: map.freelancer_hourly_night,
        hourlyRateClientDay: map.client_hourly_day,
        hourlyRateClientNight: map.client_hourly_night,
        adminCostPerHour: map.admin_cost_per_hour,
        driverDayRate: map.driver_day_rate,
        expenseMarkupPercent: map.expense_markup_percent,
        minHoursThreshold: map.min_hours_threshold,
        minClientCharge: map.min_client_charge_floor,
        handoverTimeMinutes: map.handover_time_mins,
        unloadTimeMinutes: map.unload_time_mins,
        fuelPricePerLitre: map.fuel_price_per_litre,
        // Not currently in calculator_settings — portal falls back to
        // its default. Tracked for future migration.
        expenseVarianceThreshold: undefined,
      },
    });
  } catch (error) {
    console.error('Portal staff calculator settings error:', error);
    res.status(500).json({ error: 'Failed to load calculator settings' });
  }
});

// ── All remaining routes require portal auth ─────────────────────────

router.use(portalAuth);

// ── GET /api/portal/me — current user info ───────────────────────────

router.get('/me', async (req: PortalRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT p.id, p.first_name, p.last_name, p.email, p.mobile,
              p.is_freelancer, p.is_approved
       FROM people p WHERE p.id = $1`,
      [req.portalUser!.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const p = result.rows[0];
    res.json({
      success: true,
      user: {
        id: p.id,
        name: `${p.first_name} ${p.last_name}`.trim(),
        email: p.email,
        phone: p.mobile,
        emailVerified: true, // if they can log in, they're verified
      },
    });
  } catch (error) {
    console.error('Portal me error:', error);
    res.status(500).json({ error: 'Failed to load user' });
  }
});

// ── Studio Sitter shifts (Rehearsals — Phase D portal surface) ───────
//
// A sitter (freelancer) sees the evenings they've been rostered to, and per
// evening: who's in each room that night (derived) + the job's shared specs.
// One sitter per night covers the whole building. Read-only in this slice;
// handover thread + end-of-day report land in later slices.

const SITTER_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function addDaysIsoP(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

// GET /api/portal/studio-sitter/shifts — the sitter's upcoming/recent shifts
router.get('/studio-sitter/shifts', async (req: PortalRequest, res: Response) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // A short look-back so a sitter can still open a recent past shift, and a
    // full year forward so far-out assignments (e.g. a September date rota'd in
    // July) always surface — the query is bounded by the sitter's own
    // assignments, so a wide window stays cheap.
    const from = addDaysIsoP(today, -14);
    const to = addDaysIsoP(today, 365);
    const shifts = await getSitterShifts(req.portalUser!.id, from, to);
    res.json({ success: true, shifts });
  } catch (error) {
    console.error('Portal sitter shifts error:', error);
    res.status(500).json({ error: 'Failed to load shifts' });
  }
});

// GET /api/portal/studio-sitter/shifts/:date — one evening's detail
router.get('/studio-sitter/shifts/:date', async (req: PortalRequest, res: Response) => {
  try {
    const date = String(req.params.date);
    if (!SITTER_DATE_RE.test(date)) { res.status(400).json({ error: 'Invalid date' }); return; }
    // Access: the sitter must be rostered to this night (shared staff account
    // may view any).
    const allowed = req.portalUser!.isStaffShared || await isSitterAssignedTo(req.portalUser!.id, date);
    if (!allowed) { res.status(403).json({ error: 'Not rostered to this evening' }); return; }
    const detail = await getSitterShiftDetail(date, req.portalUser!.id);
    res.json({ success: true, ...detail });
  } catch (error) {
    console.error('Portal sitter shift detail error:', error);
    res.status(500).json({ error: 'Failed to load shift' });
  }
});

// ── Studio Sitter handover thread (Rehearsals — Phase D slice 3) ─────
//
// The sitter ⇄ staff handover notes for one evening. Flat chronological log
// anchored to the shift via interactions.shift_id (scoped OUT of the person /
// job / org / venue timelines by the shift_id IS NULL guard). Freelancer-
// authored messages carry created_by = NULL + author_name (sitters are people,
// not OP users). Access is gated the same way as the shift detail.

async function resolveOpenShiftId(date: string): Promise<string | null> {
  const r = await query(
    `SELECT id FROM studio_sitter_shifts WHERE shift_date = $1 AND status <> 'cancelled' LIMIT 1`,
    [date]
  );
  return r.rows[0]?.id ?? null;
}

// Handover-note attachments (images / PDFs). Stored in interactions.files under
// the same shape as staff interaction attachments so both surfaces render them.
const sitterNoteUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 6 }, // 8MB per file, 6 files
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only images and PDFs can be attached'));
    }
  },
}).array('files', 6);

function sitterNoteUploadMw(req: PortalRequest, res: Response, next: NextFunction) {
  sitterNoteUpload(req, res, (err: unknown) => {
    if (err) {
      const msg = err instanceof multer.MulterError ? err.message : (err instanceof Error ? err.message : 'Upload failed');
      res.status(400).json({ error: msg });
      return;
    }
    next();
  });
}

// Map a stored interaction-file blob to the portal display shape, presigning
// R2 keys. Handles BOTH the staff interaction-attachment shape
// ({ r2_key, filename, content_type }) and the legacy shared-file shape
// ({ url, name, type }), so staff- and sitter-posted attachments render alike.
async function mapThreadFile(x: Record<string, any>): Promise<{ name: string; url: string; fileType: string | null }> {
  const key: string = x.r2_key || x.url || '';
  let url = key;
  if (key && typeof key === 'string' && key.startsWith('files/')) {
    try { url = await getPresignedDownloadUrl(key); } catch { /* keep raw */ }
  }
  return {
    name: x.filename || x.name || 'File',
    url,
    fileType: x.content_type || x.type || x.fileType || null,
  };
}

// GET /api/portal/studio-sitter/shifts/:date/thread — read the handover log
router.get('/studio-sitter/shifts/:date/thread', async (req: PortalRequest, res: Response) => {
  try {
    const date = String(req.params.date);
    if (!SITTER_DATE_RE.test(date)) { res.status(400).json({ error: 'Invalid date' }); return; }
    const allowed = req.portalUser!.isStaffShared || await isSitterAssignedTo(req.portalUser!.id, date);
    if (!allowed) { res.status(403).json({ error: 'Not rostered to this evening' }); return; }

    const shiftId = await resolveOpenShiftId(date);
    if (!shiftId) { res.json({ success: true, messages: [] }); return; }

    const result = await query(
      `SELECT i.id, i.content, i.created_at, i.files, i.created_by, i.author_name,
              CONCAT(p.first_name, ' ', p.last_name) AS staff_name
       FROM interactions i
       LEFT JOIN users u ON u.id = i.created_by
       LEFT JOIN people p ON p.id = u.person_id
       WHERE i.shift_id = $1
       ORDER BY i.created_at ASC`,
      [shiftId]
    );

    const myName = req.portalUser!.name;
    const messages = await Promise.all(result.rows.map(async (row: any) => {
      const fromStaff = !!row.created_by;
      const author = fromStaff
        ? (String(row.staff_name || '').trim() || 'Ooosh')
        : (row.author_name || 'Studio sitter');
      const raw: any[] = Array.isArray(row.files) ? row.files : [];
      const files = await Promise.all(raw.map(mapThreadFile));
      return {
        id: row.id,
        content: row.content,
        created_at: row.created_at,
        author,
        from_staff: fromStaff,
        mine: !fromStaff && (row.author_name || '') === myName,
        files,
      };
    }));

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Portal sitter thread read error:', error);
    res.status(500).json({ error: 'Failed to load handover notes' });
  }
});

// POST /api/portal/studio-sitter/shifts/:date/thread — add a handover note
// Accepts JSON ({ content }) or multipart/form-data (content + files[] of
// images/PDFs). Attachments upload to R2 and store on interactions.files.
router.post('/studio-sitter/shifts/:date/thread', sitterNoteUploadMw, async (req: PortalRequest, res: Response) => {
  try {
    const date = String(req.params.date);
    if (!SITTER_DATE_RE.test(date)) { res.status(400).json({ error: 'Invalid date' }); return; }
    const allowed = req.portalUser!.isStaffShared || await isSitterAssignedTo(req.portalUser!.id, date);
    if (!allowed) { res.status(403).json({ error: 'Not rostered to this evening' }); return; }

    const content = String(req.body?.content ?? '').trim().slice(0, 4000);
    const uploaded = (req.files as Express.Multer.File[] | undefined) || [];
    if (!content && uploaded.length === 0) {
      res.status(400).json({ error: 'A message or attachment is required' });
      return;
    }

    const shiftId = await resolveOpenShiftId(date);
    if (!shiftId) { res.status(404).json({ error: 'No shift for this evening' }); return; }

    // Upload attachments to R2 (same shape/prefix as staff interaction
    // attachments so both surfaces render them identically).
    const fileBlobs: Array<Record<string, any>> = [];
    if (uploaded.length > 0 && isR2Configured()) {
      for (const f of uploaded) {
        const ext = (f.originalname.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
        const key = `files/attachments/portal-${req.portalUser!.id}/${crypto.randomUUID()}${ext}`;
        await uploadToR2(key, f.buffer, f.mimetype);
        fileBlobs.push({
          r2_key: key,
          filename: f.originalname,
          content_type: f.mimetype,
          size_bytes: f.size,
          uploaded_at: new Date().toISOString(),
        });
      }
    }

    // Content is NOT NULL on interactions; use a placeholder for attachment-only.
    const storedContent = content || '(attachment)';

    // Freelancer-authored: created_by NULL + author_name (they aren't OP users).
    const inserted = await query(
      `INSERT INTO interactions (type, content, shift_id, created_by, author_name, files)
       VALUES ('note', $1, $2, NULL, $3, $4::jsonb)
       RETURNING id, created_at`,
      [storedContent, shiftId, req.portalUser!.name, JSON.stringify(fileBlobs)]
    );

    // Let prior staff participants know a sitter replied — low-priority bell
    // only (no email), matching the thread re-notify model. Best-effort:
    // a notification failure must not fail the post.
    try {
      const priorStaff = await query(
        `SELECT DISTINCT created_by FROM interactions
         WHERE shift_id = $1 AND created_by IS NOT NULL`,
        [shiftId]
      );
      for (const row of priorStaff.rows) {
        await query(
          `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
           VALUES ($1, 'system', $2, $3, 'studio_sitter_shifts', $4, '/studio-sitters', 'low')`,
          [
            row.created_by,
            `${req.portalUser!.name} added a handover note`,
            storedContent.length > 200 ? storedContent.slice(0, 200) + '...' : storedContent,
            shiftId,
          ]
        );
      }
    } catch (notifyErr) {
      console.error('Portal sitter thread notify error (non-fatal):', notifyErr);
    }

    const files = await Promise.all(fileBlobs.map(mapThreadFile));
    res.json({
      success: true,
      message: {
        id: inserted.rows[0].id,
        content: storedContent,
        created_at: inserted.rows[0].created_at,
        author: req.portalUser!.name,
        from_staff: false,
        mine: true,
        files,
      },
    });
  } catch (error) {
    console.error('Portal sitter thread post error:', error);
    res.status(500).json({ error: 'Failed to post handover note' });
  }
});

// ── Notification preferences (mirrors the old Monday-backed shape) ───
//
// GET  /api/portal/settings/notifications → current mute status
// POST /api/portal/settings/notifications → mute_global / unmute_global /
//                                           mute_job / unmute_job
//
// Storage lives on people.portal_notifications_paused_until (TIMESTAMPTZ)
// and people.portal_muted_quote_ids (UUID[]). Date arithmetic matches the
// Monday version: "end of today" / "specific_date" both store the day
// AFTER, so the `paused > now` check returns true on the intended day.

router.get('/settings/notifications', async (req: PortalRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT portal_notifications_paused_until, portal_muted_quote_ids
       FROM people WHERE id = $1`,
      [req.portalUser!.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Freelancer not found' });
      return;
    }

    const row = result.rows[0];
    const pausedUntil: Date | null = row.portal_notifications_paused_until
      ? new Date(row.portal_notifications_paused_until)
      : null;
    const mutedJobIds: string[] = row.portal_muted_quote_ids || [];

    const globalMuteActive = !!(pausedUntil && pausedUntil > new Date());

    res.json({
      success: true,
      notifications: {
        globalMuteActive,
        globalMuteUntil: globalMuteActive ? pausedUntil!.toISOString() : null,
        mutedJobIds,
        mutedJobCount: mutedJobIds.length,
      },
    });
  } catch (error) {
    console.error('Portal settings GET error:', error);
    res.status(500).json({ success: false, error: 'Failed to fetch settings' });
  }
});

const muteSchema = z.object({
  action: z.enum(['mute_global', 'unmute_global', 'mute_job', 'unmute_job']),
  muteType: z.enum(['7_days', 'end_of_today', 'specific_date', 'indefinite']).optional(),
  muteUntilDate: z.string().optional(),
  jobId: z.string().uuid().optional(),
});

router.post('/settings/notifications', async (req: PortalRequest, res: Response) => {
  try {
    const parsed = muteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid request' });
      return;
    }
    const { action, muteType, muteUntilDate, jobId } = parsed.data;
    const personId = req.portalUser!.id;

    if (action === 'mute_global') {
      let mutedUntil: Date;
      switch (muteType) {
        case 'end_of_today':
          mutedUntil = new Date();
          mutedUntil.setDate(mutedUntil.getDate() + 1);
          mutedUntil.setHours(0, 0, 0, 0);
          break;
        case '7_days':
          mutedUntil = new Date();
          mutedUntil.setDate(mutedUntil.getDate() + 7);
          break;
        case 'specific_date':
          if (!muteUntilDate) {
            res.status(400).json({ success: false, error: 'Date required for specific_date mute' });
            return;
          }
          mutedUntil = new Date(muteUntilDate);
          if (isNaN(mutedUntil.getTime())) {
            res.status(400).json({ success: false, error: 'Invalid date' });
            return;
          }
          mutedUntil.setDate(mutedUntil.getDate() + 1);
          break;
        case 'indefinite':
          mutedUntil = new Date();
          mutedUntil.setFullYear(mutedUntil.getFullYear() + 10);
          break;
        default:
          res.status(400).json({ success: false, error: 'Invalid mute type' });
          return;
      }

      await query(
        `UPDATE people SET portal_notifications_paused_until = $1, updated_at = NOW() WHERE id = $2`,
        [mutedUntil, personId]
      );

      res.json({ success: true, message: 'Notifications muted', mutedUntil: mutedUntil.toISOString() });
      return;
    }

    if (action === 'unmute_global') {
      await query(
        `UPDATE people SET portal_notifications_paused_until = NULL, updated_at = NOW() WHERE id = $1`,
        [personId]
      );
      res.json({ success: true, message: 'Notifications enabled' });
      return;
    }

    if (action === 'mute_job') {
      if (!jobId) {
        res.status(400).json({ success: false, error: 'Job ID required' });
        return;
      }
      await query(
        `UPDATE people
         SET portal_muted_quote_ids = (
           SELECT ARRAY(SELECT DISTINCT unnest(portal_muted_quote_ids || ARRAY[$1::uuid]))
         ),
         updated_at = NOW()
         WHERE id = $2`,
        [jobId, personId]
      );
      res.json({ success: true, message: 'Job notifications muted', jobId });
      return;
    }

    if (action === 'unmute_job') {
      if (!jobId) {
        res.status(400).json({ success: false, error: 'Job ID required' });
        return;
      }
      await query(
        `UPDATE people
         SET portal_muted_quote_ids = array_remove(portal_muted_quote_ids, $1::uuid),
             updated_at = NOW()
         WHERE id = $2`,
        [jobId, personId]
      );
      res.json({ success: true, message: 'Job notifications enabled', jobId });
      return;
    }
  } catch (error) {
    console.error('Portal settings POST error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Failed to update settings' });
  }
});

// ── GET /api/portal/jobs — freelancer's job list ─────────────────────

router.get('/jobs', async (req: PortalRequest, res: Response) => {
  try {
    const email = req.portalUser!.email.toLowerCase();
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;

    // Shared staff accounts (e.g. info@) see every is_ooosh_crew assignment
    // — local deliveries, collections, in-house runs get divvied up ad-hoc,
    // so the account acts as a pool. Freelancers see only their own.
    const assignmentFilter = isStaffShared
      ? `(qa.person_id = $1 OR qa.is_ooosh_crew = true)`
      : `qa.person_id = $1`;

    const result = await query(
      `SELECT
        q.id, q.job_id, q.job_type, q.calculation_mode,
        q.venue_name, q.venue_id, q.distance_miles, q.drive_time_mins,
        q.arrival_time, q.job_date, q.job_finish_date, q.is_multi_day,
        q.work_duration_hrs, q.num_days,
        q.what_is_it, q.status, q.ops_status,
        q.client_introduction,
        q.work_type, q.work_type_other, q.work_description,
        q.freelancer_notes, q.freelancer_fee, q.freelancer_fee_rounded,
        q.run_group, q.run_order, q.run_group_fee,
        rg.combined_freelancer_fee as run_combined_freelancer_fee,
        rg.combined_client_fee as run_combined_client_fee,
        rg.notes as run_notes,
        q.is_local, q.completed_at, q.completion_notes,
        q.client_name,
        q.tolls_status, q.accommodation_status, q.flight_status,
        q.expenses,
        qa.id as assignment_id, qa.role as assignment_role,
        qa.agreed_rate, qa.rate_type,
        qa.expected_expenses as assignment_expected_expenses,
        j.job_name, j.hh_job_number AS hirehop_id, j.client_name as job_client_name,
        j.out_date, j.return_date, j.files as job_files,
        v.name as linked_venue_name, v.address as venue_address, v.city as venue_city
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       LEFT JOIN run_groups rg ON rg.id = q.run_group
       WHERE ${assignmentFilter}
         AND q.is_deleted = false
         AND q.status IN ('confirmed', 'completed')
       ORDER BY q.job_date ASC NULLS LAST, q.arrival_time ASC NULLS LAST`,
      [personId]
    );

    // Categorise into today/upcoming/completed/cancelled
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const today: unknown[] = [];
    const upcoming: unknown[] = [];
    const completed: unknown[] = [];
    const cancelled: unknown[] = [];

    for (const row of result.rows) {
      const item = formatJobForPortal(row);

      // Normalise job_date to an ISO "YYYY-MM-DD" string. Postgres TIMESTAMPTZ
      // comes back as a JS Date, which compared against a date string with `>`
      // / `<` ends up as timestamp-vs-NaN (always false) and the job silently
      // drops out of every bucket.
      const jobDateStr: string | null = row.job_date instanceof Date
        ? row.job_date.toISOString().split('T')[0]
        : (typeof row.job_date === 'string' ? row.job_date.split('T')[0] : null);

      if (row.ops_status === 'completed' || row.status === 'completed') {
        if (jobDateStr && jobDateStr >= thirtyDaysAgo) {
          completed.push(item);
        }
      } else if (row.ops_status === 'cancelled' || row.status === 'cancelled') {
        if (jobDateStr && jobDateStr >= thirtyDaysAgo) {
          cancelled.push(item);
        }
      } else if (jobDateStr === todayStr) {
        today.push(item);
      } else if (jobDateStr && jobDateStr > todayStr) {
        upcoming.push(item);
      } else if (jobDateStr && jobDateStr < todayStr) {
        // Past job that hasn't been completed — show in today for action
        today.push(item);
      }
    }

    res.json({
      success: true,
      user: {
        id: req.portalUser!.id,
        name: req.portalUser!.name,
        email: req.portalUser!.email,
      },
      today,
      upcoming,
      completed,
      cancelled,
    });
  } catch (error) {
    console.error('Portal jobs error:', error);
    res.status(500).json({ error: 'Failed to load jobs' });
  }
});

// ── GET /api/portal/jobs/:quoteId — single job detail ────────────────

router.get('/jobs/:quoteId', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;
    const quoteId = req.params.quoteId;

    // Legacy Monday IDs (11-digit int) land on OP when a client has stale
    // state — 404 cleanly instead of blowing up the UUID cast.
    if (!isUuidLike(quoteId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Verify this freelancer is assigned to this quote
    // NOTE: venues table has no direct contact columns — site contacts live on
    // linked organisation's people. Those are surfaced via portal UI separately.
    // Access notes come from venue.approach_notes (fallback to general_notes).
    const result = await query(
      `SELECT
        q.*,
        rg.combined_freelancer_fee as run_combined_freelancer_fee,
        rg.combined_client_fee as run_combined_client_fee,
        rg.notes as run_notes,
        qa.id as assignment_id, qa.role as assignment_role,
        qa.agreed_rate, qa.rate_type,
        qa.expected_expenses as assignment_expected_expenses,
        j.job_name, j.hh_job_number AS hirehop_id, j.client_name as job_client_name,
        j.out_date, j.return_date, j.files as job_files,
        v.name as linked_venue_name, v.address as venue_address,
        v.city as venue_city, v.w3w_address as venue_w3w,
        v.files as venue_files,
        COALESCE(v.approach_notes, v.general_notes) as venue_access_notes
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       LEFT JOIN run_groups rg ON rg.id = q.run_group
       WHERE qa.quote_id = $1 AND (qa.person_id = $2 OR (qa.is_ooosh_crew = true AND $3 = true))
         AND q.is_deleted = false`,
      [quoteId, personId, isStaffShared]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found or not assigned to you' });
      return;
    }

    const row = result.rows[0];
    const job = formatJobForPortal(row);

    // Shape shared files for the portal. Files in the JSONB are shaped
    // { url (R2 key | external URL), name, type, label, share_with_freelancer, ... }.
    // Portal expects { assetId | null, name, url, fileType } with a
    // directly-openable URL. Presign R2 keys for 1h, pass external URLs
    // straight through.
    const shapeSharedFiles = async (files: unknown): Promise<Array<{ assetId: null; name: string; url: string; fileType: string }>> => {
      if (!Array.isArray(files)) return [];
      const shared = (files as Array<Record<string, unknown>>).filter((f) => f?.share_with_freelancer === true);
      const out: Array<{ assetId: null; name: string; url: string; fileType: string }> = [];
      for (const f of shared) {
        const rawUrl = typeof f.url === 'string' ? f.url : '';
        if (!rawUrl) continue;
        let url = rawUrl;
        if (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://')) {
          try {
            url = await getPresignedDownloadUrl(rawUrl, 3600);
          } catch (err) {
            console.error('[portal] presign failed for', rawUrl, err);
            continue;
          }
        }
        out.push({
          assetId: null,
          name: String(f.name || f.label || 'File'),
          url,
          fileType: String(f.type || f.content_type || 'FILE'),
        });
      }
      return out;
    };

    const venueSharedFiles = await shapeSharedFiles(row.venue_files);
    const jobSharedFiles = await shapeSharedFiles(row.job_files);

    // Merge into job so portal page can render a "Job Files" section
    (job as Record<string, unknown>).files = jobSharedFiles;

    // Build venue info
    let venue = null;
    if (row.venue_id) {
      // Check 48-hour privacy rule for phone numbers
      const jobDate = row.job_date ? new Date(row.job_date) : null;
      const hoursUntilJob = jobDate ? (jobDate.getTime() - Date.now()) / (1000 * 60 * 60) : 999;
      const contactsVisible = hoursUntilJob <= 48;

      venue = {
        id: row.venue_id,
        name: row.linked_venue_name || row.venue_name,
        address: row.venue_address,
        whatThreeWords: row.venue_w3w,
        // Venue contacts not stored on venues table — placeholder until a
        // person-link-based contact lookup is added
        contact1: null as string | null,
        phone: null as string | null,
        email: null as string | null,
        accessNotes: row.venue_access_notes,
        files: venueSharedFiles,
        phoneHidden: !contactsVisible,
        phoneVisibleFrom: !contactsVisible && jobDate
          ? new Date(jobDate.getTime() - 48 * 60 * 60 * 1000).toLocaleDateString('en-GB', {
              weekday: 'short', day: 'numeric', month: 'short',
            })
          : null,
      };
    }

    res.json({
      success: true,
      job,
      venue,
      contactsVisible: venue ? !venue.phoneHidden : true,
      boardType: row.job_type === 'crewed' ? 'crew' : 'dc',
    });
  } catch (error) {
    console.error('Portal job detail error:', error);
    res.status(500).json({ error: 'Failed to load job' });
  }
});

// ── GET /api/portal/jobs/:quoteId/equipment — HireHop equipment list ─

router.get('/jobs/:quoteId/equipment', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;
    const quoteId = req.params.quoteId;

    // Legacy Monday IDs (11-digit int) land on OP when a client has stale
    // state — 404 cleanly instead of blowing up the UUID cast.
    if (!isUuidLike(quoteId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Verify access and get HireHop job ID
    const result = await query(
      `SELECT q.what_is_it, j.hh_job_number AS hirehop_id
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       WHERE qa.quote_id = $1 AND (qa.person_id = $2 OR (qa.is_ooosh_crew = true AND $3 = true))
         AND q.is_deleted = false`,
      [quoteId, personId, isStaffShared]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const { hirehop_id, what_is_it } = result.rows[0];

    if (!hirehop_id) {
      res.json({ success: true, items: [], message: 'No HireHop job linked' });
      return;
    }

    // Fetch equipment from HireHop via broker
    try {
      const hhResponse = await hhBroker.get('/api/job_data.php', {
        job: hirehop_id,
      }, { priority: 'high', cacheTTL: 300 });

      const hhData = hhResponse as unknown as Record<string, unknown>;
      const items = Array.isArray(hhData.items) ? hhData.items : [];

      // Filter based on what_is_it
      const filteredItems = items
        .filter((item: Record<string, unknown>) => !item.VIRTUAL)
        .map((item: Record<string, unknown>) => ({
          id: item.ID || item.id,
          name: item.DESCRIPTION || item.name || '',
          quantity: item.QUANTITY || item.qty || 1,
          category: item.ACC_CATEGORY_NAME || item.category || '',
          categoryId: item.ACC_CATEGORY || null,
        }));

      res.json({ success: true, items: filteredItems, whatIsIt: what_is_it });
    } catch (hhError) {
      console.error('HireHop equipment fetch error:', hhError);
      res.json({ success: true, items: [], message: 'Could not fetch equipment list' });
    }
  } catch (error) {
    console.error('Portal equipment error:', error);
    res.status(500).json({ error: 'Failed to load equipment' });
  }
});

// ── POST /api/portal/jobs/:quoteId/legs — declare which legs the job has ──
//
// The /start wizard ("van only / backline only / both") is the declaration of
// which legs a D&C job involves. The portal calls this as the freelancer picks,
// so OP can close the quote server-side the moment the last required leg lands
// (van book-out and/or equipment /complete) — no cross-domain return hop needed.
// Idempotent; safe to re-send.

const legsSchema = z.object({
  van: z.preprocess((v) => v === 'true' || v === true, z.boolean()),
  equipment: z.preprocess((v) => v === 'true' || v === true, z.boolean()),
});

router.post('/jobs/:quoteId/legs', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;
    const quoteId = req.params.quoteId;

    if (!isUuidLike(quoteId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const parsed = legsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid legs payload', details: parsed.error.issues });
      return;
    }
    const { van, equipment } = parsed.data;

    // Access check — same rule as /complete (freelancer on the quote, or the
    // shared staff account for is_ooosh_crew quotes).
    const access = await query(
      `SELECT q.id
         FROM quote_assignments qa
         JOIN quotes q ON q.id = qa.quote_id
        WHERE qa.quote_id = $1
          AND (qa.person_id = $2 OR (qa.is_ooosh_crew = true AND $3 = true))
          AND q.is_deleted = false`,
      [quoteId, personId, isStaffShared]
    );
    if (access.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    await query(
      `UPDATE quotes
          SET requires_van_leg = $1, requires_equipment_leg = $2, updated_at = NOW()
        WHERE id = $3`,
      [van, equipment, quoteId]
    );

    res.json({ success: true, legs: { van, equipment } });
  } catch (error) {
    console.error('[portal] declare legs error:', error);
    res.status(500).json({ error: 'Failed to record job legs' });
  }
});

// ── POST /api/portal/jobs/:quoteId/complete — completion submission ──

const completionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
}).fields([
  { name: 'photos', maxCount: 5 },
  { name: 'signature', maxCount: 1 },
]);

const completionSchema = z.object({
  notes: z.string().optional().default(''),
  customerPresent: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(true),
  equipmentChecklist: z.string().optional(), // JSON string of {itemId: boolean}
  clientEmails: z.string().optional(), // comma-separated
  staffName: z.string().optional(), // For Ooosh staff completing on behalf of system account
  // Van-only deliveries are completed via the OP book-out flow (which
  // emits its own vehicle condition report). The portal completion call
  // still fires to flip quote/assignment status, but we skip the
  // equipment delivery note PDF + client email since there's no
  // equipment changing hands.
  vanOnly: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false),
});

router.post('/jobs/:quoteId/complete', (req: PortalRequest, res: Response, next: NextFunction) => {
  completionUpload(req, res, (err) => {
    if (err) {
      res.status(400).json({ error: err instanceof multer.MulterError ? err.message : 'Upload failed' });
      return;
    }
    next();
  });
}, async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;
    const quoteId = req.params.quoteId;

    // Legacy Monday IDs (11-digit int) land on OP when a client has stale
    // state — 404 cleanly instead of blowing up the UUID cast.
    if (!isUuidLike(quoteId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Verify access + pull full context we'll need for PDF/emails.
    // Client email comes from the linked client organisation (quotes table
    // itself doesn't carry one).
    const accessCheck = await query(
      `SELECT qa.id AS assignment_id,
              q.id AS quote_id, q.ops_status, q.job_type, q.what_is_it,
              q.venue_name, q.venue_id, q.job_date,
              q.client_name AS quote_client_name,
              j.id AS job_id, j.job_name, j.hh_job_number AS hirehop_id, j.client_name AS job_client_name,
              o.email AS client_email,
              v.name AS linked_venue_name, v.address AS venue_address,
              v.city AS venue_city, v.postcode AS venue_postcode
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN organisations o ON o.id = j.client_id
       LEFT JOIN venues v ON v.id = q.venue_id
       WHERE qa.quote_id = $1 AND (qa.person_id = $2 OR (qa.is_ooosh_crew = true AND $3 = true))
         AND q.is_deleted = false`,
      [quoteId, personId, isStaffShared]
    );

    if (accessCheck.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }
    const ctx = accessCheck.rows[0];

    const parsed = completionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid completion data', details: parsed.error.issues });
      return;
    }

    const { notes, customerPresent, equipmentChecklist, clientEmails, staffName, vanOnly } = parsed.data;
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined;

    // ── Upload photos + signature to R2 (preferred storage) ────────
    // completion_photos / completion_signature store either an R2 key
    // ("completion/{quoteId}/...") served via /api/files/download, or a
    // legacy data URL ("data:image/...") for historical records and the
    // R2-unavailable fallback. TransportOpsPage detects the format and
    // renders accordingly (blob fetch vs direct <img src>).
    // Raw buffers are kept in memory for PDF embedding regardless.
    const photoUploads: Array<{ mimeType: string; buffer: Buffer }> = [];
    const photoRefs: string[] = [];
    if (files?.photos) {
      for (let i = 0; i < files.photos.length; i++) {
        const photo = files.photos[i];
        photoUploads.push({ mimeType: photo.mimetype, buffer: photo.buffer });
        let stored: string | null = null;
        if (isR2Configured()) {
          const ext = photo.mimetype === 'image/png' ? 'png' : 'jpg';
          const key = `completion/${quoteId}/photo-${Date.now()}-${i + 1}.${ext}`;
          try {
            await uploadToR2(key, photo.buffer, photo.mimetype);
            stored = key;
          } catch (err) {
            console.error(`[portal completion] R2 upload failed for photo ${i + 1}:`, err);
          }
        }
        if (!stored) {
          stored = `data:${photo.mimetype};base64,${photo.buffer.toString('base64')}`;
        }
        photoRefs.push(stored);
      }
    }

    let signatureBuffer: Buffer | null = null;
    let signatureRef: string | null = null;
    if (files?.signature?.[0]) {
      const sig = files.signature[0];
      signatureBuffer = sig.buffer;
      if (isR2Configured()) {
        const sigPath = `completion/${quoteId}/signature-${Date.now()}.png`;
        try {
          await uploadToR2(sigPath, sig.buffer, sig.mimetype || 'image/png');
          signatureRef = sigPath;
        } catch (err) {
          console.error('[portal completion] R2 upload failed for signature:', err);
        }
      }
      if (!signatureRef) {
        signatureRef = `data:${sig.mimetype || 'image/png'};base64,${sig.buffer.toString('base64')}`;
      }
    }

    // Build completion notes
    let fullNotes = notes || '';
    if (!customerPresent) {
      fullNotes = `[Customer not present] ${fullNotes}`.trim();
    }

    // Parse equipment checklist if provided
    let checklistData: Record<string, boolean> | null = null;
    if (equipmentChecklist) {
      try {
        checklistData = JSON.parse(equipmentChecklist);
      } catch {
        // ignore parse errors
      }
    }

    // Resolve completed_by / display name
    const completedBy = staffName
      ? `${staffName} (${req.portalUser!.email})`
      : req.portalUser!.email;
    const completionName = staffName || req.portalUser!.name;

    // ── Persist to DB ──────────────────────────────────────────────
    // Store the equipment-handover record + stamp the EQUIPMENT leg done. The
    // quote's ops_status/status/completed_at are NOT flipped here — that's
    // maybeCloseQuote's job (below), which only closes once every required leg
    // (van and/or equipment, per the /start declaration) is in. For a
    // backline-only or a "both" job where the van already booked out, this call
    // closes it; for a "both" whose van is still pending it stays open (and the
    // chaser keeps nagging, correctly).
    await query(
      `UPDATE quotes SET
        completed_by = $1,
        completion_notes = $2,
        completion_signature = $3,
        completion_photos = $4::jsonb,
        customer_present = $5,
        equipment_leg_done_at = COALESCE(equipment_leg_done_at, NOW()),
        updated_at = NOW()
       WHERE id = $6`,
      [
        completedBy,
        fullNotes,
        signatureRef,
        JSON.stringify(photoRefs),
        customerPresent,
        quoteId,
      ]
    );

    await query(
      `UPDATE quote_assignments SET status = 'completed', updated_at = NOW()
       WHERE quote_id = $1 AND (person_id = $2 OR (is_ooosh_crew = true AND $3 = true))`,
      [quoteId, personId, isStaffShared]
    );

    // Close the quote server-side if all required legs are done. This is the
    // same helper the van book-out calls, so the last-mover auto-dispatch (and
    // the chaser stopping) fires exactly once, whichever leg is last.
    const { maybeCloseQuote } = await import('../services/quote-completion');
    await maybeCloseQuote(quoteId as string, { triggeringLeg: 'equipment', actorLabel: completedBy });

    if (checklistData) {
      await query(
        `INSERT INTO interactions (type, notes, related_type, related_id, created_by, metadata, source)
         VALUES ('completion', $1, 'quote', $2, $3, $4, 'system')`,
        [
          `Job completed by ${completionName}`,
          quoteId,
          personId,
          JSON.stringify({ equipmentChecklist: checklistData }),
        ]
      );
    }

    // Return success IMMEDIATELY, fire PDF + emails in background
    res.json({ success: true, message: 'Job completed successfully' });

    // ── Background: PDF + client email + staff alert ──────────────
    (async () => {
      const jobType: string = ctx.job_type;
      const isDelivery = jobType === 'delivery';
      const isCollection = jobType === 'collection';
      const jobName: string = ctx.job_name || ctx.linked_venue_name || ctx.venue_name || 'Ooosh Job';
      const clientName: string | null = ctx.job_client_name || ctx.quote_client_name || null;
      const venueName: string = ctx.linked_venue_name || ctx.venue_name || '';
      const completedAt = new Date().toISOString();
      const completedDate = new Date().toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
      });
      const completedDateTime = new Date().toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      // Build client email recipients list
      const recipients = new Set<string>();
      if (clientEmails) {
        clientEmails.split(',').map(e => e.trim()).filter(Boolean).forEach(e => recipients.add(e));
      }
      if (ctx.client_email) recipients.add(ctx.client_email);

      // Safety net: if the freelancer didn't enter any client emails AND the
      // client org has none on file, route the completion email to info@ with
      // an amber banner so the team can forward to the right person and update
      // the address book. Without this the delivery note silently disappears.
      let completionFallback: { jobId: string; clientName: string | null; jobNumber: string | null; jobName: string | null } | null = null;
      if (recipients.size === 0 && ctx.job_id) {
        const target = await resolveClientEmailTarget(ctx.job_id, 'delivery_note');
        if (target.isFallback) {
          recipients.add(target.primaryEmail);
          completionFallback = {
            jobId: ctx.job_id,
            clientName: target.clientName,
            jobNumber: target.jobNumber,
            jobName: target.jobName,
          };
        }
      }

      // Send delivery-note PDF for deliveries.
      // Skip for van-only book-outs — there's no equipment to acknowledge,
      // and the OP book-out flow emits its own vehicle condition report
      // which IS the relevant artefact.
      if (isDelivery && !vanOnly && recipients.size > 0 && ctx.hirehop_id) {
        try {
          // Pull equipment from HireHop via broker.
          // Line items live on /frames/items_to_supply_list.php (not job_data.php).
          // Broker returns { success, data } — data may be an array or { items/rows }.
          // We want real physical items only: kind:2, not VIRTUAL (prompt parents),
          // so we exclude headers (kind:0), selected prompts (kind:3), crew (kind:4).
          let items: DeliveryNoteItem[] = [];
          try {
            const hhResponse = await hhBroker.get<unknown>('/frames/items_to_supply_list.php', {
              job: ctx.hirehop_id,
            }, { priority: 'high', cacheTTL: 300 });

            if (hhResponse.success && hhResponse.data) {
              const data = hhResponse.data as Record<string, unknown>;
              const rawItems: unknown[] = Array.isArray(data)
                ? data
                : (Array.isArray(data.items) ? data.items : (Array.isArray(data.rows) ? data.rows : []));
              items = (rawItems as Array<Record<string, unknown>>)
                .filter((item) => {
                  const kind = Number(item.kind ?? 2);
                  const isVirtual = item.VIRTUAL === '1' || item.VIRTUAL === 1 || item.VIRTUAL === true;
                  return kind === 2 && !isVirtual;
                })
                .map((item) => ({
                  name: String(item.title ?? item.NAME ?? item.ITEM_NAME ?? ''),
                  quantity: Number(item.qty ?? item.QUANTITY ?? item.quantity ?? 1),
                }))
                .filter((item) => item.name);
            }
          } catch (hhErr) {
            console.error('[portal completion] HH equipment fetch failed:', hhErr);
          }

          const pdfBuffer = await generateDeliveryNotePdf({
            hhRef: String(ctx.hirehop_id),
            jobDate: ctx.job_date
              ? (ctx.job_date instanceof Date ? ctx.job_date.toISOString() : String(ctx.job_date))
              : completedAt,
            completedAt,
            clientName: clientName || undefined,
            venueName: venueName || 'N/A',
            deliveryAddress: [ctx.venue_address, ctx.venue_city, ctx.venue_postcode]
              .filter(Boolean).join(', ') || undefined,
            items,
            signature: signatureBuffer,
            photos: photoUploads.map(p => p.buffer),
            driverName: completionName,
          });

          // Store the PDF in R2 for future re-access
          if (isR2Configured()) {
            const pdfKey = `delivery-notes/${quoteId}/delivery-note-${Date.now()}.pdf`;
            try {
              await uploadToR2(pdfKey, pdfBuffer, 'application/pdf');
            } catch (err) {
              console.error('[portal completion] R2 upload failed for PDF:', err);
            }
          }

          // Email each recipient
          for (const to of recipients) {
            try {
              await emailService.send('delivery_note', {
                to,
                variables: {
                  clientName: clientName || 'there',
                  jobName,
                  jobNumber: String(ctx.hirehop_id || ''),
                  venueName: venueName || 'your venue',
                  deliveryDate: completedDate,
                  driverName: completionName,
                  completedAt: completedDateTime,
                },
                prependBanner: completionFallback ? buildFallbackBanner(completionFallback) : undefined,
                attachments: [{
                  filename: `delivery-note-${ctx.hirehop_id}.pdf`,
                  content: pdfBuffer,
                  contentType: 'application/pdf',
                }],
              });
            } catch (emailErr) {
              console.error(`[portal completion] Failed to email delivery note to ${to}:`, emailErr);
            }
          }
          if (completionFallback) {
            await logFallbackToTimeline({ jobId: completionFallback.jobId, templateId: 'delivery_note' });
          }
        } catch (err) {
          console.error('[portal completion] Delivery note PDF/email failed:', err);
        }
      }

      // Send collection confirmation email for collections (no PDF)
      if (isCollection && recipients.size > 0) {
        for (const to of recipients) {
          try {
            await emailService.send('collection_confirmation', {
              to,
              variables: {
                clientName: clientName || 'there',
                jobName,
                jobNumber: String(ctx.hirehop_id || ''),
                venueName: venueName || 'your venue',
                driverName: completionName,
                completedDate,
                completedAt: completedDateTime,
              },
              prependBanner: completionFallback ? buildFallbackBanner(completionFallback) : undefined,
            });
          } catch (emailErr) {
            console.error(`[portal completion] Failed to email collection confirmation to ${to}:`, emailErr);
          }
        }
        if (completionFallback) {
          await logFallbackToTimeline({ jobId: completionFallback.jobId, templateId: 'collection_confirmation' });
        }
      }

      // Always send staff alert when the driver has notes
      if (fullNotes.trim()) {
        try {
          const frontendUrl = (process.env.FRONTEND_URL || 'https://staff.oooshtours.co.uk').replace(/\/$/, '');
          const jobUrl = `${frontendUrl}/operations/transport?quote=${quoteId}`;
          await emailService.send('completion_driver_notes', {
            to: 'info@oooshtours.co.uk',
            variables: {
              jobName,
              jobNumber: String(ctx.hirehop_id || ''),
              jobType: jobType === 'crewed' ? 'crew work' : jobType,
              driverName: completionName,
              venueName: venueName || 'N/A',
              customerPresent: customerPresent ? 'Yes' : 'No',
              completedAt: completedDateTime,
              completedDate,
              notes: fullNotes,
              jobUrl,
            },
          });
        } catch (emailErr) {
          console.error('[portal completion] Failed to send staff alert:', emailErr);
        }
      }

      // Last-mover auto-dispatch now lives in maybeCloseQuote (services/
      // quote-completion.ts), called above — it fires when the quote actually
      // closes, whichever leg is last, so a van-only delivery closed by the
      // book-out and a "both" closed by this /complete both dispatch exactly
      // once. Nothing to do here.
    })().catch(err => console.error('[portal completion] Background task error:', err));
  } catch (error) {
    console.error('Portal completion error:', error);
    res.status(500).json({ error: 'Failed to submit completion' });
  }
});

// ── GET /api/portal/jobs/:quoteId/files — shared job + venue files ───
// Returns files tagged share_with_freelancer = true from the linked job
// and its venue. Portal UI uses this to offer file downloads.

router.get('/jobs/:quoteId/files', async (req: PortalRequest, res: Response) => {
  try {
    const personId = req.portalUser!.id;
    const isStaffShared = req.portalUser!.isStaffShared;
    const quoteId = req.params.quoteId;

    if (!isUuidLike(quoteId)) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const result = await query(
      `SELECT j.files AS job_files, v.files AS venue_files,
              j.job_name, v.name AS venue_name
       FROM quote_assignments qa
       JOIN quotes q ON q.id = qa.quote_id
       LEFT JOIN jobs j ON j.id = q.job_id
       LEFT JOIN venues v ON v.id = q.venue_id
       WHERE qa.quote_id = $1 AND (qa.person_id = $2 OR (qa.is_ooosh_crew = true AND $3 = true))
         AND q.is_deleted = false`,
      [quoteId, personId, isStaffShared]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    const row = result.rows[0];
    interface SharedFileRaw {
      share_with_freelancer?: boolean;
      name?: string;
      original_name?: string;
      url?: string;
      key?: string;
      type?: string;
      content_type?: string;
      label?: string;
      uploaded_at?: string;
    }
    const filterShared = (files: unknown, source: 'job' | 'venue') => {
      if (!Array.isArray(files)) return [];
      return (files as SharedFileRaw[])
        .filter((f) => f?.share_with_freelancer === true)
        .map((f) => ({
          name: f.name || f.original_name || 'File',
          url: f.url || null,
          key: f.key || null,
          type: f.type || f.content_type || '',
          label: f.label || '',
          uploadedAt: f.uploaded_at || null,
          source,
        }));
    };

    const shared = [
      ...filterShared(row.job_files, 'job'),
      ...filterShared(row.venue_files, 'venue'),
    ];

    res.json({
      success: true,
      files: shared,
      job: { name: row.job_name || null },
      venue: { name: row.venue_name || null },
    });
  } catch (error) {
    console.error('Portal files error:', error);
    res.status(500).json({ error: 'Failed to load files' });
  }
});

// ── GET /api/portal/venues/:id — venue detail for portal ─────────────

router.get('/venues/:id', async (req: PortalRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT v.id, v.name, v.address, v.city, v.postcode,
              v.w3w_address AS what_three_words,
              COALESCE(v.approach_notes, v.general_notes) AS notes,
              v.files
       FROM venues v WHERE v.id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'Venue not found' });
      return;
    }

    const v = result.rows[0];
    res.json({
      success: true,
      venue: {
        id: v.id,
        name: v.name,
        address: v.address,
        city: v.city,
        postcode: v.postcode,
        whatThreeWords: v.what_three_words,
        // Venue contacts not stored on venues table — surfaced via org people link
        contact1: null,
        phone: null,
        email: null,
        accessNotes: v.notes,
        files: v.files || [],
      },
    });
  } catch (error) {
    console.error('Portal venue error:', error);
    res.status(500).json({ error: 'Failed to load venue' });
  }
});

// ── Helper: format a quote row into portal-friendly shape ────────────

function formatJobForPortal(row: Record<string, unknown>) {
  const jobType = row.job_type as string;
  const isCrew = jobType === 'crewed';

  // Map ops_status to portal-visible status
  const opsStatus = (row.ops_status as string) || 'todo';
  let portalStatus: string;
  switch (opsStatus) {
    case 'todo': portalStatus = 'TO DO!'; break;
    case 'arranging': portalStatus = 'Arranging'; break;
    case 'arranged': portalStatus = 'All arranged & email driver'; break;
    case 'dispatched': portalStatus = 'Dispatched'; break;
    case 'arrived': portalStatus = 'Arrived'; break;
    case 'completed': portalStatus = 'All done!'; break;
    case 'cancelled': portalStatus = 'Not needed'; break;
    default: portalStatus = opsStatus; break;
  }

  // Base fields common to D&C and crew
  const base = {
    id: row.id as string,
    name: row.job_name
      ? `${jobType === 'delivery' ? 'DEL' : jobType === 'collection' ? 'COL' : 'CREW'}: ${(row.linked_venue_name || row.venue_name || row.job_name)}`
      : `${jobType === 'delivery' ? 'Delivery' : jobType === 'collection' ? 'Collection' : 'Crewed Job'}`,
    board: isCrew ? 'crew' as const : 'dc' as const,
    type: jobType as string,
    date: row.job_date as string | null,
    time: row.arrival_time as string | null,
    venueName: (row.linked_venue_name || row.venue_name) as string | null,
    venueId: row.venue_id as string | null,
    hhRef: row.hirehop_id ? String(row.hirehop_id) : null,
    status: portalStatus,
    opsStatus,
    // Key notes for the freelancer — was a separate `key_points` column pre
    // migration 079; now consolidated into `freelancer_notes`. Field name
    // preserved on the response so the Next.js portal needs no change.
    keyNotes: row.freelancer_notes as string | null,
    completedAtDate: row.completed_at ? new Date(row.completed_at as string).toISOString().split('T')[0] : null,
    completionNotes: row.completion_notes as string | null,
    isLocal: row.is_local as boolean,
    // Run grouping (D&C only). When the run has a combined_freelancer_fee,
    // that's the one figure the freelancer is being offered for the whole
    // run — individual per-quote fees are preserved on each quote row
    // for audit but ignored for display/payment.
    runGroup: row.run_group as string | null,
    runOrder: row.run_order as number | null,
    runGroupFee: row.run_group_fee as number | null,
    runCombinedFreelancerFee: row.run_combined_freelancer_fee != null
      ? Number(row.run_combined_freelancer_fee) : null,
    runCombinedClientFee: row.run_combined_client_fee != null
      ? Number(row.run_combined_client_fee) : null,
    runNotes: row.run_notes as string | null,
    // Fee info — individual quote fee, NOT the run combined fee. The
    // portal consumer (Next.js) sums driverPay across siblings and
    // replaces with runCombinedFreelancerFee at display time when set.
    driverPay: Number(row.agreed_rate || row.freelancer_fee_rounded || row.freelancer_fee || 0),
    // Freelancer notes
    freelancerNotes: row.freelancer_notes as string | null,
    // Arrangement details (so freelancer knows what's booked for them)
    tollsStatus: row.tolls_status as string | null,
    accommodationStatus: row.accommodation_status as string | null,
    flightStatus: row.flight_status as string | null,
    clientIntroduction: row.client_introduction as string | null,
    // Shared files from the job (filtered: only share_with_freelancer = true)
    sharedFiles: (() => {
      try {
        const files = row.job_files as unknown[];
        if (!Array.isArray(files)) return [];
        return files.filter((f: any) => f?.share_with_freelancer === true).map((f: any) => ({
          name: f.name || f.original_name || 'File',
          url: f.url,
          type: f.type || f.content_type || '',
          label: f.label || '',
        }));
      } catch { return []; }
    })(),
    // Expense clarity
    expensesIncluded: (() => {
      try {
        const expenses = row.expenses as unknown[];
        if (!Array.isArray(expenses)) return 0;
        return expenses.filter((e: any) => e?.includedInCharge === true && e?.type !== 'fuel')
          .reduce((sum: number, e: any) => sum + (Number(e.amount) || 0), 0);
      } catch { return 0; }
    })(),
    expensesNotIncluded: (() => {
      try {
        const expenses = row.expenses as unknown[];
        if (!Array.isArray(expenses)) return 0;
        return expenses.filter((e: any) => e?.includedInCharge === false && e?.type !== 'fuel')
          .reduce((sum: number, e: any) => sum + (Number(e.amount) || 0), 0);
      } catch { return 0; }
    })(),
    // Plain-English "your money on this job" for the freelancer (fee is separate).
    crewMoney: deriveCrewMoney(row.expenses),
  };

  if (isCrew) {
    return {
      ...base,
      isGrouped: false,
      jobType: row.work_type ? 'Transport + Crew' : 'Crew Only',
      workType: row.work_type as string | null,
      workTypeOther: row.work_type_other as string | null,
      workDurationHours: row.work_duration_hrs as number | null,
      workDescription: row.work_description as string | null,
      numberOfDays: row.num_days as number | null,
      finishDate: row.job_finish_date as string | null,
      freelancerFee: Number(row.agreed_rate || row.freelancer_fee_rounded || row.freelancer_fee || 0),
      distanceMiles: row.distance_miles as number | null,
      driveTimeMinutes: row.drive_time_mins as number | null,
      expenses: row.expenses || [],
      assignmentExpectedExpenses: row.assignment_expected_expenses as number | null,
    };
  }

  return {
    ...base,
    isGrouped: false,
    whatIsIt: row.what_is_it === 'vehicle' ? 'A vehicle' : 'Equipment',
    clientEmail: null as string | null,
  };
}

export default router;
