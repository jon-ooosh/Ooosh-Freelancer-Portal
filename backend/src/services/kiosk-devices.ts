/**
 * The kiosk tablet lock — docs/STAFF-LOGIN-SECURITY-SPEC.md §9.
 *
 * The warehouse PIN works only on a tablet an admin has set up. Until Oct 2026
 * the PIN was held to the yard's public address (`kiosk_allowed_ips`, still in
 * services/kiosk-till.ts, now optional); the broadband's address changed on
 * 28 Oct and locked the warehouse out, so the lock moved from the building to
 * the device.
 *
 *   • Setting up: an admin asks for a one-time code (Settings › Login security
 *     & kiosk) and someone types it on the tablet's PIN page within 10 minutes.
 *     The kiosk_devices row goes live and the tablet carries the
 *     `op_kiosk_device` cookie naming it. The code is hashed at rest and works once.
 *   • The cookie is a JWT (audience `kiosk_device`) naming a row; the ROW is the
 *     revocation ("Forget"), as for staff trusted devices (staff-login-security.ts).
 *     httpOnly and scoped to /api/warehouse, so the page's JavaScript never sees
 *     it, and renewed at every PIN entry so a tablet in use never runs out.
 *   • `system_settings.kiosk_device_required` switches the lock. Anything but
 *     'false' is ON: a missing or mistyped setting locks, never opens.
 *
 * Forgetting a tablet stops its next PIN entry. A 12-hour session already open
 * on it runs to its end (the session token is not looked up per request).
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { signFor, verifyFor } from './tokens';
import { DISPLAY_NAME_SQL } from './display-name';

export const KIOSK_DEVICE_COOKIE = 'op_kiosk_device';
export const KIOSK_DEVICE_SETTING = 'kiosk_device_required';
const COOKIE_PATH = '/api/warehouse';
const DEVICE_DAYS = 365;
const SETUP_MINUTES = 10;
// No 0/O or 1/I: the code is read off one screen and typed on another.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export interface KioskTablet {
  id: string;
  label: string;
  status: 'active' | 'waiting';
  created_at: string;
  created_by_name: string | null;
  setup_expires_at: string | null;
  activated_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
}

/** Is the tablet lock on? Fails closed: only an explicit 'false' turns it off. */
export async function kioskDeviceLockOn(): Promise<boolean> {
  return ((await getSystemSetting(KIOSK_DEVICE_SETTING)) || '').trim().toLowerCase() !== 'false';
}

// ── Set-up codes ───────────────────────────────────────────────────────────

/** "K7MP-Q4XR" — 8 characters, about 40 bits, shown once. */
export function newSetupCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** What was typed, as the code it means: case, spaces and the dash don't matter. */
export function normaliseSetupCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashSetupCode(raw: unknown): string {
  return crypto.createHash('sha256').update(`kiosk-setup:${normaliseSetupCode(raw)}`).digest('hex');
}

/** An admin asks to set up a tablet: a waiting row and its one-time code. */
export async function startKioskSetup(
  label: string, userId: string,
): Promise<{ id: string; label: string; code: string; expires_at: string }> {
  const name = String(label || '').trim().slice(0, 60) || 'Warehouse tablet';
  const code = newSetupCode();
  const expires = new Date(Date.now() + SETUP_MINUTES * 60 * 1000);
  const r = await query(
    `INSERT INTO kiosk_devices (label, setup_code_hash, setup_expires_at, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, label, setup_expires_at`,
    [name, hashSetupCode(code), expires, userId],
  );
  return { id: r.rows[0].id, label: r.rows[0].label, code, expires_at: r.rows[0].setup_expires_at };
}

/**
 * The tablet typed a code. If it is live, the row goes live (once — the hash is
 * cleared in the same statement) and the tablet gets its cookie. Null = no such
 * live code: wrong, used, expired or cancelled.
 */
export async function completeKioskSetup(res: Response, rawCode: unknown): Promise<{ label: string } | null> {
  if (normaliseSetupCode(rawCode).length !== CODE_LENGTH) return null;
  const r = await query(
    `UPDATE kiosk_devices
        SET activated_at = NOW(), setup_code_hash = NULL
      WHERE setup_code_hash = $1 AND activated_at IS NULL AND revoked_at IS NULL
        AND setup_expires_at > NOW()
      RETURNING id, label`,
    [hashSetupCode(rawCode)],
  );
  const row = r.rows[0];
  if (!row) return null;
  setKioskDeviceCookie(res, row.id);
  return { label: row.label };
}

// ── The tablet's cookie ────────────────────────────────────────────────────

function setKioskDeviceCookie(res: Response, deviceId: string): void {
  const token = signFor('kiosk_device', { deviceId }, `${DEVICE_DAYS}d`);
  res.cookie(KIOSK_DEVICE_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: COOKIE_PATH,
    maxAge: DEVICE_DAYS * 24 * 60 * 60 * 1000,
  });
}

/** The live tablet this request's cookie names, or null. Reads only. */
export async function kioskDeviceFrom(req: Request): Promise<string | null> {
  const raw = (req as Request & { cookies?: Record<string, string> }).cookies?.[KIOSK_DEVICE_COOKIE];
  if (!raw) return null;
  const p = verifyFor<{ deviceId?: string }>('kiosk_device', raw);
  if (!p || typeof p.deviceId !== 'string') return null;
  const r = await query(
    `SELECT id FROM kiosk_devices WHERE id = $1 AND activated_at IS NOT NULL AND revoked_at IS NULL`,
    [p.deviceId],
  );
  return r.rows[0]?.id ?? null;
}

/** After a good PIN on a tablet: note it for the Settings list and renew its cookie. */
export async function markKioskDeviceUsed(res: Response, deviceId: string, ip: string): Promise<void> {
  await query(
    `UPDATE kiosk_devices SET last_used_at = NOW(), last_used_ip = $2 WHERE id = $1`,
    [deviceId, ip || null],
  );
  setKioskDeviceCookie(res, deviceId);
}

// ── Settings: the list and "Forget" ────────────────────────────────────────

/** Live tablets, then codes still waiting to be typed. Forgotten and expired rows are left out. */
export async function listKioskDevices(): Promise<KioskTablet[]> {
  const r = await query(
    `SELECT d.id, d.label, d.created_at, d.setup_expires_at, d.activated_at,
            d.last_used_at, d.last_used_ip,
            CASE WHEN d.activated_at IS NULL THEN 'waiting' ELSE 'active' END AS status,
            NULLIF(TRIM(${DISPLAY_NAME_SQL}), '') AS created_by_name
       FROM kiosk_devices d
       LEFT JOIN users u ON u.id = d.created_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE d.revoked_at IS NULL
        AND (d.activated_at IS NOT NULL OR d.setup_expires_at > NOW())
      ORDER BY (d.activated_at IS NULL), d.created_at DESC`,
  );
  return r.rows;
}

/** Forget a tablet (or cancel a waiting code). False = no such live row. */
export async function forgetKioskDevice(id: string, userId: string): Promise<boolean> {
  const r = await query(
    `UPDATE kiosk_devices SET revoked_at = NOW(), revoked_by = $2, setup_code_hash = NULL
      WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
    [id, userId],
  );
  return r.rows.length > 0;
}
