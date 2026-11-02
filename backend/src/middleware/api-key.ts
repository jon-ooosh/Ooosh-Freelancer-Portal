/**
 * Shared DB-backed API key verification.
 *
 * The original inline implementation in money.ts + webhooks.ts only matched
 * the first 8 chars of the supplied key against `api_keys.key_prefix` and
 * accepted any row with `is_active=true`. That meant any string starting with
 * a known prefix (e.g. `ppk_live`) authenticated. This helper does the
 * full-key bcrypt comparison the schema was always designed around.
 *
 * Used by routes that accept server-to-server API key auth backed by the
 * `api_keys` table. Routes that authenticate against a single env-var key
 * (driver-verification, hire-forms) use `crypto.timingSafeEqual` directly
 * and don't need this.
 */

import bcrypt from 'bcryptjs';
import { query } from '../config/database';

export interface ApiKeyRow {
  id: string;
  name: string;
  service: string;
  permissions: unknown;
}

/**
 * Verify a presented API key against the api_keys table.
 *
 * Returns the matched row on success, or null if no key matches.
 *
 * Side effect on success: bumps `last_used_at` (fire-and-forget).
 */
export async function verifyApiKey(apiKey: string): Promise<ApiKeyRow | null> {
  if (!apiKey || apiKey.length < 8) return null;
  const keyPrefix = apiKey.substring(0, 8);

  // Pull all candidates with this prefix. There is no UNIQUE constraint on
  // key_prefix in the schema, so in principle there could be more than one —
  // bcrypt-compare against each.
  const candidates = await query(
    `SELECT id, name, service, permissions, key_hash
     FROM api_keys
     WHERE key_prefix = $1 AND is_active = true`,
    [keyPrefix]
  );

  if (candidates.rows.length === 0) return null;

  for (const row of candidates.rows) {
    if (!row.key_hash) continue;
    try {
      const match = await bcrypt.compare(apiKey, row.key_hash);
      if (match) {
        // Bump last_used_at for diagnostics; don't block on it.
        query(`UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`, [row.id]).catch(() => {});
        return {
          id: row.id,
          name: row.name,
          service: row.service,
          permissions: row.permissions,
        };
      }
    } catch (err) {
      // bcrypt threw on a malformed hash row — log and skip rather than 500.
      console.error('[api-key] bcrypt.compare failed for row', row.id, ':', err);
    }
  }

  return null;
}

/**
 * Which money operation a request is, for `api_keys.permissions` (Oct 2026, payment
 * portal audit B.6). A key's `permissions` row is a JSON array of these names, or
 * `money:*` for everything. An EMPTY array (the column default, every key today) still
 * means unrestricted, so nothing changes until a row is set — then it is enforced:
 *
 *   UPDATE api_keys
 *      SET permissions = '["money:job-lookup","money:excess-info","money:stripe-event","money:payment-event"]'
 *    WHERE service = 'payment_portal';
 *
 * Those four are everything the portal calls. Without this, any valid key reached every
 * money route without an `authorize()` — `refund-payment` (Stripe refund + HireHop + Xero),
 * `record-payment`, `summary`, `payments`… — so a leaked Netlify env was money out.
 * `req.path` here is relative to the router mount (`/api/money`).
 */
export function moneyOperationFor(path: string): string | null {
  if (/^\/job-lookup\/[^/]+\/?$/.test(path)) return 'money:job-lookup';
  if (/^\/stripe-event\/(claim|record-deposit)\/?$/.test(path)) return 'money:stripe-event';
  if (/^\/[^/]+\/excess-info\/?$/.test(path)) return 'money:excess-info';
  if (/^\/[^/]+\/payment-event\/?$/.test(path)) return 'money:payment-event';
  return null;
}

export function apiKeyMayCall(permissions: unknown, path: string): boolean {
  const perms = Array.isArray(permissions) ? permissions.map(String) : [];
  if (perms.length === 0 || perms.includes('money:*')) return true;
  const op = moneyOperationFor(path);
  return op !== null && perms.includes(op);
}
