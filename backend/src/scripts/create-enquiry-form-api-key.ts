/**
 * Create the API key the website enquiry form's Cloudflare Worker uses to
 * POST to OP's /api/enquiry-intake endpoint.
 *
 * Run on the server (ONCE):
 *   cd /var/www/ooosh-portal/backend
 *   npx ts-node src/scripts/create-enquiry-form-api-key.ts
 *
 * It prints the plaintext key EXACTLY ONCE — copy it into the Worker's
 * wrangler secret (OP_API_KEY) immediately; it is bcrypt-hashed in the DB and
 * cannot be recovered afterwards. Re-running mints an ADDITIONAL key (both keep
 * working); revoke an old one by setting is_active=false on its row.
 *
 * Follows the documented api_keys creation pattern (bcrypt hash, prefix index).
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { query } from '../config/database';

async function main() {
  const key = `efk_live_${crypto.randomBytes(24).toString('hex')}`;
  const keyHash = await bcrypt.hash(key, 12);
  const keyPrefix = key.substring(0, 8);

  const result = await query(
    `INSERT INTO api_keys (name, key_hash, key_prefix, service, permissions, is_active)
     VALUES ($1, $2, $3, 'enquiry_form', '["enquiry_intake"]'::jsonb, true)
     RETURNING id`,
    ['Website Enquiry Form', keyHash, keyPrefix]
  );

  console.log('\n✅ Created enquiry_form API key.');
  console.log(`   Row id:   ${result.rows[0].id}`);
  console.log(`   Prefix:   ${keyPrefix}`);
  console.log('\n   PLAINTEXT KEY (shown once — copy into the Worker OP_API_KEY secret):\n');
  console.log(`   ${key}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to create enquiry_form API key:', err);
  process.exit(1);
});
