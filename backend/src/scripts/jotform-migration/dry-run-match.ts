/**
 * Jotform Freelancer Migration — Dry-Run Email Match
 *
 * Reads the manifest, looks up each freelancer by email (case-insensitive)
 * against the OP people table, and prints a resolution report.
 *
 * Does NOT download, upload, or write anything. Read-only against the DB.
 *
 * Usage (from backend/ with DATABASE_URL set):
 *   npx tsx src/scripts/jotform-migration/dry-run-match.ts --manifest /path/to/jotform-freelancer-manifest.json
 */

import { readFileSync } from 'fs';
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

type ManifestFile = {
  tag: string;
  url: string;
  original_filename: string;
  ext: string;
  r2_filename: string;
};

type ManifestFreelancer = {
  submission_id: string;
  created_at: string;
  email: string;
  name: string;
  files: ManifestFile[];
};

type Manifest = {
  generated_at: string;
  total_chosen: number;
  total_files: number;
  tag_counts: Record<string, number>;
  freelancers: ManifestFreelancer[];
};

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main() {
  const manifestPath = getArg('--manifest');
  if (!manifestPath) {
    console.error('Usage: npx tsx dry-run-match.ts --manifest <path>');
    process.exit(1);
  }

  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const emails = manifest.freelancers.map((f) => f.email.toLowerCase().trim());

  // Bulk lookup by case-insensitive email
  const { rows } = await pool.query<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    is_freelancer: boolean | null;
    is_approved: boolean | null;
    files: unknown;
  }>(
    `SELECT id, LOWER(email) AS email, first_name, last_name, is_freelancer, is_approved, files
       FROM people
      WHERE LOWER(email) = ANY($1::text[])`,
    [emails]
  );

  const byEmail = new Map(rows.map((r) => [r.email, r]));

  const matched: Array<{ manifest: ManifestFreelancer; person: typeof rows[number] }> = [];
  const missed: ManifestFreelancer[] = [];

  for (const f of manifest.freelancers) {
    const p = byEmail.get(f.email.toLowerCase().trim());
    if (p) matched.push({ manifest: f, person: p });
    else missed.push(f);
  }

  console.log('=== Jotform Freelancer Migration — Dry-Run Match ===');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Freelancers in manifest: ${manifest.freelancers.length}`);
  console.log(`Files in manifest:       ${manifest.total_files}`);
  console.log(`Matched to people:       ${matched.length}`);
  console.log(`Missed:                  ${missed.length}`);
  console.log('');

  console.log('--- MATCHED ---');
  for (const { manifest: m, person: p } of matched) {
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ') || '(no name)';
    const flags = [
      p.is_freelancer ? 'freelancer' : null,
      p.is_approved ? 'approved' : null,
    ].filter(Boolean).join(',') || 'none';
    const existingFileCount = Array.isArray(p.files) ? (p.files as unknown[]).length : 0;
    console.log(
      `  ${m.email.padEnd(42)} → ${p.id}  "${name}"  [${flags}]  ` +
      `manifest=${m.files.length} files, existing=${existingFileCount}`
    );
  }

  console.log('');
  console.log('--- MISSED (no person with that email) ---');
  for (const m of missed) {
    console.log(`  ${m.email.padEnd(42)}  "${m.name}"  (${m.files.length} files)`);
  }

  console.log('');
  console.log('--- FILE TAG BREAKDOWN (matched freelancers only) ---');
  const tagCounts: Record<string, number> = {};
  for (const { manifest: m } of matched) {
    for (const f of m.files) tagCounts[f.tag] = (tagCounts[f.tag] || 0) + 1;
  }
  for (const [tag, count] of Object.entries(tagCounts)) {
    console.log(`  ${tag.padEnd(16)} ${count}`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
