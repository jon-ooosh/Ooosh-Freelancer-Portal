/**
 * Freelancer portal two-factor sign-in (docs/FREELANCER-PORTAL-SPEC.md §7, jon, Oct 2026).
 *
 * The staff design (services/staff-login-security.ts) copied for portal logins,
 * which are `people` rows, not `users`:
 *
 *   • The second step is a 6-digit code, emailed to the person, or read out to
 *     them on the phone by a member of staff ("Give them a sign-in code").
 *   • A phone that passed it is remembered for 90 days. OP signs a `portal_device`
 *     pass naming a row in portal_trusted_devices; the Netlify portal keeps it in
 *     an httpOnly cookie on its own domain and hands it back in the login body.
 *     The ROW is the revocation ("Sign them out everywhere" revokes them all).
 *   • The switch: system_settings.portal_2fa_enforced_from. Empty = off; from the
 *     date on, a phone that isn't remembered needs the code.
 *   • Sign-up and a password reset already prove the inbox, so they count as the
 *     second step and may remember the phone.
 *
 * What it protects against: a stolen or guessed password. Not a hijacked inbox,
 * which could already reset the password.
 *
 * Nothing here mints the portal session: routes/portal.ts decides, this answers.
 */
import crypto from 'crypto';
import { query } from '../config/database';
import { emailService } from './email-service';
import { getSystemSetting } from '../routes/system-settings';
import { signFor, verifyFor } from './tokens';
import { greetingName } from './display-name';
import { ukToday } from './uk-date';

const DEVICE_DAYS = 90;
const PENDING_MINUTES = 10;
const CODE_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODE_RESEND_SECONDS = 30;
const CODE_SENDS_PER_15_MIN = 3;

export { DEVICE_DAYS as PORTAL_DEVICE_DAYS };

export interface PortalPersonRow {
  id: string;
  email: string;
  first_name: string | null;
  preferred_name: string | null;
}

// ── The switch ──────────────────────────────────────────────────────────────

export async function portalEnforcedFrom(): Promise<string | null> {
  const v = (await getSystemSetting('portal_2fa_enforced_from'))?.trim();
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** On from the date (a UK calendar day), off while the setting is empty. */
export async function isPortalEnforcedNow(): Promise<boolean> {
  const from = await portalEnforcedFrom();
  return !!from && ukToday() >= from;
}

/** "j***@gmail.com": enough to know which inbox, no more. */
export function portalEmailHint(email: string): string {
  const [local, domain] = email.split('@');
  return `${(local || '').slice(0, 1)}***@${domain ?? ''}`;
}

// ── The pending step (password right, code owed) ─────────────────────────────

export function signPortalPending(personId: string): string {
  return signFor('portal_login_pending', { personId }, `${PENDING_MINUTES}m`);
}

/** The person a pending pass names, or null (bad, expired, another audience). */
export function readPortalPending(token: unknown): string | null {
  if (typeof token !== 'string' || !token) return null;
  const p = verifyFor<{ personId?: string }>('portal_login_pending', token);
  return p?.personId ?? null;
}

// ── Codes ───────────────────────────────────────────────────────────────────

function hashCode(personId: string, code: string): string {
  return crypto.createHash('sha256').update(`portal:${personId}:${code}`).digest('hex');
}

function newCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

async function storeCode(personId: string, code: string, issuedBy: string | null): Promise<string> {
  // One live code per person: a new one voids the old.
  await query(`UPDATE portal_login_codes SET consumed_at = NOW() WHERE person_id = $1 AND consumed_at IS NULL`, [personId]);
  const r = await query(
    `INSERT INTO portal_login_codes (person_id, code_hash, expires_at, issued_by)
     VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4) RETURNING id`,
    [personId, hashCode(personId, code), String(CODE_MINUTES), issuedBy],
  );
  return r.rows[0].id;
}

export type SendCodeResult = { ok: true } | { ok: false; status: number; error: string };

/** Mint, store and email a fresh code. Limited to 3 emails per 15 minutes, 30 seconds apart. */
export async function sendPortalLoginCode(person: PortalPersonRow, deviceLabel?: string): Promise<SendCodeResult> {
  const recent = await query(
    `SELECT created_at FROM portal_login_codes
      WHERE person_id = $1 AND issued_by IS NULL AND created_at > NOW() - INTERVAL '15 minutes'
      ORDER BY created_at DESC`,
    [person.id],
  );
  if (recent.rows.length >= CODE_SENDS_PER_15_MIN) {
    return { ok: false, status: 429, error: 'We\'ve sent a few codes already. Wait a few minutes, or call the office.' };
  }
  if (recent.rows[0] && Date.now() - new Date(recent.rows[0].created_at).getTime() < CODE_RESEND_SECONDS * 1000) {
    return { ok: false, status: 429, error: 'A code was just sent. Give it a moment to arrive.' };
  }

  const code = newCode();
  const codeId = await storeCode(person.id, code, null);
  const sent = await emailService.send('portal_login_code', {
    to: person.email,
    variables: {
      name: greetingName({ first_name: person.first_name, preferred_name: person.preferred_name }),
      code,
      expiryMinutes: String(CODE_MINUTES),
      deviceLabel: deviceLabel || '',
    },
  });
  if (!sent.success) {
    // emailService RESOLVES { success: false } on a delivery failure: never say a
    // code is on its way when it is not. The row goes, so a code that never left
    // doesn't hold up "Send a new code" ("A code was just sent") or use up one
    // of the three.
    await query(`DELETE FROM portal_login_codes WHERE id = $1`, [codeId]);
    return { ok: false, status: 502, error: 'The code email could not be sent. Try again in a minute, or call the office.' };
  }
  return { ok: true };
}

/**
 * "Give them a sign-in code": a fresh code for a member of staff to read out on
 * the phone. It replaces any emailed code, lasts as long, and still needs the
 * person's password. The route logs who asked.
 */
export async function issuePortalCodeForStaff(personId: string, userId: string): Promise<{ code: string; expiresMinutes: number }> {
  const code = newCode();
  await storeCode(personId, code, userId);
  return { code, expiresMinutes: CODE_MINUTES };
}

export type VerifyCodeResult = { ok: true } | { ok: false; error: string };

/** Check a code against the person's one live code. Five wrong tries kill it. */
export async function verifyPortalLoginCode(personId: string, code: string): Promise<VerifyCodeResult> {
  const r = await query(
    `SELECT id, code_hash, attempts, expires_at FROM portal_login_codes
      WHERE person_id = $1 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [personId],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: 'No code is waiting. Send a new one.' };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await query(`UPDATE portal_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'That code has expired. Send a new one.' };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await query(`UPDATE portal_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
    return { ok: false, error: 'Too many wrong tries. Send a new code.' };
  }
  const expected = Buffer.from(String(row.code_hash));
  const given = Buffer.from(hashCode(personId, String(code).trim()));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    await query(`UPDATE portal_login_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    return { ok: false, error: "That code doesn't match. Check the email and try again." };
  }
  await query(`UPDATE portal_login_codes SET consumed_at = NOW() WHERE id = $1`, [row.id]);
  return { ok: true };
}

// ── Remembered phones ───────────────────────────────────────────────────────

/** Create the row and return the signed pass. Call only after the second step passed. */
export async function rememberPortalDevice(personId: string, label: string): Promise<string> {
  const r = await query(
    `INSERT INTO portal_trusted_devices (person_id, label) VALUES ($1, $2) RETURNING id`,
    [personId, (label || 'Phone').slice(0, 80)],
  );
  return signFor('portal_device', { personId, deviceId: r.rows[0].id }, `${DEVICE_DAYS}d`);
}

/**
 * True when `token` is a live pass for THIS person (a pass for someone else, as
 * on a shared office phone, is simply not a match). Touches last_used_at.
 */
export async function isRememberedPortalDevice(token: unknown, personId: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const p = verifyFor<{ personId?: string; deviceId?: string }>('portal_device', token);
  if (!p || p.personId !== personId || !p.deviceId) return false;
  const r = await query(
    `UPDATE portal_trusted_devices SET last_used_at = NOW()
      WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL RETURNING id`,
    [p.deviceId, personId],
  );
  return r.rows.length > 0;
}

/** For the staff card: when they last signed in, and how many phones are remembered. */
export async function portalSignInStatus(personId: string): Promise<{
  lastSignIn: string | null; rememberedPhones: number; hasPortalPassword: boolean;
  enforcedFrom: string | null; enforcedNow: boolean;
}> {
  const p = await query(
    `SELECT portal_last_login, (portal_password_hash IS NOT NULL) AS has_password FROM people WHERE id = $1`,
    [personId],
  );
  // A pass lasts 90 days from when it was made (using it doesn't extend it).
  const d = await query(
    `SELECT COUNT(*)::int AS n FROM portal_trusted_devices
      WHERE person_id = $1 AND revoked_at IS NULL AND created_at > NOW() - ($2 || ' days')::interval`,
    [personId, String(DEVICE_DAYS)],
  );
  return {
    lastSignIn: p.rows[0]?.portal_last_login ?? null,
    rememberedPhones: d.rows[0]?.n ?? 0,
    hasPortalPassword: !!p.rows[0]?.has_password,
    enforcedFrom: await portalEnforcedFrom(),
    enforcedNow: await isPortalEnforcedNow(),
  };
}

/**
 * "Sign them out everywhere": every remembered phone forgotten, every live code
 * void, and every portal session issued before now refused (portalAuth checks
 * people.portal_sessions_valid_after on each request).
 */
export async function portalSignOutEverywhere(personId: string): Promise<void> {
  await query(`UPDATE portal_trusted_devices SET revoked_at = NOW() WHERE person_id = $1 AND revoked_at IS NULL`, [personId]);
  await query(`UPDATE portal_login_codes SET consumed_at = NOW() WHERE person_id = $1 AND consumed_at IS NULL`, [personId]);
  await query(`UPDATE people SET portal_sessions_valid_after = NOW() WHERE id = $1`, [personId]);
}
