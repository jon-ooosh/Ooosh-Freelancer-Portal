/**
 * mobile-upload-token.ts — short-lived tokens for "capture on phone" handoff.
 *
 * A staff member on a laptop mints a token (rendered as a QR), the phone scans
 * it and uploads a file via a public, token-authenticated endpoint. The token
 * is scoped to a single purpose + target (e.g. an excess receipt scan), expires
 * quickly, and is single-use.
 *
 * First consumer: excess card-machine receipt scans. Reusable for future
 * book-out / check-in walkaround handoff.
 */
import { randomBytes } from 'node:crypto';
import { query } from '../config/database';

export type MobileUploadPurpose = 'excess_receipt';

const DEFAULT_TTL_MINS = 15;

export interface MobileUploadContext {
  id: string;
  purpose: MobileUploadPurpose;
  targetId: string;
  consumed: boolean;
  expired: boolean;
  // Display context for the phone page (resolved per-purpose)
  title: string;
  subtitle: string | null;
}

/** Mint a token for a purpose + target. Returns the raw token string. */
export async function createMobileUploadToken(opts: {
  purpose: MobileUploadPurpose;
  targetId: string;
  createdBy: string | null;
  ttlMins?: number;
}): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(24).toString('base64url');
  const ttl = opts.ttlMins ?? DEFAULT_TTL_MINS;
  const result = await query(
    `INSERT INTO mobile_upload_tokens (token, purpose, target_id, created_by, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' minutes')::interval)
     RETURNING expires_at`,
    [token, opts.purpose, opts.targetId, opts.createdBy, String(ttl)]
  );
  return { token, expiresAt: result.rows[0].expires_at };
}

/**
 * Resolve a token to its context + display info. Returns null if the token
 * doesn't exist. Sets `expired`/`consumed` flags so callers can decide.
 */
export async function resolveMobileUploadToken(token: string): Promise<MobileUploadContext | null> {
  const result = await query(
    `SELECT id, purpose, target_id, consumed_at, expires_at
     FROM mobile_upload_tokens WHERE token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const expired = new Date(row.expires_at).getTime() < Date.now();
  const consumed = Boolean(row.consumed_at);

  // Per-purpose display context.
  let title = 'Upload a file';
  let subtitle: string | null = null;
  if (row.purpose === 'excess_receipt') {
    const ex = await query(
      `SELECT je.excess_amount_required, je.amount_held, je.payment_method,
              COALESCE(d.full_name, je.client_name) AS who,
              fv.reg AS vehicle_reg, j.hh_job_number
       FROM job_excess je
       LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
       LEFT JOIN fleet_vehicles fv ON fv.id = vha.vehicle_id
       LEFT JOIN jobs j ON j.id = COALESCE(vha.job_id, je.job_id)
       WHERE je.id = $1`,
      [row.target_id]
    );
    if (ex.rows.length > 0) {
      const e = ex.rows[0];
      title = 'Upload excess receipt';
      const bits = [
        e.who || null,
        e.vehicle_reg ? `Van ${e.vehicle_reg}` : null,
        e.hh_job_number ? `Job #${e.hh_job_number}` : null,
      ].filter(Boolean);
      subtitle = bits.join(' · ') || null;
    }
  }

  return {
    id: row.id,
    purpose: row.purpose,
    targetId: row.target_id,
    consumed,
    expired,
    title,
    subtitle,
  };
}

/** Mark a token consumed with the resulting R2 key. */
export async function consumeMobileUploadToken(token: string, resultKey: string): Promise<void> {
  await query(
    `UPDATE mobile_upload_tokens SET consumed_at = NOW(), result_key = $2 WHERE token = $1`,
    [token, resultKey]
  );
}
