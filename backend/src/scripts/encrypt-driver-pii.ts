/**
 * Backfill encrypted companions for the "clean" driver PII fields (migration
 * 101 / services/driver-pii.ts). Phase 1: populates `<field>_encrypted` from
 * the existing plaintext columns. Does NOT null the plaintext — that's Phase 2,
 * run only after production reads are verified.
 *
 * Re-running is safe and idempotent — only rows where plaintext IS NOT NULL and
 * the encrypted companion IS NULL are touched.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/encrypt-driver-pii.ts            # dry-run (no writes)
 *   npx tsx src/scripts/encrypt-driver-pii.ts --verify   # key round-trip self-test, no writes
 *   npx tsx src/scripts/encrypt-driver-pii.ts --commit   # apply
 *
 * REQUIRES ENCRYPTION_KEY in the environment (same key the app uses). Without
 * it the script refuses to run — it must never write half-encrypted state.
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { encrypt, decrypt, isEncryptionConfigured } from '../services/encryption';
import { DRIVER_PII_FIELDS } from '../services/driver-pii';

dotenv.config();

const commit = process.argv.includes('--commit');
const verifyOnly = process.argv.includes('--verify');

/** DATE columns whose value we store as a canonical YYYY-MM-DD string. */
const DATE_FIELDS = new Set(['date_of_birth']);

function toStorable(field: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  if (s.length === 0) return null;
  return DATE_FIELDS.has(field) && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  if (!isEncryptionConfigured()) {
    console.error('ENCRYPTION_KEY not configured — refusing to run. Set it before backfilling.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const cols = DRIVER_PII_FIELDS.join(', ');
    const encCols = DRIVER_PII_FIELDS.map((f) => `${f}_encrypted`).join(', ');
    const { rows } = await client.query(
      `SELECT id, ${cols}, ${encCols} FROM drivers ORDER BY created_at`,
    );

    // ── Self-test: prove the live key round-trips before trusting it ──────────
    if (verifyOnly) {
      const sample = rows.find((r) =>
        DRIVER_PII_FIELDS.some((f) => r[f] !== null && r[f] !== undefined && String(r[f]).trim() !== ''),
      );
      if (!sample) {
        console.log('No driver with any plaintext PII to round-trip. Key is configured though.');
        return;
      }
      const field = DRIVER_PII_FIELDS.find((f) => toStorable(f, sample[f]) !== null)!;
      const plain = toStorable(field, sample[field])!;
      const cipher = encrypt(plain);
      const back = decrypt(cipher);
      const ok = back === plain;
      console.log(`Round-trip on driver ${sample.id}, field "${field}":`);
      console.log(`  plaintext length:  ${plain.length}`);
      console.log(`  ciphertext length: ${cipher.length}`);
      console.log(`  decrypt matches:   ${ok ? 'YES ✓' : 'NO ✗'}`);
      if (!ok) process.exit(2);
      return;
    }

    console.log(`Mode: ${commit ? 'COMMIT (will write)' : 'DRY RUN (no changes)'}`);
    console.log(`Drivers scanned: ${rows.length}\n`);

    let rowsUpdated = 0;
    let fieldsEncrypted = 0;
    const perField: Record<string, number> = {};

    for (const row of rows) {
      const setClauses: string[] = [];
      const params: unknown[] = [];
      for (const field of DRIVER_PII_FIELDS) {
        const plain = toStorable(field, row[field]);
        const alreadyEncrypted = row[`${field}_encrypted`];
        if (plain !== null && !alreadyEncrypted) {
          params.push(encrypt(plain));
          setClauses.push(`${field}_encrypted = $${params.length}`);
          perField[field] = (perField[field] || 0) + 1;
          fieldsEncrypted++;
        }
      }
      if (setClauses.length === 0) continue;
      rowsUpdated++;
      if (commit) {
        params.push(row.id);
        await client.query(
          `UPDATE drivers SET ${setClauses.join(', ')} WHERE id = $${params.length}`,
          params,
        );
      }
    }

    console.log(`Rows ${commit ? 'updated' : 'that would update'}: ${rowsUpdated}`);
    console.log(`Fields ${commit ? 'encrypted' : 'that would encrypt'}: ${fieldsEncrypted}`);
    for (const f of DRIVER_PII_FIELDS) {
      if (perField[f]) console.log(`  ${f}: ${perField[f]}`);
    }
    if (!commit) console.log('\nDry run — re-run with --commit to apply.');
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
