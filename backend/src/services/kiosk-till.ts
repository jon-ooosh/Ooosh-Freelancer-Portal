/**
 * The kiosk till — docs/STAFF-LOGIN-SECURITY-SPEC.md §4.
 *
 * The warehouse iPad logs in with a PIN (routes/warehouse.ts) and its session
 * carries `scopes: ['collections', 'till']`. The till is that same session on
 * the shop routes, held to an allow-list exactly as FREELANCER_PREP_ALLOW holds
 * a prep session (routes/vehicles.ts). This file answers:
 *
 *   • May the PIN be exchanged from this address? (`kiosk_allowed_ips`, §4.4)
 *   • Is this bearer a till session, and may it call THIS route? (§4.2)
 *   • Who is selling? A person from the dropdown (`listAssignablePeople`, §4.3) —
 *     a kiosk sale is recorded against that person, never against a login.
 *   • Is the warehouse PIN due a change? (quarterly bell, §4.5)
 *
 * A kiosk request carries `req.kiosk`, never `req.user`. Anything money-shaped
 * that needs a name behind it (refunds, reversals, the week) is simply not on
 * the list — the route never sees a kiosk request.
 */
import type { Response, NextFunction } from 'express';
import { query } from '../config/database';
import { authenticate, authorize, STAFF_ROLES, type AuthRequest } from '../middleware/auth';
import { verifyFor } from './tokens';
import { getSystemSetting, upsertSystemSetting } from '../routes/system-settings';
import { listAssignablePeople } from './assignable-staff';

export const KIOSK_IPS_SETTING = 'kiosk_allowed_ips';
export const KIOSK_READER_SETTING = 'stripe_terminal_kiosk';
export const KIOSK_PIN_ROTATED_SETTING = 'kiosk_pin_rotated_at';
const PIN_ROTATE_DAYS = 91;
const PIN_BELL_EVERY_DAYS = 14;

export interface KioskSession { sessionId: string; scopes: string[] }

type Rule = { method: string; pattern: RegExp };

/** §4.2 — what the till may call on /api/shop. Everything else needs a staff login. */
export const KIOSK_TILL_ALLOW: Rule[] = [
  { method: 'GET',  pattern: /^\/stock\/search$/ },
  { method: 'GET',  pattern: /^\/stock\/barcode\/[^/]+$/ },
  { method: 'GET',  pattern: /^\/stock\/status$/ },
  { method: 'GET',  pattern: /^\/stock\/\d+$/ },
  { method: 'POST', pattern: /^\/stock\/availability$/ },
  { method: 'GET',  pattern: /^\/jobs\/today$/ },
  { method: 'GET',  pattern: /^\/jobs\/search$/ },
  { method: 'GET',  pattern: /^\/jobs\/[^/]+\/receipt-contacts$/ },
  { method: 'GET',  pattern: /^\/sellers$/ },
  { method: 'GET',  pattern: /^\/discount-cap$/ },
  { method: 'POST', pattern: /^\/quote$/ },
  { method: 'POST', pattern: /^\/sales$/ },
  { method: 'GET',  pattern: /^\/sales$/ },                       // its own last few only (routes/shop.ts)
  { method: 'POST', pattern: /^\/sales\/[^/]+\/receipt$/ },
  { method: 'GET',  pattern: /^\/sales\/[^/]+\/receipt\/suggestions$/ },
];

/** §4.2 — the card reader from the kiosk, only while `stripe_terminal_kiosk` is on. */
export const KIOSK_TERMINAL_ALLOW: Rule[] = [
  { method: 'GET',  pattern: /^\/access$/ },
  { method: 'GET',  pattern: /^\/readers$/ },
  { method: 'POST', pattern: /^\/shop\/pay$/ },
  { method: 'GET',  pattern: /^\/sessions\/[^/]+$/ },
  { method: 'POST', pattern: /^\/sessions\/[^/]+\/(retry|cancel|simulate|receipt)$/ },
  { method: 'GET',  pattern: /^\/sessions\/[^/]+\/receipt$/ },
];

// ── Where the PIN works (§4.4) ─────────────────────────────────────────────

export async function kioskAllowedIps(): Promise<string[]> {
  const raw = (await getSystemSetting(KIOSK_IPS_SETTING)) || '';
  return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
}

/** Express gives an IPv4 behind the proxy as `::ffff:1.2.3.4`; compare the bare form. */
export function bareIp(ip: string | undefined): string {
  return String(ip || '').replace(/^::ffff:/i, '').trim();
}

/** Empty list = anywhere (the Settings page warns when it is empty). */
export async function kioskIpAllowed(ip: string | undefined): Promise<boolean> {
  const list = await kioskAllowedIps();
  if (list.length === 0) return true;
  const mine = bareIp(ip);
  return list.some((allowed) => bareIp(allowed) === mine);
}

// ── The till session on a staff router ─────────────────────────────────────

export function kioskFromBearer(authHeader: string | undefined): KioskSession | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const claims = verifyFor<{ scope?: string; sessionId?: string; scopes?: unknown }>('warehouse', authHeader.slice(7));
  if (!claims || claims.scope !== 'warehouse_session' || typeof claims.sessionId !== 'string') return null;
  const scopes = Array.isArray(claims.scopes) ? claims.scopes.filter((s): s is string => typeof s === 'string') : [];
  if (!scopes.includes('till')) return null;
  return { sessionId: claims.sessionId, scopes };
}

export async function kioskReaderEnabled(): Promise<boolean> {
  return ((await getSystemSetting(KIOSK_READER_SETTING)) || '').trim().toLowerCase() === 'true';
}

/**
 * Staff token → the usual `authenticate` + STAFF_ROLES. Otherwise a till session,
 * admitted only to the routes on `allow` (and, for the reader, only while the
 * setting is on). Anything else: 401 with no token, 403 with the wrong one.
 */
export function staffOrKioskTill(allow: Rule[], opts: { reader?: boolean } = {}) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    const kiosk = kioskFromBearer(req.headers.authorization);
    if (!kiosk) {
      authenticate(req, res, () => authorize(...STAFF_ROLES)(req, res, next));
      return;
    }
    const allowed = allow.some((rule) => rule.method === req.method && rule.pattern.test(req.path));
    if (!allowed) { res.status(403).json({ error: 'That needs a staff login, not the kiosk.' }); return; }
    if (opts.reader && !(await kioskReaderEnabled())) {
      res.status(403).json({ error: 'The card reader is not switched on for the kiosk till.' });
      return;
    }
    req.kiosk = kiosk;
    next();
  };
}

// ── Who is selling (§4.3) ──────────────────────────────────────────────────

/** The dropdown: people who could be given something to do — THE definition. */
export async function listKioskSellers(): Promise<{ person_id: string; name: string | null }[]> {
  return listAssignablePeople();
}

/** A kiosk sale must name one of them. Returns the person id. */
export async function assertKioskSeller(personId: unknown): Promise<string> {
  const id = String(personId || '').trim();
  if (!id) throw new Error('Who is making this sale? Pick a name first.');
  const ok = (await listKioskSellers()).some((p) => p.person_id === id);
  if (!ok) throw new Error('That person cannot be named on a sale — pick a name from the list.');
  return id;
}

// ── Quarterly PIN rotation bell (§4.5) ─────────────────────────────────────

/** Daily: three months since the PIN changed → a bell to admins, repeated fortnightly. */
export async function runKioskPinRotationCheck(): Promise<{ belled: boolean }> {
  const rotated = (await getSystemSetting(KIOSK_PIN_ROTATED_SETTING))?.trim();
  if (!rotated || !/^\d{4}-\d{2}-\d{2}$/.test(rotated)) return { belled: false };
  const ageDays = Math.floor((Date.now() - new Date(`${rotated}T00:00:00Z`).getTime()) / 86_400_000);
  if (ageDays < PIN_ROTATE_DAYS) return { belled: false };
  const lastBell = (await getSystemSetting('kiosk_pin_rotation_belled_at'))?.trim();
  if (lastBell && /^\d{4}-\d{2}-\d{2}$/.test(lastBell)) {
    const sinceBell = Math.floor((Date.now() - new Date(`${lastBell}T00:00:00Z`).getTime()) / 86_400_000);
    if (sinceBell < PIN_BELL_EVERY_DAYS) return { belled: false };
  }
  const admins = await query(`SELECT id FROM users WHERE role = 'admin' AND is_active = true AND login_disabled = false`);
  for (const a of admins.rows as { id: string }[]) {
    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
       VALUES ($1, 'kiosk_pin_rotation', 'Rotate the warehouse PIN', $2, 'system_settings', NULL, '/settings', 'normal')`,
      [a.id, `The warehouse kiosk PIN was last changed on ${rotated} (${ageDays} days ago). Change WAREHOUSE_PIN on the server, then press "PIN changed today" in Settings › Login security & kiosk.`],
    ).catch((e) => console.error('[kiosk] PIN rotation bell failed:', e));
  }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  await upsertSystemSetting('kiosk_pin_rotation_belled_at', today, {
    label: 'Warehouse kiosk: when admins were last reminded to rotate the PIN', category: 'security', sortOrder: 93,
  });
  return { belled: true };
}
