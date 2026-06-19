/**
 * Monday.com → OP migration for PCN records (PCN Tracker board 18390180140).
 *
 * Re-homes the standalone PCN-Management-System Netlify app's tracker board
 * into the OP `pcns` module. One pass, modelled on migrate-monday-drivers.ts +
 * migrate-monday-driver-files.ts:
 *
 *   1. Paginates the PCN Tracker board, reading each item's column_values + assets.
 *   2. Maps columns → pcns scalar fields (see PCN_COLUMNS below — column IDs
 *      lifted verbatim from the legacy create-pcn.js).
 *   3. Downloads the attached notice scan(s) from the file column via the
 *      asset's public_url, uploads to R2 under
 *      files/pcn-documents/<pcn_uuid>/notice-<assetId>.<ext>, and appends to the
 *      pcns.documents JSONB (kind notice_front / notice_back / other).
 *   4. Best-effort anchoring: vehicle (reg parsed from the notice filename),
 *      driver (board-relation linked pulse → drivers.monday_item_id), job
 *      (JOB_NUMBER text → jobs.hh_job_number).
 *
 * EMAIL-SILENT: writes straight to the DB (pcns + pcn_events). Never touches the
 * action endpoints, so no client emails fire. Historical deadlines are in the
 * past, so the Step 6 nudge scheduler (info@-only anyway) won't chase them.
 *
 * IDEMPOTENT: upsert on `reference`. Re-running fills NULL gaps on existing rows
 * (never clobbers OP edits) and skips documents whose Monday asset-id is already
 * present in the documents array (unless --force). Provenance (monday_item_id)
 * is recorded in the `created` pcn_event metadata.
 *
 * Usage:
 *   npx tsx src/scripts/migrate-monday-pcns.ts                 # dry-run
 *   npx tsx src/scripts/migrate-monday-pcns.ts --commit        # write
 *   npx tsx src/scripts/migrate-monday-pcns.ts --only PCN12345 # single ref
 *   npx tsx src/scripts/migrate-monday-pcns.ts --commit --force # re-import docs
 *
 * Env: MONDAY_API_TOKEN, DATABASE_URL, R2 vars.
 */

import { Pool } from 'pg';
import { uploadToR2, isR2Configured } from '../config/r2';

const PCN_TRACKER_BOARD_ID = '18390180140';
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

// Column IDs — verbatim from the legacy create-pcn.js (SPECIFICATION.md).
const PCN_COLUMNS = {
  VEHICLE_LINK:      'board_relation_mky4gd3j',
  DRIVER_LINK:       'board_relation_mky4ptk1',
  OFFENCE_DATE:      'date_mky4phxq',
  OFFENCE_TIME:      'text_mky7ek48',
  JOB_NUMBER:        'text_mky7jz1h',
  LOCATION:          'text_mky490b1',
  ISSUING_AUTHORITY: 'text_mky4shpc',
  FINE_AMOUNT:       'numeric_mky42rn1',
  REDUCED_AMOUNT:    'numeric_mky47er4',
  REDUCED_DEADLINE:  'date_mky4z02g',
  FINAL_DEADLINE:    'date_mky4st2',
  FINE_TYPE:         'color_mky4v9hp',
  STATUS:            'color_mky414ks',
  ACTION_TAKEN:      'color_mky4ye61',
  HANDLING_CHARGED:  'color_mky4j3my',
  HANDLING_AMOUNT:   'numeric_mky4babt',
  NOTES:             'long_text_mky46x5a',
  PCN_DOCUMENT:      'file_mky4zm3r',
};

// ── Label → OP enum maps ──────────────────────────────────────────────────
// fine_type: 'private_pcn' | 'council_pcn' | 'police_nip' | 'toll' | 'other'
const FINE_TYPE_MAP: Record<string, string> = {
  'pcn': 'private_pcn',
  'private pcn': 'private_pcn',
  'council pcn': 'council_pcn',
  'police nip': 'police_nip',
  'toll': 'toll',
  'other': 'other',
};

// status: matches the pcns.status CHECK enum (migration 130)
const STATUS_MAP: Record<string, string> = {
  'received': 'received',
  'awaiting driver id': 'awaiting_driver_id',
  'awaiting driver': 'awaiting_driver_id',
  'driver notified': 'driver_notified_pay',
  'driver notified - pay': 'driver_notified_pay',
  'paid by driver': 'paid_by_driver',
  'liability transferred': 'liability_transferred',
  'paid & recharged': 'paid_recharged',
  'paid and recharged': 'paid_recharged',
  'internal (ooosh)': 'internal_ooosh',
  'internal (freelancer)': 'internal_freelancer',
  'under query': 'under_query',
  'closed': 'closed',
  'resolved': 'closed',
  'complete': 'closed',
  'completed': 'closed',
};

// action_path: 'pay_direct'|'transfer_liability'|'pay_recharge'|'internal_ooosh'|'internal_freelancer'|'query'
const ACTION_MAP: Record<string, string> = {
  'transfer liability': 'transfer_liability',
  'pay & recharge': 'pay_recharge',
  'pay and recharge': 'pay_recharge',
  'pay direct': 'pay_direct',
  'internal': 'internal_ooosh',
  'query': 'query',
};

// ── CLI args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const FORCE = args.includes('--force');
const onlyIdx = args.indexOf('--only');
const ONLY_REF = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

// Collectors for transparency on unmapped labels.
const unmappedStatus = new Set<string>();
const unmappedType = new Set<string>();
const unmappedAction = new Set<string>();

// ── Monday API ────────────────────────────────────────────────────────────
interface MondayColumn { id: string; text: string | null; value: string | null }
interface MondayAsset { id: string; name: string; public_url: string; url: string; file_extension: string; file_size: number }
interface MondayItem { id: string; name: string; column_values: MondayColumn[]; assets: MondayAsset[] }

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Authorization': MONDAY_API_TOKEN!,
      'Content-Type': 'application/json',
      'API-Version': '2025-04',
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

interface ItemsPageResponse {
  boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }>;
}

async function fetchAllItems(): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    const query = `
      query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              assets { id name public_url url file_extension file_size }
              column_values { id text value }
            }
          }
        }
      }
    `;
    const data: ItemsPageResponse = await mondayQuery<ItemsPageResponse>(query, {
      boardId: PCN_TRACKER_BOARD_ID, cursor,
    });
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

// ── Column value helpers ──────────────────────────────────────────────────
function col(item: MondayItem, id: string): MondayColumn | undefined {
  return item.column_values.find((c) => c.id === id);
}
function txt(item: MondayItem, id: string): string | null {
  const c = col(item, id);
  const t = c?.text?.trim();
  return t ? t : null;
}
function num(item: MondayItem, id: string): number | null {
  const t = txt(item, id);
  if (t == null) return null;
  const n = Number(t.replace(/[£,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
/** Date column → 'YYYY-MM-DD' (from value JSON {date} or the text fallback). */
function dateStr(item: MondayItem, id: string): string | null {
  const c = col(item, id);
  if (c?.value) {
    try { const p = JSON.parse(c.value); if (p?.date) return p.date as string; } catch { /* */ }
  }
  const t = c?.text?.trim();
  return t ? t : null;
}
/** long_text column → content (value.text per Monday's storage, text fallback). */
function longText(item: MondayItem, id: string): string | null {
  const c = col(item, id);
  if (c?.value) {
    try { const p = JSON.parse(c.value); if (p?.text) return String(p.text); } catch { /* */ }
  }
  const t = c?.text?.trim();
  return t ? t : null;
}
/** board_relation → linked pulse ids. */
function linkedIds(item: MondayItem, id: string): number[] {
  const c = col(item, id);
  if (!c?.value) return [];
  try {
    const p = JSON.parse(c.value);
    const lp = p.linkedPulseIds || p.linked_pulse_ids;
    if (Array.isArray(lp)) return lp.map((x: any) => Number(x.linkedPulseId ?? x.linked_pulse_id ?? x)).filter(Number.isFinite);
    if (Array.isArray(p.item_ids)) return p.item_ids.map(Number).filter(Number.isFinite);
  } catch { /* */ }
  return [];
}
/** file column → [{assetId, name}]. */
function fileAssetIds(item: MondayItem, id: string): Array<{ assetId: string; name?: string }> {
  const c = col(item, id);
  if (!c?.value) return [];
  try {
    const p = JSON.parse(c.value);
    if (Array.isArray(p.files)) {
      return p.files
        .filter((f: any) => f.assetId != null)
        .map((f: any) => ({ assetId: String(f.assetId), name: f.name }));
    }
  } catch { /* */ }
  return [];
}

function mapLabel(label: string | null, map: Record<string, string>, fallback: string, unmapped: Set<string>): string {
  if (!label) return fallback;
  const key = label.toLowerCase().trim();
  if (map[key]) return map[key];
  unmapped.add(label);
  return fallback;
}

function inferContentType(ext: string): string {
  const e = (ext || '').toLowerCase();
  if (e === 'pdf') return 'application/pdf';
  if (e === 'png') return 'image/png';
  if (e === 'gif') return 'image/gif';
  if (e === 'webp') return 'image/webp';
  return 'image/jpeg';
}

/** Parse the vehicle reg from a notice filename of the legacy form
 *  `<REG>-<REFERENCE>-PCN.ext` (create-pcn.js generates exactly this). */
function regFromFilename(name: string | undefined, reference: string | null): string | null {
  if (!name) return null;
  const base = name.replace(/\.[^.]+$/, '');
  // Strip the known suffix and the reference, leaving the reg.
  let s = base.replace(/-PCN$/i, '');
  if (reference) s = s.replace(new RegExp('-' + reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), '');
  // Reg is the leading token before the first '-' if multiple remain.
  const head = s.split('-')[0]?.trim();
  if (head && /^[A-Za-z0-9 ]{4,10}$/.test(head)) return head.toUpperCase();
  return null;
}

const normReg = (s: string) => s.toUpperCase().replace(/\s+/g, '');

// ── DB resolution helpers ─────────────────────────────────────────────────
async function resolveVehicleId(pool: Pool, reg: string | null): Promise<string | null> {
  if (!reg) return null;
  const r = await pool.query(
    `SELECT id FROM fleet_vehicles WHERE REPLACE(UPPER(reg), ' ', '') = $1 LIMIT 1`,
    [normReg(reg)]
  );
  return r.rows[0]?.id ?? null;
}
async function resolveJobByHh(pool: Pool, hh: number | null): Promise<string | null> {
  if (hh == null) return null;
  const r = await pool.query(`SELECT id FROM jobs WHERE hh_job_number = $1 LIMIT 1`, [hh]);
  return r.rows[0]?.id ?? null;
}
async function resolveDriverByMonday(pool: Pool, mondayPulseId: number | null): Promise<string | null> {
  if (mondayPulseId == null) return null;
  const r = await pool.query(
    `SELECT id FROM drivers WHERE monday_item_id = $1 LIMIT 1`,
    [String(mondayPulseId)]
  );
  return r.rows[0]?.id ?? null;
}

interface ParsedPcn {
  reference: string | null;
  fine_type: string;
  status: string;
  action_path: string | null;
  vehicle_reg: string | null;
  hh_job_number: number | null;
  offence_at: string | null;
  offence_time_text: string | null;
  location: string | null;
  issuing_authority: string | null;
  fine_amount: number | null;
  reduced_amount: number | null;
  reduced_deadline: string | null;
  final_deadline: string | null;
  handling_charge_applied: boolean;
  handling_amount: number | null;
  notes: string | null;
}

function parseItem(item: MondayItem): { p: ParsedPcn; docs: Array<{ assetId: string; name?: string }>; driverPulse: number | null } {
  const reference = item.name?.trim() || null;

  const offenceDate = dateStr(item, PCN_COLUMNS.OFFENCE_DATE);
  const offenceTime = txt(item, PCN_COLUMNS.OFFENCE_TIME);
  let offence_at: string | null = null;
  if (offenceDate) {
    const time = offenceTime && /^\d{1,2}:\d{2}/.test(offenceTime) ? offenceTime : '00:00';
    offence_at = `${offenceDate}T${time.length === 4 ? '0' + time : time}:00`;
  }

  const handlingLabel = (txt(item, PCN_COLUMNS.HANDLING_CHARGED) || '').toLowerCase();
  const handling_charge_applied = handlingLabel === 'yes' || handlingLabel === 'reduced';

  const docs = fileAssetIds(item, PCN_COLUMNS.PCN_DOCUMENT);
  const vehicle_reg = regFromFilename(docs[0]?.name, reference);

  const jobNumStr = txt(item, PCN_COLUMNS.JOB_NUMBER);
  const hh_job_number = jobNumStr ? (Number(jobNumStr.replace(/\D/g, '')) || null) : null;

  const driverPulse = linkedIds(item, PCN_COLUMNS.DRIVER_LINK)[0] ?? null;

  return {
    p: {
      reference,
      fine_type: mapLabel(txt(item, PCN_COLUMNS.FINE_TYPE), FINE_TYPE_MAP, 'other', unmappedType),
      status: mapLabel(txt(item, PCN_COLUMNS.STATUS), STATUS_MAP, 'received', unmappedStatus),
      action_path: txt(item, PCN_COLUMNS.ACTION_TAKEN)
        ? mapLabel(txt(item, PCN_COLUMNS.ACTION_TAKEN), ACTION_MAP, '', unmappedAction) || null
        : null,
      vehicle_reg,
      hh_job_number,
      offence_at,
      offence_time_text: offenceTime,
      location: txt(item, PCN_COLUMNS.LOCATION),
      issuing_authority: txt(item, PCN_COLUMNS.ISSUING_AUTHORITY),
      fine_amount: num(item, PCN_COLUMNS.FINE_AMOUNT),
      reduced_amount: num(item, PCN_COLUMNS.REDUCED_AMOUNT),
      reduced_deadline: dateStr(item, PCN_COLUMNS.REDUCED_DEADLINE),
      final_deadline: dateStr(item, PCN_COLUMNS.FINAL_DEADLINE),
      handling_charge_applied,
      handling_amount: num(item, PCN_COLUMNS.HANDLING_AMOUNT),
      notes: longText(item, PCN_COLUMNS.NOTES),
    },
    docs,
    driverPulse,
  };
}

// ── Document import (download → R2 → documents JSONB) ──────────────────────
async function importDocuments(
  pool: Pool,
  pcnId: string,
  item: MondayItem,
  docs: Array<{ assetId: string; name?: string }>,
): Promise<number> {
  if (docs.length === 0) return 0;

  // Existing doc asset-ids (parsed from r2_key `notice-<assetId>.ext`).
  const existing = await pool.query(`SELECT documents FROM pcns WHERE id = $1`, [pcnId]);
  const existingKeys: string[] = (existing.rows[0]?.documents || [])
    .map((d: any) => String(d.r2_key || ''));

  const newEntries: any[] = [];
  let i = 0;
  for (const d of docs) {
    const alreadyHave = existingKeys.some((k) => k.includes(`-${d.assetId}.`) || k.includes(`-${d.assetId}`));
    if (alreadyHave && !FORCE) { i++; continue; }

    const asset = item.assets.find((a) => String(a.id) === String(d.assetId));
    if (!asset) { i++; continue; }

    const kind = i === 0 ? 'notice_front' : (i === 1 ? 'notice_back' : 'other');
    const ext = asset.file_extension ? `.${asset.file_extension}` : '';
    const r2Key = `files/pcn-documents/${pcnId}/notice-${d.assetId}${ext}`;

    if (COMMIT) {
      const res = await fetch(asset.public_url);
      if (!res.ok) { console.warn(`    ! asset ${d.assetId} download HTTP ${res.status}`); i++; continue; }
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get('content-type') || inferContentType(asset.file_extension);
      await uploadToR2(r2Key, buffer, contentType);
    }

    newEntries.push({
      r2_key: r2Key,
      name: asset.name || d.name || null,
      kind,
      comment: null,
      uploaded_at: new Date().toISOString(),
      uploaded_by: SYSTEM_USER_ID,
    });
    i++;
  }

  if (newEntries.length > 0 && COMMIT) {
    await pool.query(
      `UPDATE pcns SET documents = COALESCE(documents, '[]'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [pcnId, JSON.stringify(newEntries)]
    );
    // Mirror the legacy single-pointer for the front notice (read path merges it).
    const front = newEntries.find((e) => e.kind === 'notice_front');
    if (front) {
      await pool.query(
        `UPDATE pcns SET pcn_document_url = COALESCE(pcn_document_url, $2) WHERE id = $1`,
        [pcnId, front.r2_key]
      );
    }
    for (const e of newEntries) {
      await pool.query(
        `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
         VALUES ($1, 'document_added', $2, $3, $4)`,
        [pcnId, `Document imported (${e.kind.replace(/_/g, ' ')})`, JSON.stringify({ r2_key: e.r2_key, source: 'monday' }), SYSTEM_USER_ID]
      );
    }
  }
  return newEntries.length;
}

// ── Per-item upsert ───────────────────────────────────────────────────────
const stats = { inserted: 0, updated: 0, skipped: 0, docs: 0, noRef: 0 };

async function processItem(pool: Pool, item: MondayItem): Promise<void> {
  const { p, docs, driverPulse } = parseItem(item);

  if (!p.reference) {
    stats.noRef++;
    console.warn(`  ! item ${item.id} has no reference (name) — skipped`);
    return;
  }
  if (ONLY_REF && p.reference !== ONLY_REF) return;

  const [vehicle_id, job_id, driver_id] = await Promise.all([
    resolveVehicleId(pool, p.vehicle_reg),
    resolveJobByHh(pool, p.hh_job_number),
    resolveDriverByMonday(pool, driverPulse),
  ]);

  const existing = await pool.query(
    `SELECT id FROM pcns WHERE reference = $1 AND is_deleted = false LIMIT 1`,
    [p.reference]
  );

  const anchors = [vehicle_id ? 'vehicle' : null, job_id ? 'job' : null, driver_id ? 'driver' : null].filter(Boolean).join('/') || 'unmatched';

  if (existing.rows.length > 0) {
    const pcnId = existing.rows[0].id;
    console.log(`  ~ ${p.reference}  [exists] status=${p.status} ${anchors}`);
    if (COMMIT) {
      // Fill NULL gaps only — never clobber OP edits.
      await pool.query(
        `UPDATE pcns SET
           fine_type             = COALESCE(fine_type, $2),
           vehicle_id            = COALESCE(vehicle_id, $3),
           driver_id             = COALESCE(driver_id, $4),
           job_id                = COALESCE(job_id, $5),
           hh_job_number         = COALESCE(hh_job_number, $6),
           vehicle_reg           = COALESCE(vehicle_reg, $7),
           offence_at            = COALESCE(offence_at, $8::timestamptz),
           offence_time_text     = COALESCE(offence_time_text, $9),
           location              = COALESCE(location, $10),
           issuing_authority     = COALESCE(issuing_authority, $11),
           fine_amount           = COALESCE(fine_amount, $12),
           reduced_amount        = COALESCE(reduced_amount, $13),
           reduced_deadline      = COALESCE(reduced_deadline, $14::date),
           final_deadline        = COALESCE(final_deadline, $15::date),
           handling_amount       = COALESCE(handling_amount, $16),
           notes                 = COALESCE(notes, $17),
           updated_at            = NOW()
         WHERE id = $1`,
        [pcnId, p.fine_type, vehicle_id, driver_id, job_id, p.hh_job_number, p.vehicle_reg,
         p.offence_at, p.offence_time_text, p.location, p.issuing_authority, p.fine_amount,
         p.reduced_amount, p.reduced_deadline, p.final_deadline, p.handling_amount, p.notes]
      );
    }
    const n = await importDocuments(pool, pcnId, item, docs);
    stats.docs += n;
    stats.updated++;
    return;
  }

  // INSERT new
  console.log(`  + ${p.reference}  status=${p.status} type=${p.fine_type} ${anchors}${p.vehicle_reg ? ` reg=${p.vehicle_reg}` : ''}${p.hh_job_number ? ` hh=${p.hh_job_number}` : ''} docs=${docs.length}`);
  stats.inserted++;
  if (!COMMIT) { stats.docs += docs.length; return; }

  const ins = await pool.query(
    `INSERT INTO pcns (
       reference, fine_type, status, action_path,
       vehicle_id, driver_id, job_id, client_organisation_id, hh_job_number, vehicle_reg,
       offence_at, offence_time_text, location, issuing_authority,
       fine_amount, reduced_amount, reduced_deadline, final_deadline,
       handling_charge_applied, handling_amount, notes
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8, $9, $10,
       $11::timestamptz, $12, $13, $14,
       $15, $16, $17::date, $18::date,
       $19, $20, $21
     ) RETURNING id`,
    [p.reference, p.fine_type, p.status, p.action_path,
     vehicle_id, driver_id, job_id, null, p.hh_job_number, p.vehicle_reg,
     p.offence_at, p.offence_time_text, p.location, p.issuing_authority,
     p.fine_amount, p.reduced_amount, p.reduced_deadline, p.final_deadline,
     p.handling_charge_applied, p.handling_amount, p.notes]
  );
  const pcnId = ins.rows[0].id;

  await pool.query(
    `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
     VALUES ($1, 'created', $2, $3, $4)`,
    [pcnId, 'Imported from Monday PCN Tracker',
     JSON.stringify({ source: 'monday', monday_item_id: item.id, anchors }), SYSTEM_USER_ID]
  );

  const n = await importDocuments(pool, pcnId, item, docs);
  stats.docs += n;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!MONDAY_API_TOKEN) { console.error('MONDAY_API_TOKEN not set'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
  if (COMMIT && !isR2Configured()) { console.error('R2 not configured — needed to import document scans'); process.exit(1); }

  console.log(`\nMonday PCN Tracker → OP  ${COMMIT ? '*** COMMIT ***' : '(dry-run)'}${ONLY_REF ? `  only=${ONLY_REF}` : ''}${FORCE ? '  --force' : ''}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    console.log('Fetching board items…');
    const items = await fetchAllItems();
    console.log(`  ${items.length} items on the board\n`);

    for (const item of items) {
      try {
        await processItem(pool, item);
      } catch (err) {
        console.error(`  ! item ${item.id} (${item.name}) failed:`, (err as Error).message);
      }
    }

    console.log('\n── Summary ──');
    console.log(`  inserted: ${stats.inserted}`);
    console.log(`  updated:  ${stats.updated}`);
    console.log(`  no ref:   ${stats.noRef}`);
    console.log(`  documents ${COMMIT ? 'imported' : 'to import'}: ${stats.docs}`);

    if (unmappedStatus.size) console.log(`\n  ⚠ Unmapped STATUS labels (defaulted to 'received'): ${[...unmappedStatus].join(', ')}`);
    if (unmappedType.size)   console.log(`  ⚠ Unmapped FINE TYPE labels (defaulted to 'other'): ${[...unmappedType].join(', ')}`);
    if (unmappedAction.size) console.log(`  ⚠ Unmapped ACTION labels (defaulted to null): ${[...unmappedAction].join(', ')}`);
    if (unmappedStatus.size || unmappedType.size || unmappedAction.size) {
      console.log('  → Send me the right enum for these and I\'ll extend the maps before the final commit run.');
    }

    if (!COMMIT) console.log('\nDry-run only. Re-run with --commit to write.\n');
    else console.log('\nDone.\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
