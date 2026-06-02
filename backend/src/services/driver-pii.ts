/**
 * driver-pii.ts — application-level encryption for sensitive driver fields.
 *
 * Phase 1 (dual-write) of the driver PII retrofit. See migration 103 and
 * services/encryption.ts. The encrypted values live in `<field>_encrypted`
 * TEXT columns alongside the original plaintext columns. During Phase 1 BOTH
 * are populated, and reads prefer encrypted but fall back to plaintext — so
 * nothing can blank even if a read path isn't wrapped yet. Phase 2 stops
 * writing plaintext and nulls the plaintext columns.
 *
 * Scope (the "clean", non-searched fields only): licence_number + postcode are
 * deliberately excluded — they're used in live search and can't be ILIKE'd as
 * ciphertext. See migration 103 for the rationale.
 *
 * Storage decisions:
 *  - Values are stored as strings. `date_of_birth` is a DATE column in the DB
 *    but we encrypt the canonical `YYYY-MM-DD` string (display-only, no date
 *    math anywhere).
 *  - If ENCRYPTION_KEY is not configured, encryptDriverPiiInto is a no-op (the
 *    plaintext write still happened) and a warning is logged — never store or
 *    surface a half-encrypted state.
 *
 * ── PHASE 2 TODO (before nulling plaintext) ────────────────────────────────
 * These read paths use ALIASED driver columns (e.g. `d.date_of_birth AS
 * driver_dob`), so decryptDriverRow() can't match them. They read plaintext
 * correctly in Phase 1, but MUST be converted to decrypt the `_encrypted`
 * companions before Phase 2 nulls the plaintext columns:
 *   - routes/hire-forms.ts ~1110  (hire-form PDF data builder, aliased)
 *   - routes/hire-forms.ts ~2028  (hire-form PDF data builder, aliased)
 * All `SELECT d.*` / `SELECT *` reads are already wrapped with
 * decryptDriverRow() and need no further change.
 */
import { encrypt, tryDecrypt, isEncryptionConfigured } from './encryption';

/** Driver columns encrypted in this phase. Order is irrelevant. */
export const DRIVER_PII_FIELDS = [
  'date_of_birth',
  'dvla_check_code',
  'address_line1',
  'address_line2',
  'address_full',
  'licence_address',
] as const;

export type DriverPiiField = (typeof DRIVER_PII_FIELDS)[number];

/** Minimal executor shape — satisfied by both the pool `query` helper and a
 *  pooled `client` inside a transaction. */
interface QueryExecutor {
  query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>;
}

/** Normalise a value to the canonical string we encrypt, or null. Dates that
 *  arrive as JS Date objects (e.g. a DATE column round-tripped) collapse to
 *  `YYYY-MM-DD`; everything else is trimmed to a string. */
function toStorableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  return s.length === 0 ? null : s;
}

/**
 * Dual-write the encrypted companions for whichever of the PII fields are
 * present in `values`. Call AFTER the normal (plaintext) INSERT/UPDATE has
 * written the row, with the SAME executor (so it joins an open transaction).
 *
 * Only keys present in `values` are touched — pass the subset that the write
 * actually set. A field explicitly set to null clears its encrypted column.
 *
 * No-op (with a single warning) when ENCRYPTION_KEY is unconfigured, so a
 * mis-provisioned server degrades to plaintext-only rather than failing writes.
 */
export async function encryptDriverPiiInto(
  exec: QueryExecutor,
  driverId: string,
  values: Partial<Record<DriverPiiField, unknown>>,
): Promise<void> {
  const present = DRIVER_PII_FIELDS.filter((f) => f in values);
  if (present.length === 0) return;

  if (!isEncryptionConfigured()) {
    console.warn(`[driver-pii] ENCRYPTION_KEY not configured — driver ${driverId} PII left plaintext-only (Phase 1 dual-write skipped).`);
    return;
  }

  const setClauses: string[] = [];
  const params: unknown[] = [];
  for (const field of present) {
    const storable = toStorableString(values[field]);
    params.push(storable === null ? null : encrypt(storable));
    setClauses.push(`${field}_encrypted = $${params.length}`);
  }
  params.push(driverId);
  await exec.query(
    `UPDATE drivers SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
    params,
  );
}

/**
 * Decrypt a driver row IN PLACE: for each PII field, if the `<field>_encrypted`
 * column has a value, overwrite the plaintext field on the row object with the
 * decrypted value. Falls back to the existing plaintext column when there's no
 * ciphertext (un-backfilled rows) or decryption fails (tryDecrypt → null).
 *
 * Returns the same row for chaining. Safe to call on rows that didn't SELECT
 * the `_encrypted` columns (those fields are simply left untouched).
 *
 * `fellBack` counts fields that had no usable ciphertext and used plaintext —
 * surfaced via the module counter below for Phase-1 coverage telemetry (counts
 * only, never values).
 */
export function decryptDriverRow<T extends Record<string, unknown>>(row: T): T {
  if (!row) return row;
  for (const field of DRIVER_PII_FIELDS) {
    const cipher = row[`${field}_encrypted`];
    if (typeof cipher === 'string' && cipher.length > 0) {
      const plain = tryDecrypt(cipher);
      if (plain !== null) {
        (row as Record<string, unknown>)[field] = plain;
        continue;
      }
      // ciphertext present but undecryptable — fall back, count it
      plaintextFallbacks++;
    } else if (row[field] !== null && row[field] !== undefined) {
      // no ciphertext yet (un-backfilled) but plaintext exists — fall back
      plaintextFallbacks++;
    }
  }
  return row;
}

/** Decrypt a list of rows in place. */
export function decryptDriverRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  for (const r of rows) decryptDriverRow(r);
  return rows;
}

// ── Phase-1 coverage telemetry (counts only, never values) ──────────────────
// Lets us confirm the backfill reached 100% (zero fallbacks) before Phase 2
// nulls plaintext. Logged periodically rather than per-row to avoid noise.
let plaintextFallbacks = 0;
export function getDriverPiiFallbackCount(): number {
  return plaintextFallbacks;
}
