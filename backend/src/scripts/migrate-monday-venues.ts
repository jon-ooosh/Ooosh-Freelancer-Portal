/**
 * Monday.com → OP migration for the Venues board.
 *
 * Pulls every item from `MONDAY_BOARD_ID_VENUES`, upserts into OP's
 * `venues` table, and records the Monday item id in `external_id_map`
 * so the D&C migration's venue lookups start succeeding.
 *
 * Matching (to avoid duplicating venues already synced from HireHop):
 *   1. Check external_id_map for (entity_type=venues, external_system=monday,
 *      external_id=<monday item id>) → if mapped, update.
 *   2. Else case-insensitive match on trimmed `name`. If found → link + update.
 *   3. Else create new venue.
 *
 * Contacts on Monday (Contact 1/2, Phone 1/2, Email) are NOT promoted into
 * linked people rows — that's a bigger piece of work. They're stashed into
 * `general_notes` as a labelled migration block so the data isn't lost and
 * staff can move them into proper person records later.
 *
 * Monday files (floor plans, venue photos) are NOT migrated — Monday's
 * asset system needs careful handling and venues board has limited file
 * use. Flagged as future work.
 *
 * Distance / Drive Time / Tolls: needs Monday column IDs — these aren't in
 * the VENUE_COLUMNS constant in src/lib/monday.ts. The script dumps the
 * full column list on start so the user can identify them; a second pass
 * with the IDs wired up will populate `default_miles_from_base`,
 * `default_drive_time_mins`, and `default_tolls_amount`.
 *
 * Usage (dry-run — default):
 *   cd backend
 *   npx tsx src/scripts/migrate-monday-venues.ts
 *
 * To actually write:
 *   npx tsx src/scripts/migrate-monday-venues.ts --commit
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ── CLI ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');

// ── Env ──────────────────────────────────────────────────────────────

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const VENUES_BOARD_ID = process.env.MONDAY_BOARD_ID_VENUES;

if (!MONDAY_API_TOKEN) {
  console.error('Missing MONDAY_API_TOKEN');
  process.exit(1);
}
if (!VENUES_BOARD_ID) {
  console.error('Missing MONDAY_BOARD_ID_VENUES');
  process.exit(1);
}

// ── Known column IDs (from src/lib/monday.ts VENUE_COLUMNS) ─────────

const COLS = {
  address: 'long_text',
  whatThreeWords: 'text3',
  contact1: 'text',
  contact2: 'text4',
  phone: 'phone',
  phone2: 'phone_mkznt3rr',
  email: 'email',
  accessNotes: 'long_text9',
  stageNotes: 'long_text7',
  // Quoting defaults (confirmed from the first dry-run column dump)
  distance: 'numeric_mm07y9eq',   // Distance (miles, one-way)
  driveTime: 'numeric_mm074a1k',  // Drive Time (minutes, one-way)
  tolls: 'numeric_mm07cvgv',      // Tolls / Parking / Crossings (£)
} as const;

// ── Monday GraphQL ───────────────────────────────────────────────────

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
  if (body.errors?.length) throw new Error('Monday errors: ' + body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

interface MondayColumnValue { id: string; text: string | null; value: string | null }
interface MondayItem {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
}
interface MondayColumnDef { id: string; title: string; type: string }

/** Dump all columns on the venues board — diagnostic so we can identify
 *  Distance / Drive Time / Tolls IDs without hunting them down manually. */
async function dumpBoardColumns(boardId: string): Promise<void> {
  interface Result {
    boards: Array<{ columns: MondayColumnDef[] }>;
  }
  const data: Result = await mondayQuery<Result>(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type }
      }
    }
  `, { boardId });
  const cols = data.boards?.[0]?.columns || [];
  console.log(`Venues board has ${cols.length} columns:`);
  for (const c of cols) {
    console.log(`  ${c.id.padEnd(30)} | ${c.type.padEnd(15)} | ${c.title}`);
  }
}

async function fetchAllItems(boardId: string): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    interface Result {
      boards: Array<{
        items_page: {
          cursor: string | null;
          items: MondayItem[];
        };
      }>;
    }
    const data: Result = await mondayQuery<Result>(`
      query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              column_values {
                id
                text
                value
              }
            }
          }
        }
      }
    `, { boardId, cursor });
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

function cvText(item: MondayItem, columnId: string): string {
  if (!columnId) return '';
  return item.column_values.find((c) => c.id === columnId)?.text?.trim() || '';
}

function cvNumber(item: MondayItem, columnId: string): number | null {
  const t = cvText(item, columnId);
  if (!t) return null;
  const n = Number(t.replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ── DB ───────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function findVenueByMondayId(mondayId: string): Promise<string | null> {
  const r = await pool.query(
    `SELECT entity_id FROM external_id_map
     WHERE external_system = 'monday' AND entity_type = 'venues' AND external_id = $1
     LIMIT 1`,
    [mondayId]
  );
  return r.rows[0]?.entity_id || null;
}

async function findVenueByName(name: string): Promise<string | null> {
  if (!name.trim()) return null;
  const r = await pool.query(
    `SELECT id FROM venues
     WHERE LOWER(TRIM(name)) = LOWER(TRIM($1))
     LIMIT 1`,
    [name]
  );
  return r.rows[0]?.id || null;
}

async function recordExternalId(opVenueId: string, mondayId: string): Promise<void> {
  await pool.query(
    `INSERT INTO external_id_map (entity_type, entity_id, external_system, external_id)
     VALUES ('venues', $1, 'monday', $2)
     ON CONFLICT DO NOTHING`,
    [opVenueId, mondayId]
  );
}

// ── Contacts-in-notes block ──────────────────────────────────────────

function buildContactsBlock(item: MondayItem): string {
  const c1 = cvText(item, COLS.contact1);
  const p1 = cvText(item, COLS.phone);
  const c2 = cvText(item, COLS.contact2);
  const p2 = cvText(item, COLS.phone2);
  const email = cvText(item, COLS.email);

  const bits: string[] = [];
  if (c1 || p1) bits.push(`Contact 1: ${c1 || '(no name)'}${p1 ? ` — ${p1}` : ''}`);
  if (c2 || p2) bits.push(`Contact 2: ${c2 || '(no name)'}${p2 ? ` — ${p2}` : ''}`);
  if (email) bits.push(`Email: ${email}`);

  if (bits.length === 0) return '';

  const today = new Date().toISOString().slice(0, 10);
  return [
    '',
    '---',
    `Migrated contacts (from Monday ${today}):`,
    ...bits,
    '---',
  ].join('\n');
}

/** Append the contacts block to existing notes, unless it's already there. */
function appendContactsBlock(existing: string | null, block: string): string | null {
  if (!block) return existing;
  if (existing && existing.includes('Migrated contacts (from Monday')) {
    // Already stamped — leave alone rather than appending duplicate blocks.
    return existing;
  }
  return (existing || '') + block;
}

// ── Upsert ───────────────────────────────────────────────────────────

type UpsertResult = { status: 'created' | 'updated' | 'linked' | 'skipped'; venueId: string | null; reason?: string };

async function upsertVenue(item: MondayItem): Promise<UpsertResult> {
  const name = item.name.trim();
  if (!name) return { status: 'skipped', venueId: null, reason: 'blank name' };

  const address = cvText(item, COLS.address) || null;
  const w3w = cvText(item, COLS.whatThreeWords) || null;
  const accessNotes = cvText(item, COLS.accessNotes) || null;
  const stageNotes = cvText(item, COLS.stageNotes) || null;
  const distance = cvNumber(item, COLS.distance);
  const driveTime = cvNumber(item, COLS.driveTime);
  const tolls = cvNumber(item, COLS.tolls);
  const contactsBlock = buildContactsBlock(item);

  // Already mapped?
  const mappedId = await findVenueByMondayId(item.id);
  if (mappedId) {
    if (!COMMIT) return { status: 'updated', venueId: mappedId, reason: 'would update (already linked)' };
    // Fetch current notes so we don't append the contacts block twice
    const cur = await pool.query(`SELECT general_notes FROM venues WHERE id = $1`, [mappedId]);
    const curNotes: string | null = cur.rows[0]?.general_notes ?? null;
    const newNotes = appendContactsBlock(curNotes, contactsBlock);

    await pool.query(
      `UPDATE venues SET
         address = COALESCE($2, address),
         w3w_address = COALESCE($3, w3w_address),
         approach_notes = COALESCE($4, approach_notes),
         technical_notes = COALESCE($5, technical_notes),
         default_miles_from_base = COALESCE($6, default_miles_from_base),
         default_drive_time_mins = COALESCE($7, default_drive_time_mins),
         default_tolls_amount = COALESCE($8, default_tolls_amount),
         general_notes = $9,
         updated_at = NOW()
       WHERE id = $1`,
      [mappedId, address, w3w, accessNotes, stageNotes, distance, driveTime !== null ? Math.round(driveTime) : null, tolls, newNotes]
    );
    return { status: 'updated', venueId: mappedId };
  }

  // Try name match
  const byName = await findVenueByName(name);
  if (byName) {
    if (!COMMIT) return { status: 'linked', venueId: byName, reason: 'would link to existing (name match)' };
    const cur = await pool.query(`SELECT general_notes FROM venues WHERE id = $1`, [byName]);
    const curNotes: string | null = cur.rows[0]?.general_notes ?? null;
    const newNotes = appendContactsBlock(curNotes, contactsBlock);
    await pool.query(
      `UPDATE venues SET
         address = COALESCE(address, $2),
         w3w_address = COALESCE(w3w_address, $3),
         approach_notes = COALESCE(approach_notes, $4),
         technical_notes = COALESCE(technical_notes, $5),
         default_miles_from_base = COALESCE(default_miles_from_base, $6),
         default_drive_time_mins = COALESCE(default_drive_time_mins, $7),
         default_tolls_amount = COALESCE(default_tolls_amount, $8),
         general_notes = $9,
         updated_at = NOW()
       WHERE id = $1`,
      [byName, address, w3w, accessNotes, stageNotes, distance, driveTime !== null ? Math.round(driveTime) : null, tolls, newNotes]
    );
    await recordExternalId(byName, item.id);
    return { status: 'linked', venueId: byName };
  }

  // Create new
  if (!COMMIT) return { status: 'created', venueId: null, reason: 'would create' };

  const newNotes = contactsBlock ? appendContactsBlock(null, contactsBlock) : null;
  const ins = await pool.query(
    `INSERT INTO venues (
       name, address, w3w_address,
       approach_notes, technical_notes,
       default_miles_from_base, default_drive_time_mins, default_tolls_amount,
       general_notes,
       created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'monday-migration')
     RETURNING id`,
    [name, address, w3w, accessNotes, stageNotes, distance, driveTime !== null ? Math.round(driveTime) : null, tolls, newNotes]
  );
  const newId = ins.rows[0].id;
  await recordExternalId(newId, item.id);
  return { status: 'created', venueId: newId };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`Monday Venues → OP ${COMMIT ? '(COMMIT MODE)' : '(DRY RUN)'}\n`);

  // Column dump first — lets user verify known IDs + find unknown ones.
  await dumpBoardColumns(VENUES_BOARD_ID!);

  console.log('\nFetching venues...');
  const items = await fetchAllItems(VENUES_BOARD_ID!);
  console.log(`Fetched ${items.length} venues`);

  const counts = { created: 0, updated: 0, linked: 0, skipped: 0, failed: 0 };
  const sampleByKind: Record<string, string[]> = { created: [], updated: [], linked: [], skipped: [] };

  for (const item of items) {
    try {
      const res = await upsertVenue(item);
      counts[res.status]++;
      if (sampleByKind[res.status].length < 5) {
        sampleByKind[res.status].push(`  ${item.name}${res.reason ? ` — ${res.reason}` : ''}`);
      }
    } catch (err) {
      counts.failed++;
      console.error(`  FAIL: ${item.name} (${item.id}): ${(err as Error).message}`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`created: ${counts.created}  updated: ${counts.updated}  linked: ${counts.linked}  skipped: ${counts.skipped}  failed: ${counts.failed}`);

  for (const kind of ['created', 'updated', 'linked', 'skipped'] as const) {
    if (sampleByKind[kind].length > 0) {
      console.log(`\nSample (${kind}):`);
      for (const line of sampleByKind[kind]) console.log(line);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  pool.end().catch(() => {/* noop */});
  process.exit(1);
});
