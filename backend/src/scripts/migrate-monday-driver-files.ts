/**
 * Monday.com → OP migration for driver files (Board A file columns).
 *
 * For each OP driver with a monday_item_id, fetches Monday assets for:
 *   - Licence front        (file_mktrypb7)
 *   - Licence back         (file_mktr76g6)
 *   - POA 1 document       (file_mktrf9jv)
 *   - POA 2 document       (file_mktr3fdw)
 *   - DVLA check doc       (file_mktrwhn8)
 *   - Passport image       (file_mktr56t0)
 *   - Signature file       (file_mktrfanc)
 *
 * Each file:
 *   1. Downloaded from Monday via the asset's public_url.
 *   2. Uploaded to R2 under files/drivers/<driver_uuid>/<tag>-<asset_id>.<ext>.
 *   3. Appended to drivers.files JSONB with tag/label/comment so the hire form
 *      app, DriverDetailPage, and snapshot PDF generator can find it.
 *
 * Idempotent: per-driver, the existing drivers.files array is scanned for any
 * entry whose url ends in the same Monday asset_id — matches are skipped. Safe
 * to re-run without duplicating.
 *
 * Per-driver atomicity: if any download or upload fails partway through a
 * driver, R2 uploads already made for that driver ARE deleted (the DB never
 * saw them). Next run will retry cleanly.
 *
 * Usage (from backend/):
 *
 *   # Dry-run — shows plan + file counts, no R2 / DB writes:
 *   npx tsx src/scripts/migrate-monday-driver-files.ts
 *
 *   # Single driver for testing:
 *   npx tsx src/scripts/migrate-monday-driver-files.ts --only-email jon@oooshtours.co.uk --commit
 *
 *   # Full commit:
 *   npx tsx src/scripts/migrate-monday-driver-files.ts --commit
 *
 * Required env: DATABASE_URL, MONDAY_API_TOKEN, R2_* credentials.
 */

import { Pool, PoolClient } from 'pg';
import dotenv from 'dotenv';
import { uploadToR2, deleteFromR2, isR2Configured } from '../config/r2';

dotenv.config();

// ── CLI args ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const onlyEmailIdx = args.indexOf('--only-email');
const ONLY_EMAIL = onlyEmailIdx >= 0 ? args[onlyEmailIdx + 1]?.toLowerCase().trim() : undefined;

// ── Env ──────────────────────────────────────────────────────────────────

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
if (!MONDAY_API_TOKEN) { console.error('Missing MONDAY_API_TOKEN'); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
if (!isR2Configured()) { console.error('R2 not configured (R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY)'); process.exit(1); }

// ── File column map ──────────────────────────────────────────────────────

type FileTag = 'licence-front' | 'licence-back' | 'poa1' | 'poa2' | 'dvla' | 'passport' | 'signature';

const FILE_COLUMNS: { columnId: string; tag: FileTag; label: string }[] = [
  { columnId: 'file_mktrypb7', tag: 'licence-front', label: 'Licence Front' },
  { columnId: 'file_mktr76g6', tag: 'licence-back',  label: 'Licence Back' },
  { columnId: 'file_mktrf9jv', tag: 'poa1',          label: 'POA 1 Document' },
  { columnId: 'file_mktr3fdw', tag: 'poa2',          label: 'POA 2 Document' },
  { columnId: 'file_mktrwhn8', tag: 'dvla',          label: 'DVLA Check' },
  { columnId: 'file_mktr56t0', tag: 'passport',      label: 'Passport' },
  { columnId: 'file_mktrfanc', tag: 'signature',     label: 'Signature' },
];

// ── Monday helpers ───────────────────────────────────────────────────────

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': MONDAY_API_TOKEN!,
      'Content-Type': 'application/json',
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Monday HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json() as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors && body.errors.length > 0) {
    throw new Error('Monday errors: ' + body.errors.map((e) => e.message).join('; '));
  }
  return body.data as T;
}

interface MondayAsset { id: string; name: string; public_url: string; url: string; file_extension: string; file_size: number }
interface MondayItemWithAssets {
  id: string;
  assets: MondayAsset[];
  column_values: Array<{ id: string; value: string | null }>;
}

async function fetchItemWithAssets(itemId: string): Promise<MondayItemWithAssets | null> {
  const colIdList = JSON.stringify(FILE_COLUMNS.map((f) => f.columnId));
  const query = `
    query ($itemId: [ID!]) {
      items(ids: $itemId) {
        id
        assets { id name public_url url file_extension file_size }
        column_values(ids: ${colIdList}) { id value }
      }
    }
  `;
  const data = await mondayQuery<{ items: MondayItemWithAssets[] }>(query, { itemId: [itemId] });
  return data.items[0] || null;
}

/** Extract the Monday asset-id referenced by a given file-column's value JSON.
 *  Monday stores file columns as {"files":[{"assetId":123,"name":"x.jpg",...}]}.
 *  Returns the first asset id (file columns can hold multiple files but we
 *  only migrate the first — Board A uses one file per column). */
function extractAssetId(valueJson: string | null): string | null {
  if (!valueJson) return null;
  try {
    const parsed = JSON.parse(valueJson);
    const files = parsed.files;
    if (Array.isArray(files) && files.length > 0 && files[0].assetId) {
      return String(files[0].assetId);
    }
  } catch {
    // ignore
  }
  return null;
}

// ── DB helpers ───────────────────────────────────────────────────────────

interface Driver {
  id: string;
  email: string | null;
  full_name: string;
  monday_item_id: string;
  files: Array<Record<string, unknown>>;
}

async function loadDrivers(pool: Pool): Promise<Driver[]> {
  let where = `WHERE monday_item_id IS NOT NULL AND is_active = true`;
  const params: unknown[] = [];
  if (ONLY_EMAIL) {
    params.push(ONLY_EMAIL);
    where += ` AND LOWER(email) = $${params.length}`;
  }
  const result = await pool.query(
    `SELECT id, email, full_name, monday_item_id, COALESCE(files, '[]'::jsonb) AS files
     FROM drivers ${where} ORDER BY full_name ASC`,
    params
  );
  return result.rows;
}

function alreadyMigrated(driver: Driver, assetId: string): boolean {
  return driver.files.some((f) => {
    const url = (f.url as string) || '';
    return url.includes(`-${assetId}.`);
  });
}

// ── Download + upload ────────────────────────────────────────────────────

interface StagedFile {
  r2Key: string;
  assetId: string;
  tag: FileTag;
  label: string;
  name: string;
  type: 'image' | 'document';
  contentType: string;
  buffer: Buffer;
}

async function downloadAsset(asset: MondayAsset): Promise<{ buffer: Buffer; contentType: string }> {
  // public_url is pre-authenticated and works without the API token
  const res = await fetch(asset.public_url);
  if (!res.ok) throw new Error(`Asset ${asset.id} download HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || inferContentType(asset.file_extension);
  return { buffer, contentType };
}

function inferContentType(ext: string): string {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    heic: 'image/heic', heif: 'image/heif',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[e] || 'application/octet-stream';
}

function classifyType(ext: string): 'image' | 'document' {
  const e = (ext || '').toLowerCase().replace(/^\./, '');
  return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif'].includes(e) ? 'image' : 'document';
}

// ── Per-driver migration ─────────────────────────────────────────────────

async function migrateDriverFiles(pool: Pool, driver: Driver): Promise<{ added: number; skipped: number; errors: string[] }> {
  let added = 0;
  let skipped = 0;
  const errors: string[] = [];

  const item = await fetchItemWithAssets(driver.monday_item_id);
  if (!item) {
    return { added: 0, skipped: 0, errors: [`Monday item ${driver.monday_item_id} not found`] };
  }

  // Map assetId → asset for quick lookup
  const assetsById = new Map<string, MondayAsset>();
  for (const a of item.assets) assetsById.set(a.id, a);

  // Collect the files we need to migrate (one per column)
  const toMigrate: { columnId: string; tag: FileTag; label: string; asset: MondayAsset }[] = [];
  for (const col of FILE_COLUMNS) {
    const colValue = item.column_values.find((c) => c.id === col.columnId);
    if (!colValue) continue;
    const assetId = extractAssetId(colValue.value);
    if (!assetId) continue;

    if (alreadyMigrated(driver, assetId)) {
      skipped++;
      continue;
    }

    const asset = assetsById.get(assetId);
    if (!asset) {
      errors.push(`${col.tag}: asset ${assetId} referenced by column but not in item.assets`);
      continue;
    }
    toMigrate.push({ ...col, asset });
  }

  if (toMigrate.length === 0) {
    return { added: 0, skipped, errors };
  }

  if (!COMMIT) {
    // Dry-run: just count
    return { added: toMigrate.length, skipped, errors };
  }

  // Download + stage all files first — if any download fails, we abort
  // without having written to R2.
  const staged: StagedFile[] = [];
  try {
    for (const m of toMigrate) {
      const { buffer, contentType } = await downloadAsset(m.asset);
      const ext = m.asset.file_extension ? `.${m.asset.file_extension}` : '';
      const r2Key = `files/drivers/${driver.id}/${m.tag}-${m.asset.id}${ext}`;
      staged.push({
        r2Key,
        assetId: m.asset.id,
        tag: m.tag,
        label: m.label,
        name: m.asset.name,
        type: classifyType(m.asset.file_extension),
        contentType,
        buffer,
      });
      // Small delay between downloads to stay well under Monday's CDN limits
      await sleep(150);
    }
  } catch (err) {
    return { added: 0, skipped, errors: [...errors, `download: ${(err as Error).message}`] };
  }

  // Upload to R2 — if any upload fails, delete the ones that succeeded for
  // this driver so the DB never sees partial state.
  const uploaded: string[] = [];
  try {
    for (const s of staged) {
      await uploadToR2(s.r2Key, s.buffer, s.contentType);
      uploaded.push(s.r2Key);
    }
  } catch (err) {
    console.warn(`[${driver.full_name}] R2 upload failed, rolling back ${uploaded.length} uploads`);
    for (const k of uploaded) {
      await deleteFromR2(k).catch((cleanupErr) => console.warn(`  rollback failed for ${k}: ${(cleanupErr as Error).message}`));
    }
    return { added: 0, skipped, errors: [...errors, `upload: ${(err as Error).message}`] };
  }

  // Append to drivers.files JSONB in a single transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileAttachments = staged.map((s) => ({
      name: s.name,
      url: s.r2Key,
      type: s.type,
      tag: s.tag,
      label: s.label,
      comment: 'Migrated from Monday.com',
      uploaded_at: new Date().toISOString(),
      uploaded_by: 'monday_migration',
    }));
    await client.query(
      `UPDATE drivers SET files = COALESCE(files, '[]'::jsonb) || $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(fileAttachments), driver.id]
    );
    await client.query('COMMIT');
    added = fileAttachments.length;
  } catch (err) {
    await client.query('ROLLBACK');
    // DB write failed — roll back R2 too so we don't leak orphan objects
    console.warn(`[${driver.full_name}] DB write failed, rolling back R2 uploads`);
    for (const k of uploaded) {
      await deleteFromR2(k).catch(() => { /* best effort */ });
    }
    return { added: 0, skipped, errors: [...errors, `db: ${(err as Error).message}`] };
  } finally {
    client.release();
  }

  return { added, skipped, errors };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`migrate-monday-driver-files`);
  console.log(`  mode       = ${COMMIT ? 'COMMIT' : 'DRY-RUN'}`);
  if (ONLY_EMAIL) console.log(`  only-email = ${ONLY_EMAIL}`);
  console.log('');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const drivers = await loadDrivers(pool);
    console.log(`Loaded ${drivers.length} drivers with monday_item_id.\n`);

    let totalAdded = 0;
    let totalSkipped = 0;
    let errorCount = 0;
    const errorSamples: string[] = [];

    for (let i = 0; i < drivers.length; i++) {
      const d = drivers[i];
      const { added, skipped, errors } = await migrateDriverFiles(pool, d);
      totalAdded += added;
      totalSkipped += skipped;
      if (errors.length > 0) {
        errorCount++;
        for (const e of errors) {
          errorSamples.push(`${d.full_name} <${d.email}>: ${e}`);
        }
      }
      if (added > 0 || errors.length > 0) {
        const tag = COMMIT ? 'added' : 'would add';
        console.log(`  [${i + 1}/${drivers.length}] ${d.full_name} — ${tag} ${added}, skipped ${skipped}${errors.length ? `, errors ${errors.length}` : ''}`);
      }
      // Throttle per-driver to stay polite to Monday
      await sleep(200);
    }

    console.log('\n=== SUMMARY ===');
    console.log(`  Drivers processed:        ${drivers.length}`);
    console.log(`  Files ${COMMIT ? 'added' : 'would be added'}:  ${totalAdded}`);
    console.log(`  Files already migrated:   ${totalSkipped}`);
    console.log(`  Drivers with errors:      ${errorCount}`);
    if (errorSamples.length > 0) {
      console.log('\n  First 20 errors:');
      for (const s of errorSamples.slice(0, 20)) console.log(`    - ${s}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
