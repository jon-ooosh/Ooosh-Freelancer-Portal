/**
 * Audit api_keys rows to confirm key_hash values are bcrypt-shaped.
 *
 * Run BEFORE deploying the full-key bcrypt verification fix
 * (commit "Auth: api_keys verification now bcrypt-compares full key…").
 *
 * If any active row's key_hash doesn't start with `$2` (bcrypt prefix), the
 * new verifier will reject all keys with that prefix — the Payment Portal /
 * external integrations using that key will get 403s.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx ts-node src/scripts/audit-api-key-hashes.ts
 *
 * Output classifies each row as:
 *   - bcrypt: hash looks correct, full-key verification will work
 *   - non-bcrypt: hash is plaintext / different format → key needs to be
 *                 re-issued and the Payment Portal env var updated before
 *                 the new code is deployed (or the key will stop authing).
 *   - missing: key_hash is null/empty → row was inserted incorrectly.
 */

import { query } from '../config/database';

async function main() {
  const result = await query(
    `SELECT id, name, service, key_prefix, key_hash, is_active, last_used_at
     FROM api_keys
     ORDER BY is_active DESC, last_used_at DESC NULLS LAST`
  );

  const buckets = { bcrypt: 0, non_bcrypt: 0, missing: 0 };
  // Track only active rows for the deploy-safety warning. Inactive rows
  // never get queried by verifyApiKey, so they shouldn't trigger the
  // "will FAIL authentication" alarm even if their key_hash is junk.
  const activeBuckets = { bcrypt: 0, non_bcrypt: 0, missing: 0 };

  console.log(`Found ${result.rows.length} api_keys row(s):\n`);
  console.log('  ID                                    | active | service              | prefix    | hash status   | last_used');
  console.log('  ' + '-'.repeat(120));

  for (const row of result.rows) {
    const hash = row.key_hash || '';
    let status: 'bcrypt' | 'non_bcrypt' | 'missing';
    if (!hash) {
      status = 'missing';
    } else if (hash.startsWith('$2a$') || hash.startsWith('$2b$') || hash.startsWith('$2y$')) {
      status = 'bcrypt';
    } else {
      status = 'non_bcrypt';
    }
    buckets[status]++;
    if (row.is_active) activeBuckets[status]++;

    const lastUsed = row.last_used_at ? new Date(row.last_used_at).toISOString().substring(0, 10) : 'never';
    const activeLabel = row.is_active ? 'YES   ' : 'no    ';
    console.log(
      `  ${row.id} | ${activeLabel} | ${(row.service || '').padEnd(20)} | ${(row.key_prefix || '').padEnd(8)}  | ${status.padEnd(13)} | ${lastUsed}`
    );
  }

  console.log('\nSummary (all rows):');
  console.log(`  bcrypt-shaped: ${buckets.bcrypt}`);
  console.log(`  non-bcrypt:    ${buckets.non_bcrypt}  (irrelevant if inactive)`);
  console.log(`  missing hash:  ${buckets.missing}  (irrelevant if inactive)`);

  console.log('\nDeploy-safety check (active rows only — these are what verifyApiKey actually queries):');
  console.log(`  bcrypt-shaped: ${activeBuckets.bcrypt}  (full-key verification will work)`);
  console.log(`  non-bcrypt:    ${activeBuckets.non_bcrypt}  (will FAIL authentication after deploy — re-issue key first)`);
  console.log(`  missing hash:  ${activeBuckets.missing}  (will FAIL authentication after deploy — re-issue key first)`);

  if (activeBuckets.non_bcrypt > 0 || activeBuckets.missing > 0) {
    console.log('\n⚠️  Some active keys will stop authenticating after the bcrypt-comparison fix is deployed.');
    console.log('   To fix: generate a fresh key, bcrypt-hash it, INSERT a new row, distribute the new key,');
    console.log('   then deactivate the old row. Example:');
    console.log('     const bcrypt = require(\'bcryptjs\');');
    console.log('     const newKey = `ppk_live_${require(\'crypto\').randomBytes(24).toString(\'hex\')}`;');
    console.log('     const hash = await bcrypt.hash(newKey, 12);');
    console.log('     // INSERT INTO api_keys (name, key_hash, key_prefix, service) VALUES (...);');
    process.exit(1);
  }
  console.log('\n✓ All active keys are bcrypt-shaped. Deploy is safe.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(2);
});
