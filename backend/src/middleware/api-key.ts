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
