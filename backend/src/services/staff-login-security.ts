/**
 * Staff login security, phase 1 — docs/STAFF-LOGIN-SECURITY-SPEC.md §3.
 * (Phase 2's passkeys and recovery codes: services/staff-passkeys.ts.)
 *
 *   • The email code (second factor): sendLoginCode() / verifyLoginCode().
 *   • Trusted devices: a browser that passed the second factor carries the
 *     `op_device` cookie for 90 days and is not asked again. The cookie is a JWT
 *     (audience `trusted_device`) naming a row in user_trusted_devices; the ROW is
 *     the revocation. httpOnly and scoped to /api/auth, so the SPA's JavaScript
 *     (which holds the login in localStorage) never sees it — an XSS that steals
 *     the login must not also steal the device.
 *   • The per-account slowdown on wrong passwords, in Redis, fail-open: if Redis
 *     is away nobody is locked out (the per-IP limiter in routes/auth.ts still
 *     stands).
 *   • Enforcement: `system_settings.staff_2fa_enforced_from` — before that date a
 *     person with no second factor logs in as before (and sees a banner); from it
 *     the login insists.
 *
 * Nothing here mints a staff token: routes/auth.ts decides, this answers.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { query } from '../config/database';
import redisClient from '../config/redis';
import { emailService } from './email-service';
import { getSystemSetting } from '../routes/system-settings';
import { signFor, verifyFor } from './tokens';
import { greetingName } from './display-name';
import { countPasskeys, wipePasskeys } from './staff-passkeys';

export const DEVICE_COOKIE = 'op_device';
const DEVICE_DAYS = 90;
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 30;
const CODE_SENDS_PER_15_MIN = 3;
const FAIL_WINDOW_SECONDS = 60 * 60;
const FAIL_THRESHOLD = 5;        // every 5th failure blocks…
const FAIL_BLOCK_MINUTES = 15;   // …for 15 min, doubling each block, capped
const FAIL_BLOCK_CAP_MINUTES = 240;
const FAIL_BELL_AT = 10;

export interface LoginUserRow {
  id: string;
  email: string;
  role: string;
  first_name?: string | null;
  preferred_name?: string | null;
  mfa_enrolled_at?: Date | string | null;
  login_disabled?: boolean | null;
}

// ── Enforcement ────────────────────────────────────────────────────────────

/** The YYYY-MM-DD from which every login needs a second factor, or null = never. */
export async function enforcedFrom(): Promise<string | null> {
  const v = (await getSystemSetting('staff_2fa_enforced_from'))?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export async function isEnforcedNow(): Promise<boolean> {
  const from = await enforcedFrom();
  if (!from) return false;
  // Compare as UK calendar dates — a deadline is a day, not an instant.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  return today >= from;
}

/**
 * What the SPA needs to show the banner / the Security card. `passkey_required`
 * is the admin mandate (§1.2): an admin with no passkey is walked through adding
 * one before anything else (the Layout's modal will not close until they have).
 */
export async function securityInfo(user: LoginUserRow): Promise<{
  mfa_enrolled: boolean; mfa_enforced_from: string | null; passkeys: number; passkey_required: boolean;
}> {
  const passkeys = await countPasskeys(user.id);
  return {
    mfa_enrolled: !!user.mfa_enrolled_at,
    mfa_enforced_from: await enforcedFrom(),
    passkeys,
    passkey_required: user.role === 'admin' && passkeys === 0,
  };
}

// ── Email codes ────────────────────────────────────────────────────────────

function hashCode(userId: string, code: string): string {
  return crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

export type SendCodeResult = { ok: true } | { ok: false; status: number; error: string };

/** Mint, store and email a fresh 6-digit code. Voids any live code first. */
export async function sendLoginCode(user: LoginUserRow, deviceLabel?: string): Promise<SendCodeResult> {
  const recent = await query(
    `SELECT created_at FROM staff_login_codes
      WHERE user_id = $1 AND created_at > NOW() - INTERVAL '15 minutes'
      ORDER BY created_at DESC`,
    [user.id],
  );
  if (recent.rows.length >= CODE_SENDS_PER_15_MIN) {
    return { ok: false, status: 429, error: 'Too many codes sent — wait a few minutes and try again.' };
  }
  if (recent.rows[0] && Date.now() - new Date(recent.rows[0].created_at).getTime() < CODE_RESEND_SECONDS * 1000) {
    return { ok: false, status: 429, error: 'A code was just sent — give it a moment to arrive.' };
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);
  await query(
    `INSERT INTO staff_login_codes (user_id, code_hash, expires_at) VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval)`,
    [user.id, hashCode(user.id, code), String(CODE_MINUTES)],
  );

  const sent = await emailService.send('staff_login_code', {
    to: user.email,
    variables: {
      name: greetingName({ first_name: user.first_name ?? null, preferred_name: user.preferred_name ?? null }),
      code,
      expiryMinutes: String(CODE_MINUTES),
      deviceLabel: deviceLabel || '',
    },
  });
  if (!sent.success) {
    // emailService RESOLVES { success: false } on a delivery failure — never
    // tell the person a code is on its way when it is not.
    await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`, [user.id]);
    return { ok: false, status: 502, error: 'The code email could not be sent — try again in a minute.' };
  }
  return { ok: true };
}

export type VerifyCodeResult = { ok: true } | { ok: false; error: string };

/** Check a code against the person's one live code. Five wrong tries kill it. */
export async function verifyLoginCode(userId: string, code: string): Promise<VerifyCodeResult> {
  const r = await query(
    `SELECT id, code_hash, attempts, expires_at FROM staff_login_codes
      WHERE user_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: 'No code is waiting — send a new one.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'That code has expired — send a new one.' };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Too many wrong tries — send a new code.' };
  }
  const expected = Buffer.from(String(row.code_hash));
  const given = Buffer.from(hashCode(userId, String(code).trim()));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await query(`UPDATE staff_login_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: "That code doesn't match — check the email and try again." };
  }
  await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true };
}

/** First successful second factor = enrolled (phase 1: the email method). */
export async function markEnrolled(userId: string): Promise<void> {
  await query(`UPDATE users SET mfa_enrolled_at = COALESCE(mfa_enrolled_at, NOW()) WHERE id = $1`, [userId]);
}

// ── Trusted devices ────────────────────────────────────────────────────────

/** "iPhone · Safari", "Windows PC · Chrome" — a label, not fingerprinting. */
export function deviceLabelFrom(userAgent: string | undefined): string {
  const ua = userAgent || '';
  const device = /iPad/i.test(ua) ? 'iPad' : /iPhone/i.test(ua) ? 'iPhone' : /Android/i.test(ua) ? 'Android'
    : /Macintosh/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows PC' : /Linux/i.test(ua) ? 'Linux' : 'Device';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) ? 'Safari' : 'browser';
  return `${device} · ${browser}`;
}

export interface TrustedDevice { id: string; label: string; created_at: string; last_used_at: string }

/** Create the row and set the cookie. Call only after the second factor passed. */
export async function trustThisDevice(res: Response, userId: string, label: string): Promise<string> {
  const r = await query(
    `INSERT INTO user_trusted_devices (user_id, label) VALUES ($1, $2) RETURNING id`,
    [userId, label.slice(0, 80)],
  );
  const deviceId: string = r.rows[0].id;
  const token = signFor('trusted_device', { userId, deviceId }, `${DEVICE_DAYS}d`);
  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: DEVICE_DAYS * 24 * 60 * 60 * 1000,
  });
  return deviceId;
}

/**
 * The device id this request's cookie proves for THIS user, or null. A cookie
 * for another user (a shared laptop) is simply not a match. Touches last_used_at.
 */
export async function readTrustedDevice(req: Request, userId: string): Promise<string | null> {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[DEVICE_COOKIE];
  if (!raw) return null;
  const p = verifyFor<{ userId?: string; deviceId?: string }>('trusted_device', raw);
  if (!p || p.userId !== userId || !p.deviceId) return null;
  const r = await query(
    `UPDATE user_trusted_devices SET last_used_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [p.deviceId, userId],
  );
  return r.rows[0]?.id ?? null;
}

/** The id in the cookie without touching anything — for marking "this device" in a list. */
export function peekDeviceId(req: Request, userId: string): string | null {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[DEVICE_COOKIE];
  if (!raw) return null;
  const p = verifyFor<{ userId?: string; deviceId?: string }>('trusted_device', raw);
  return p && p.userId === userId && p.deviceId ? p.deviceId : null;
}

export function clearDeviceCookie(res: Response): void {
  res.clearCookie(DEVICE_COOKIE, { path: '/api/auth' });
}

export async function listTrustedDevices(userId: string): Promise<TrustedDevice[]> {
  const r = await query(
    `SELECT id, label, created_at, last_used_at FROM user_trusted_devices
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_used_at DESC`,
    [userId],
  );
  return r.rows;
}

export async function revokeTrustedDevice(userId: string, deviceId: string): Promise<boolean> {
  const r = await query(
    `UPDATE user_trusted_devices SET revoked_at = NOW()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [deviceId, userId],
  );
  return r.rows.length > 0;
}

/** Every refresh token and every trusted device, gone. Access tokens die within 15 min. */
export async function signOutEverywhere(userId: string): Promise<void> {
  await query(`UPDATE user_trusted_devices SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await query(`UPDATE users SET refresh_token = NULL WHERE id = $1`, [userId]);
}

/** An admin reset: the person starts again at their next login (§3.7). */
export async function resetSecondFactor(userId: string): Promise<void> {
  await signOutEverywhere(userId);
  await query(`UPDATE staff_login_codes SET consumed_at = NOW() WHERE user_id = $1 AND consumed_at IS NULL`, [userId]);
  await wipePasskeys(userId);
  await query(`UPDATE users SET mfa_enrolled_at = NULL WHERE id = $1`, [userId]);
}

// ── Per-account slowdown (Redis, fail-open) ────────────────────────────────

const failKey = (userId: string) => `login_fail:${userId}`;
const blockKey = (userId: string) => `login_block:${userId}`;

/** Seconds the account must still wait, 0 if it may try. */
export async function secondsBlocked(userId: string): Promise<number> {
  try {
    if (!redisClient.isOpen) return 0;
    const ttl = await redisClient.ttl(blockKey(userId));
    return ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}

/** A wrong password. Every 5th one blocks for 15 min, doubling, capped at 4 h. */
export async function recordLoginFailure(user: { id: string; email: string }): Promise<void> {
  try {
    if (!redisClient.isOpen) return;
    const n = await redisClient.incr(failKey(user.id));
    if (n === 1) await redisClient.expire(failKey(user.id), FAIL_WINDOW_SECONDS);
    if (n % FAIL_THRESHOLD === 0) {
      const level = n / FAIL_THRESHOLD;
      const minutes = Math.min(FAIL_BLOCK_MINUTES * 2 ** (level - 1), FAIL_BLOCK_CAP_MINUTES);
      await redisClient.set(blockKey(user.id), String(n), { EX: minutes * 60 });
    }
    if (n === FAIL_BELL_AT) await bellOnAttack(user);
  } catch (e) {
    console.warn('[login-security] failure counter unavailable:', (e as Error).message);
  }
}

export async function clearLoginFailures(userId: string): Promise<void> {
  try {
    if (!redisClient.isOpen) return;
    await redisClient.del([failKey(userId), blockKey(userId)]);
  } catch { /* fail-open */ }
}

// The freelancer portal's login (routes/portal.ts) gets the same slowdown,
// keyed by people.id under its own prefix (a portal account is a person, not a
// users row). Same thresholds; no bell, which is for staff accounts. Fail-open.
const portalFailKey = (personId: string) => `portal_login_fail:${personId}`;
const portalBlockKey = (personId: string) => `portal_login_block:${personId}`;

export async function portalSecondsBlocked(personId: string): Promise<number> {
  try {
    if (!redisClient.isOpen) return 0;
    const ttl = await redisClient.ttl(portalBlockKey(personId));
    return ttl > 0 ? ttl : 0;
  } catch {
    return 0;
  }
}

export async function recordPortalLoginFailure(personId: string): Promise<void> {
  try {
    if (!redisClient.isOpen) return;
    const n = await redisClient.incr(portalFailKey(personId));
    if (n === 1) await redisClient.expire(portalFailKey(personId), FAIL_WINDOW_SECONDS);
    if (n % FAIL_THRESHOLD === 0) {
      const level = n / FAIL_THRESHOLD;
      const minutes = Math.min(FAIL_BLOCK_MINUTES * 2 ** (level - 1), FAIL_BLOCK_CAP_MINUTES);
      await redisClient.set(portalBlockKey(personId), String(n), { EX: minutes * 60 });
    }
  } catch (e) {
    console.warn('[login-security] portal failure counter unavailable:', (e as Error).message);
  }
}

export async function clearPortalLoginFailures(personId: string): Promise<void> {
  try {
    if (!redisClient.isOpen) return;
    await redisClient.del([portalFailKey(personId), portalBlockKey(personId)]);
  } catch { /* fail-open */ }
}

async function bellOnAttack(user: { id: string; email: string }): Promise<void> {
  const admins = await query(`SELECT id FROM users WHERE role = 'admin' AND is_active = true AND login_disabled = false`);
  const targets = new Set<string>([user.id, ...admins.rows.map((r: { id: string }) => r.id)]);
  for (const uid of targets) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'login_attempts', $2, $3, 'users', $4, '/me?tab=profile', 'high')`,
      [uid, uid === user.id ? 'Someone is trying your password' : `Repeated wrong passwords for ${user.email}`,
        `Ten wrong passwords in an hour for ${user.email}. The account is slowed down automatically. If this is not you, change the password now.`,
        user.id],
    ).catch((e) => console.error('[login-security] attack bell failed:', e));
  }
}
