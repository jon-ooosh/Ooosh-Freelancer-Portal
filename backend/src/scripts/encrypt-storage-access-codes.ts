/**
 * One-shot backfill: encrypt existing plaintext storage door codes.
 *
 * Migration 121 added storage_tenancies.access_code_encrypted. New writes go
 * through the route's prepAccessCode() (ciphertext only). This script catches
 * tenancies created before the route change: it encrypts any remaining
 * plaintext access_code into access_code_encrypted and nulls the plaintext.
 *
 *   npx tsx src/scripts/encrypt-storage-access-codes.ts            # dry run
 *   npx tsx src/scripts/encrypt-storage-access-codes.ts --commit   # apply
 *
 * Idempotent: only touches rows where access_code IS NOT NULL. Re-running after
 * a commit is a no-op. Requires ENCRYPTION_KEY (refuses otherwise — no plaintext
 * fallback for a backfill, that would defeat the point).
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { encrypt, isEncryptionConfigured } from '../services/encryption';

dotenv.config();

const commit = process.argv.includes('--commit');

async function main() {
  if (!isEncryptionConfigured()) {
    console.error('ENCRYPTION_KEY is not set — refusing to backfill. Set the key first.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `SELECT id, access_code FROM storage_tenancies WHERE access_code IS NOT NULL`
    );
    console.log(`Found ${rows.length} tenancy row(s) with a plaintext access_code.`);
    if (rows.length === 0) return;

    let done = 0;
    for (const r of rows) {
      const enc = encrypt(r.access_code as string);
      if (commit) {
        await pool.query(
          `UPDATE storage_tenancies SET access_code_encrypted = $1, access_code = NULL, updated_at = NOW() WHERE id = $2`,
          [enc, r.id]
        );
      }
      done++;
      console.log(`${commit ? 'Encrypted' : 'Would encrypt'} tenancy ${r.id}`);
    }
    console.log(`\n${commit ? 'Committed' : 'Dry run —'} ${done} row(s).${commit ? '' : ' Re-run with --commit to apply.'}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
