/**
 * Backfill Person ↔ shell-org links.
 *
 * HireHop job sync creates a lightweight "shell" organisation from
 * job.COMPANY when the name doesn't match an existing org. For sole
 * traders (e.g. "Danny Stevens"), that shell has the same name as a
 * Person already in OP but there's no link between them — so
 * automated emails can't find a recipient.
 *
 * This script walks shell orgs (type='client', no email, created_by='hirehop_sync',
 * no active linked people) and tries to match them to a Person by full name.
 * Unambiguous matches get a `person_organisation_roles` row with role='Main Contact'.
 * Ambiguous matches (>1 Person candidate) are queued in sync_review_queue
 * with review_type='person_link_ambiguous'.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/backfill-shell-org-person-links.ts            # dry-run
 *   npx tsx src/scripts/backfill-shell-org-person-links.ts --commit   # apply
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const commit = process.argv.includes('--commit');

interface ShellOrg {
  id: string;
  name: string;
}

interface PersonMatch {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  try {
    const shells = await client.query<ShellOrg>(
      `SELECT id, name
       FROM organisations o
       WHERE type = 'client'
         AND (email IS NULL OR email = '')
         AND created_by = 'hirehop_sync'
         AND is_deleted = false
         AND NOT EXISTS (
           SELECT 1 FROM person_organisation_roles
           WHERE organisation_id = o.id AND status = 'active'
         )
       ORDER BY name`
    );

    console.log(`Found ${shells.rows.length} shell client orgs with no linked people.`);
    if (shells.rows.length === 0) return;

    let linked = 0;
    let flagged = 0;
    let skipped = 0;
    const samples: Array<{ org: string; action: string; detail: string }> = [];

    for (const org of shells.rows) {
      const matches = await client.query<PersonMatch>(
        `SELECT id, first_name, last_name, email
         FROM people
         WHERE is_deleted = false
           AND first_name IS NOT NULL
           AND last_name IS NOT NULL
           AND lower(trim(concat(first_name, ' ', last_name))) = lower(trim($1))`,
        [org.name]
      );

      if (matches.rows.length === 0) {
        skipped++;
        continue;
      }

      if (matches.rows.length === 1) {
        const p = matches.rows[0];
        const detail = `→ ${p.first_name} ${p.last_name}${p.email ? ` <${p.email}>` : ' (no email)'}`;
        if (commit) {
          await client.query(
            `INSERT INTO person_organisation_roles (person_id, organisation_id, role, status, is_primary)
             VALUES ($1, $2, 'Main Contact', 'active', true)
             ON CONFLICT DO NOTHING`,
            [p.id, org.id]
          );
        }
        linked++;
        if (samples.length < 10) samples.push({ org: org.name, action: 'link', detail });
        continue;
      }

      // Multiple candidates — queue for review
      const existing = await client.query(
        `SELECT 1 FROM sync_review_queue
         WHERE entity_type = 'organisation' AND entity_id = $1
           AND review_type = 'person_link_ambiguous' AND status = 'pending'`,
        [org.id]
      );
      if (existing.rows.length > 0) {
        skipped++;
        continue;
      }

      const detail = `→ ${matches.rows.length} candidates (${matches.rows.map(p => `${p.first_name} ${p.last_name}`).join(', ')})`;
      if (commit) {
        await client.query(
          `INSERT INTO sync_review_queue (entity_type, entity_id, review_type, summary, details)
           VALUES ('organisation', $1, 'person_link_ambiguous', $2, $3)`,
          [
            org.id,
            `Shell org "${org.name}" matches ${matches.rows.length} people — pick one to link as Main Contact.`,
            JSON.stringify({
              org_name: org.name,
              candidates: matches.rows.map(p => ({
                person_id: p.id,
                name: `${p.first_name} ${p.last_name}`,
                email: p.email,
              })),
            }),
          ]
        );
      }
      flagged++;
      if (samples.length < 10) samples.push({ org: org.name, action: 'flag', detail });
    }

    console.log('');
    console.log(`Summary (${commit ? 'COMMITTED' : 'DRY RUN'}):`);
    console.log(`  Auto-linked:      ${linked}`);
    console.log(`  Flagged ambiguous:${flagged}`);
    console.log(`  No match / skipped:${skipped}`);
    console.log('');
    if (samples.length > 0) {
      console.log('Samples:');
      for (const s of samples) {
        console.log(`  [${s.action}] ${s.org} ${s.detail}`);
      }
    }
    if (!commit) {
      console.log('');
      console.log('Re-run with --commit to apply.');
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
