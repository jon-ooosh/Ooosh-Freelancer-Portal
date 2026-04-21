/**
 * Jotform Freelancer Migration — Upload + Commit
 *
 * For each matched freelancer:
 *   1. Download every Jotform file into memory (fail fast — abort person on any 404).
 *   2. PUT each buffer to R2 under files/people/<person-id>/<r2_filename>.
 *   3. In a DB transaction, append the JSONB file entries to people.files.
 *   4. On partial-R2 failure (some PUTs succeeded before one failed), delete the
 *      uploads made during this person's pass — the DB never saw them.
 *
 * Idempotent: per-person, skip files whose R2 key is already present in people.files.url.
 *
 * Usage (dry-run — default, reports what it would do, no writes):
 *   npx tsx src/scripts/jotform-migration/upload.ts --manifest /tmp/jotform-freelancer-manifest.json
 *
 * Single person test:
 *   npx tsx src/scripts/jotform-migration/upload.ts --manifest /tmp/jotform-freelancer-manifest.json --only-email lmjohnson931@gmail.com
 *
 * Commit for real:
 *   npx tsx src/scripts/jotform-migration/upload.ts --manifest /tmp/jotform-freelancer-manifest.json --commit
 */

import { readFileSync } from 'fs';
import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { uploadToR2, deleteFromR2, isR2Configured } from '../../config/r2';

dotenv.config();

// Manifest email → corrected DB email (one-off fix for known typos)
const EMAIL_ALIASES: Record<string, string> = {
  'gareth@elepahntriders.co.uk': 'gareth@elephantriders.co.uk',
};

const SKIP_EMAILS = new Set<string>([
  'darren.davies@hotmail.co.uk',
  'ab.shackell@gmail.com',
]);

const UPLOADED_BY = 'jon@oooshtours.co.uk';

type ManifestFile = {
  tag: 'licence-front' | 'licence-back' | 'dvla' | 'additional';
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

type Manifest = { freelancers: ManifestFreelancer[] };

function getArg(flag: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}
const commit = process.argv.includes('--commit');
const onlyEmail = getArg('--only-email')?.toLowerCase().trim();
const manifestPath = getArg('--manifest');

if (!manifestPath) {
  console.error('Usage: --manifest <path> [--commit] [--only-email <addr>]');
  process.exit(1);
}

function resolveEmail(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return EMAIL_ALIASES[lower] ?? lower;
}

function getFileType(ext: string): 'image' | 'document' | 'other' {
  const e = ext.toLowerCase().replace(/^\./, '');
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(e)) return 'image';
  if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'txt', 'rtf'].includes(e)) return 'document';
  return 'other';
}

function getContentType(ext: string): string {
  const e = ext.toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[e] ?? 'application/octet-stream';
}

function labelFor(tag: ManifestFile['tag']): string | undefined {
  switch (tag) {
    case 'licence-front': return 'Licence Front';
    case 'licence-back':  return 'Licence Back';
    case 'dvla':          return 'DVLA Check';
    case 'additional':    return undefined;
  }
}

/** Encode spaces in Jotform URLs (other chars are already safe). */
function encodeJotformUrl(url: string): string {
  return url.replace(/ /g, '%20');
}

const DOWNLOAD_DELAY_MS = 1200;       // between successful downloads
const RETRY_BACKOFF_MS = [3000, 8000, 20000]; // on 429

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function downloadBuffer(url: string, log: (m: string) => void): Promise<Buffer> {
  const target = encodeJotformUrl(url);
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    const res = await fetch(target);
    if (res.ok) {
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    }
    if (res.status === 429 && attempt < RETRY_BACKOFF_MS.length) {
      const wait = RETRY_BACKOFF_MS[attempt];
      log(`      429 rate-limited, waiting ${wait}ms then retry ${attempt + 1}/${RETRY_BACKOFF_MS.length}`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  throw new Error(`retries exhausted for ${url}`);
}

type PersonRow = { id: string; email: string; files: unknown };

async function processFreelancer(
  pool: Pool,
  f: ManifestFreelancer,
  person: PersonRow,
  log: (msg: string) => void
): Promise<{ uploaded: number; skipped: number }> {
  const existingFiles = (Array.isArray(person.files) ? person.files : []) as Array<{ url?: string }>;
  const existingKeys = new Set(existingFiles.map((x) => x.url).filter((x): x is string => !!x));

  const toUpload: Array<{
    file: ManifestFile;
    key: string;
    entry: Record<string, unknown>;
    buffer?: Buffer;
  }> = [];

  for (const file of f.files) {
    const key = `files/people/${person.id}/${file.r2_filename}`;
    if (existingKeys.has(key)) {
      log(`    ↷ skip (already present): ${file.r2_filename}`);
      continue;
    }
    const entry: Record<string, unknown> = {
      name: file.original_filename,
      url: key,
      type: getFileType(file.ext),
      uploaded_at: new Date().toISOString(),
      uploaded_by: UPLOADED_BY,
      comment: `Imported from Jotform ${f.created_at.slice(0, 10)} (submission ${f.submission_id})`,
    };
    const label = labelFor(file.tag);
    if (label) entry.label = label;
    toUpload.push({ file, key, entry });
  }

  if (toUpload.length === 0) {
    return { uploaded: 0, skipped: f.files.length };
  }

  // 1. Download everything first (fail fast on any missing URL)
  for (let i = 0; i < toUpload.length; i++) {
    const item = toUpload[i];
    log(`    ↓ download: ${item.file.r2_filename}`);
    if (!commit) continue;
    item.buffer = await downloadBuffer(item.file.url, log);
    if (i < toUpload.length - 1) await sleep(DOWNLOAD_DELAY_MS);
  }

  if (!commit) return { uploaded: toUpload.length, skipped: f.files.length - toUpload.length };

  // 2. Upload to R2 — track successes so we can roll back on failure
  const uploadedKeys: string[] = [];
  try {
    for (const item of toUpload) {
      log(`    ↑ r2 put: ${item.key}`);
      await uploadToR2(item.key, item.buffer!, getContentType(item.file.ext));
      uploadedKeys.push(item.key);
    }

    // 3. DB transaction — append to people.files
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE people
           SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb,
               updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(toUpload.map((x) => x.entry)), person.id]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    return { uploaded: toUpload.length, skipped: f.files.length - toUpload.length };
  } catch (err) {
    // Roll back any R2 PUTs we made during this person's pass
    log(`    ✖ error for ${person.email}: ${(err as Error).message}`);
    log(`    ⟲ rolling back ${uploadedKeys.length} R2 object(s)`);
    for (const key of uploadedKeys) {
      try { await deleteFromR2(key); } catch (e) {
        log(`      (rollback delete failed for ${key}: ${(e as Error).message})`);
      }
    }
    throw err;
  }
}

async function main() {
  if (commit && !isR2Configured()) {
    console.error('R2 not configured — set R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const manifest: Manifest = JSON.parse(readFileSync(manifestPath!, 'utf8'));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const resolvedEmails = manifest.freelancers
    .map((f) => resolveEmail(f.email))
    .filter((e) => !SKIP_EMAILS.has(e));

  const { rows } = await pool.query<PersonRow>(
    `SELECT id, LOWER(email) AS email, files
       FROM people WHERE LOWER(email) = ANY($1::text[])`,
    [resolvedEmails]
  );
  const byEmail = new Map(rows.map((r) => [r.email, r]));

  console.log('=== Jotform Freelancer Upload ===');
  console.log(`Mode:      ${commit ? 'COMMIT (writes enabled)' : 'DRY-RUN (no writes)'}`);
  if (onlyEmail) console.log(`Filter:    --only-email ${onlyEmail}`);
  console.log(`Manifest:  ${manifestPath}`);
  console.log('');

  let personsDone = 0;
  let filesUploaded = 0;
  let filesSkipped = 0;
  const failures: Array<{ email: string; err: string }> = [];

  for (const f of manifest.freelancers) {
    const email = resolveEmail(f.email);
    if (SKIP_EMAILS.has(email)) continue;
    if (onlyEmail && email !== onlyEmail) continue;

    const person = byEmail.get(email);
    if (!person) {
      console.log(`✖ MISS ${f.email} (${f.name}) — no OP person found`);
      continue;
    }

    console.log(`→ ${f.email}  ${person.id}  ${f.name}  (${f.files.length} files)`);
    try {
      const r = await processFreelancer(pool, f, person, (m) => console.log(m));
      filesUploaded += r.uploaded;
      filesSkipped += r.skipped;
      personsDone += 1;
    } catch (err) {
      failures.push({ email: f.email, err: (err as Error).message });
    }
  }

  console.log('');
  console.log('=== Summary ===');
  console.log(`People processed:  ${personsDone}`);
  console.log(`Files uploaded:    ${filesUploaded}${commit ? '' : ' (would upload)'}`);
  console.log(`Files skipped:     ${filesSkipped} (already present or person skipped)`);
  console.log(`Failures:          ${failures.length}`);
  for (const f of failures) console.log(`  - ${f.email}: ${f.err}`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
