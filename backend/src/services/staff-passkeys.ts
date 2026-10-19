/**
 * Staff login security, phase 2 — passkeys and recovery codes
 * (docs/STAFF-LOGIN-SECURITY-SPEC.md §3.4, §3.5).
 *
 *   • A passkey (WebAuthn) stands in for BOTH the password and the code: Face ID /
 *     Touch ID / Windows Hello, nothing to phish. @simplewebauthn does the
 *     cryptography; this file keeps the rows and the challenges.
 *   • The relying-party id is the staff host (`WEBAUTHN_RP_ID`, default
 *     staff.oooshtours.co.uk) and the origin `https://` + that; both overridable
 *     by env for a scratch server. A passkey made on one RP id never works on another.
 *   • A challenge lives in Redis for 5 minutes (§3.4). No Redis, no passkey
 *     ceremony — the email code still works, so nobody is locked out.
 *   • Recovery codes are for admins only (jon holds them, §1): ten, single use,
 *     hashed like the email codes. Everyone else is recovered by an admin reset.
 *
 * Nothing here mints a staff token: routes/auth.ts decides, this answers.
 */
import crypto from 'crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type RegistrationResponseJSON, type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import { query } from '../config/database';
import redisClient from '../config/redis';

const RP_NAME = 'Ooosh Operations Platform';
const CHALLENGE_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;
// No 0/O/1/I — the codes are read off a printout.
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function rpId(): string {
  return (process.env.WEBAUTHN_RP_ID || 'staff.oooshtours.co.uk').trim();
}
export function rpOrigin(): string {
  return (process.env.WEBAUTHN_ORIGIN || `https://${rpId()}`).trim();
}

export class PasskeyError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | null;
  label: string;
  backed_up: boolean;
  created_at: string;
  last_used_at: string | null;
}

export interface PasskeySummary {
  id: string; label: string; backed_up: boolean; created_at: string; last_used_at: string | null;
}

// ── Challenges (Redis, 5 minutes) ──────────────────────────────────────────

async function putChallenge(key: string, value: object): Promise<void> {
  if (!redisClient.isOpen) throw new PasskeyError('Passkeys are not available right now — use an email code.', 503);
  await redisClient.set(key, JSON.stringify(value), { EX: CHALLENGE_SECONDS });
}

/** Read AND delete — a challenge answers once. */
async function takeChallenge<T>(key: string): Promise<T | null> {
  if (!redisClient.isOpen) return null;
  const raw = await redisClient.get(key);
  if (!raw) return null;
  await redisClient.del(key);
  try { return JSON.parse(raw) as T; } catch { return null; }
}

// ── Rows ───────────────────────────────────────────────────────────────────

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  const r = await query(
    `SELECT id, label, backed_up, created_at, last_used_at FROM user_passkeys
      WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
    [userId],
  );
  return r.rows;
}

export async function countPasskeys(userId: string): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM user_passkeys WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return r.rows[0]?.n ?? 0;
}

async function livePasskeyRows(userId: string): Promise<PasskeyRow[]> {
  const r = await query(`SELECT * FROM user_passkeys WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return r.rows;
}

/** Remove = revoke. True if it was this person's and live. */
export async function removePasskey(userId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE user_passkeys SET revoked_at = NOW() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
    [id, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** An admin reset (§3.7) or "start again": every passkey and recovery code, gone. */
export async function wipePasskeys(userId: string): Promise<void> {
  await query(`UPDATE user_passkeys SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  await query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
}

// ── Registration (My profile › Add a passkey) ──────────────────────────────

export async function registrationOptions(user: { id: string; email: string; name: string }): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await livePasskeyRows(user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: rpId(),
    userName: user.email,
    userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.credential_id, transports: p.transports ?? undefined })),
    // A discoverable credential is what lets "Sign in with a passkey" name the
    // person without a typed email (§3.1); user verification is the Face ID.
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
  await putChallenge(`webauthn:reg:${user.id}`, { challenge: options.challenge });
  return options;
}

export async function verifyRegistration(
  userId: string,
  response: RegistrationResponseJSON,
  label: string,
): Promise<PasskeySummary> {
  const held = await takeChallenge<{ challenge: string }>(`webauthn:reg:${userId}`);
  if (!held) throw new PasskeyError('That took too long — try adding the passkey again.');
  let verified: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: held.challenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      requireUserVerification: false,
    });
  } catch (err) {
    throw new PasskeyError(`The passkey could not be verified: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
  if (!verified.verified || !verified.registrationInfo) throw new PasskeyError('The passkey could not be verified.');
  const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
  const r = await query(
    `INSERT INTO user_passkeys (user_id, credential_id, public_key, counter, transports, label, device_type, backed_up)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (credential_id) DO UPDATE SET revoked_at = NULL, user_id = EXCLUDED.user_id,
       public_key = EXCLUDED.public_key, counter = EXCLUDED.counter, label = EXCLUDED.label
     RETURNING id, label, backed_up, created_at, last_used_at`,
    [
      userId, credential.id, Buffer.from(credential.publicKey), credential.counter,
      credential.transports ?? null, label.trim().slice(0, 80) || 'Passkey',
      credentialDeviceType, credentialBackedUp,
    ],
  );
  return r.rows[0];
}

// ── Authentication (login) ─────────────────────────────────────────────────

/**
 * Options for a login. With a user id (the second step after a password) only
 * that person's passkeys are offered; without one (passkey as the whole login)
 * the browser picks a discoverable credential and the response names the person.
 */
export async function authenticationOptions(userId: string | null): Promise<{ options: PublicKeyCredentialRequestOptionsJSON; nonce: string }> {
  const allow = userId ? await livePasskeyRows(userId) : [];
  if (userId && allow.length === 0) throw new PasskeyError('You have no passkey yet — use the email code.');
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    userVerification: 'preferred',
    allowCredentials: allow.map((p) => ({ id: p.credential_id, transports: p.transports ?? undefined })),
  });
  const nonce = crypto.randomBytes(16).toString('hex');
  await putChallenge(`webauthn:auth:${nonce}`, { challenge: options.challenge, userId });
  return { options, nonce };
}

/** The passkey signed our challenge: who is it? */
export async function verifyAuthentication(nonce: string, response: AuthenticationResponseJSON): Promise<{ userId: string; passkeyId: string }> {
  if (!/^[0-9a-f]{32}$/.test(String(nonce))) throw new PasskeyError('Your login has expired — start again', 401);
  const held = await takeChallenge<{ challenge: string; userId: string | null }>(`webauthn:auth:${nonce}`);
  if (!held) throw new PasskeyError('Your login has expired — start again', 401);
  const r = await query(`SELECT * FROM user_passkeys WHERE credential_id = $1 AND revoked_at IS NULL`, [String(response?.id ?? '')]);
  const row = r.rows[0] as PasskeyRow | undefined;
  // A passkey OP has never seen, or one removed from the profile — same answer.
  if (!row || (held.userId && row.user_id !== held.userId)) throw new PasskeyError('That passkey is not registered here.', 401);
  let verified: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: held.challenge,
      expectedOrigin: rpOrigin(),
      expectedRPID: rpId(),
      requireUserVerification: false,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: Number(row.counter),
        transports: row.transports ?? undefined,
      },
    });
  } catch (err) {
    throw new PasskeyError(`The passkey could not be verified: ${err instanceof Error ? err.message : 'unknown error'}`, 401);
  }
  if (!verified.verified) throw new PasskeyError('The passkey could not be verified.', 401);
  await query(
    `UPDATE user_passkeys SET counter = $2, last_used_at = NOW(), backed_up = $3 WHERE id = $1`,
    [row.id, verified.authenticationInfo.newCounter, verified.authenticationInfo.credentialBackedUp],
  );
  return { userId: row.user_id, passkeyId: row.id };
}

// ── Recovery codes (admins only) ───────────────────────────────────────────

function normaliseRecoveryCode(code: string): string {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashRecoveryCode(userId: string, code: string): string {
  return crypto.createHash('sha256').update(`${userId}:recovery:${normaliseRecoveryCode(code)}`).digest('hex');
}
function randomRecoveryCode(): string {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += RECOVERY_ALPHABET[bytes[i] % RECOVERY_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** A fresh set of ten; the old set is void. Shown once — only the hashes stay. */
export async function generateRecoveryCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, randomRecoveryCode);
  await query(`DELETE FROM user_recovery_codes WHERE user_id = $1`, [userId]);
  for (const c of codes) {
    await query(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [userId, hashRecoveryCode(userId, c)]);
  }
  return codes;
}

export async function recoveryCodesLeft(userId: string): Promise<number> {
  const r = await query(`SELECT COUNT(*)::int AS n FROM user_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId]);
  return r.rows[0]?.n ?? 0;
}

/** Consume a code. False for a wrong, used or unknown one. */
export async function useRecoveryCode(userId: string, code: string): Promise<boolean> {
  if (normaliseRecoveryCode(code).length !== 8) return false;
  const r = await query(
    `UPDATE user_recovery_codes SET used_at = NOW()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
    [userId, hashRecoveryCode(userId, code)],
  );
  return (r.rowCount ?? 0) > 0;
}
