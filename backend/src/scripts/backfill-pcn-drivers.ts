/**
 * Backfill driver_id on imported PCNs (companion to migrate-monday-pcns.ts).
 *
 * The PCN import couldn't anchor drivers because OP `drivers.monday_item_id`
 * comes from the global driver board (9798399405) while the PCN board's driver
 * link points at the Driver Hire Form board (841453886) — different pulse-id
 * spaces. So we can't match on pulse id; we bridge by name/email instead:
 *
 *   1. Re-read the PCN board, pulling each item's DRIVER_LINK board-relation
 *      (the underlying link behind the mirror column staff see).
 *   2. Batch-fetch the linked hire-form items from board 841453886 to read the
 *      driver's real name (item name) + email (whichever column holds it).
 *   3. Match OP drivers by email (canonical), falling back to normalised name.
 *   4. UPDATE pcns SET driver_id WHERE reference matches AND driver_id IS NULL,
 *      logging a `matched` pcn_event. Never overwrites an existing driver_id.
 *
 * If the board-relation turns out to be empty (a pure mirror with no stored
 * link), pass --name-column <colId> to read the driver name from a text column
 * you populate on the PCN board instead (your copy-to-text idea). The script
 * prints the raw DRIVER_LINK of the first few items so you can see which case
 * you're in before committing.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-pcn-drivers.ts                      # dry-run
 *   npx tsx src/scripts/backfill-pcn-drivers.ts --commit
 *   npx tsx src/scripts/backfill-pcn-drivers.ts --name-column text_xxxx --commit
 *
 * Env: MONDAY_API_TOKEN, DATABASE_URL.
 */

import { Pool } from 'pg';

const PCN_TRACKER_BOARD_ID = '18390180140';
const DRIVER_LINK_COLUMN = 'board_relation_mky4ptk1'; // link → Driver Hire Form board
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const nameColIdx = args.indexOf('--name-column');
const NAME_COLUMN = nameColIdx >= 0 ? args[nameColIdx + 1] : null;

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;

interface MondayColumn { id: string; text: string | null; value: string | null }
interface MondayItem { id: string; name: string; column_values: MondayColumn[] }

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
  if (body.errors?.length) throw new Error('Monday errors: ' + body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

interface ItemsPageResponse {
  boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }>;
}

async function fetchPcnItems(): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  const cols = JSON.stringify([DRIVER_LINK_COLUMN, ...(NAME_COLUMN ? [NAME_COLUMN] : [])]);
  do {
    const data: ItemsPageResponse = await mondayQuery<ItemsPageResponse>(
      `query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items { id name column_values(ids: ${cols}) { id text value } }
          }
        }
      }`,
      { boardId: PCN_TRACKER_BOARD_ID, cursor }
    );
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

function linkedPulseId(item: MondayItem): number | null {
  const c = item.column_values.find((x) => x.id === DRIVER_LINK_COLUMN);
  if (!c?.value) return null;
  try {
    const p = JSON.parse(c.value);
    const lp = p.linkedPulseIds || p.linked_pulse_ids;
    if (Array.isArray(lp) && lp.length) return Number(lp[0].linkedPulseId ?? lp[0].linked_pulse_id ?? lp[0]) || null;
    if (Array.isArray(p.item_ids) && p.item_ids.length) return Number(p.item_ids[0]) || null;
  } catch { /* */ }
  return null;
}

function nameColValue(item: MondayItem): string | null {
  if (!NAME_COLUMN) return null;
  const c = item.column_values.find((x) => x.id === NAME_COLUMN);
  const t = c?.text?.trim();
  return t ? t : null;
}

/** Read the driver email from a hire-form item's columns (Monday email columns
 *  store {"email":"a@b.com","text":"..."} in `value`). */
function emailOf(item: MondayItem): string | null {
  for (const c of item.column_values) {
    if (!c.value) continue;
    try {
      const p = JSON.parse(c.value);
      if (p && typeof p.email === 'string' && p.email.includes('@')) return p.email.toLowerCase().trim();
    } catch { /* */ }
  }
  return null;
}

async function fetchHireFormItems(ids: number[]): Promise<Map<number, MondayItem>> {
  const out = new Map<number, MondayItem>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const data = await mondayQuery<{ items: MondayItem[] }>(
      `query ($ids: [ID!]) { items(ids: $ids) { id name column_values { id text value } } }`,
      { ids: chunk.map(String) }
    );
    for (const it of data.items) out.set(Number(it.id), it);
  }
  return out;
}

const normName = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function resolveDriver(pool: Pool, email: string | null, name: string | null): Promise<{ id: string; by: string } | null> {
  if (email) {
    const r = await pool.query(`SELECT id FROM drivers WHERE LOWER(email) = $1 AND is_active = true LIMIT 1`, [email]);
    if (r.rows[0]) return { id: r.rows[0].id, by: 'email' };
  }
  if (name) {
    const r = await pool.query(
      `SELECT id FROM drivers WHERE LOWER(TRIM(REGEXP_REPLACE(full_name, '\\s+', ' ', 'g'))) = $1 AND is_active = true LIMIT 1`,
      [normName(name)]
    );
    if (r.rows[0]) return { id: r.rows[0].id, by: 'name' };
  }
  return null;
}

async function main() {
  if (!MONDAY_API_TOKEN) { console.error('MONDAY_API_TOKEN not set'); process.exit(1); }
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

  console.log(`\nPCN driver backfill  ${COMMIT ? '*** COMMIT ***' : '(dry-run)'}${NAME_COLUMN ? `  name-column=${NAME_COLUMN}` : ''}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const items = await fetchPcnItems();
    console.log(`${items.length} PCN board items\n`);

    // Diagnostic: show the raw driver-link of the first few so we can see if the
    // relation is populated (vs an empty mirror that needs --name-column).
    console.log('— DRIVER_LINK sample (first 5) —');
    for (const it of items.slice(0, 5)) {
      const raw = it.column_values.find((c) => c.id === DRIVER_LINK_COLUMN)?.value;
      console.log(`  ${it.name}: ${raw || '(empty)'}`);
    }
    console.log('');

    // Resolve hire-form names/emails for every linked pulse in one batch.
    const pulseByRef = new Map<string, number>();
    const allPulses = new Set<number>();
    for (const it of items) {
      const pulse = linkedPulseId(it);
      if (pulse) { pulseByRef.set(it.name, pulse); allPulses.add(pulse); }
    }
    const hireForms = allPulses.size ? await fetchHireFormItems([...allPulses]) : new Map<number, MondayItem>();

    const stats = { linked: 0, byEmail: 0, byName: 0, unmatched: 0, alreadySet: 0, noSource: 0 };
    const unmatched: string[] = [];

    for (const it of items) {
      const reference = it.name?.trim();
      if (!reference) continue;

      // Source of the driver identity: hire-form relation, else --name-column.
      const pulse = pulseByRef.get(reference);
      const hf = pulse ? hireForms.get(pulse) : undefined;
      const email = hf ? emailOf(hf) : null;
      const name = (hf ? hf.name?.trim() : null) || nameColValue(it);

      if (!email && !name) { stats.noSource++; continue; }
      stats.linked++;

      // Only touch rows still missing a driver.
      const pcn = await pool.query(
        `SELECT id, driver_id FROM pcns WHERE reference = $1 AND is_deleted = false LIMIT 1`,
        [reference]
      );
      if (pcn.rows.length === 0) continue;
      if (pcn.rows[0].driver_id) { stats.alreadySet++; continue; }

      const match = await resolveDriver(pool, email, name);
      if (!match) {
        stats.unmatched++;
        unmatched.push(`${reference} → ${name || '?'}${email ? ` <${email}>` : ''}`);
        continue;
      }

      if (match.by === 'email') stats.byEmail++; else stats.byName++;
      console.log(`  ✓ ${reference}  → ${name || email}  (by ${match.by})`);

      if (COMMIT) {
        await pool.query(`UPDATE pcns SET driver_id = $2, updated_at = NOW() WHERE id = $1`, [pcn.rows[0].id, match.id]);
        await pool.query(
          `INSERT INTO pcn_events (pcn_id, event_type, body, metadata, created_by)
           VALUES ($1, 'matched', $2, $3, $4)`,
          [pcn.rows[0].id, `Driver matched on backfill (${match.by})`,
           JSON.stringify({ source: 'monday', hire_form_item_id: pulse ?? null, matched_by: match.by, name, email }),
           SYSTEM_USER_ID]
        );
      }
    }

    console.log('\n── Summary ──');
    console.log(`  with a driver source:     ${stats.linked}`);
    console.log(`  matched by email:         ${stats.byEmail}`);
    console.log(`  matched by name:          ${stats.byName}`);
    console.log(`  already had a driver:     ${stats.alreadySet}`);
    console.log(`  unmatched (no OP driver): ${stats.unmatched}`);
    console.log(`  no driver source on item: ${stats.noSource}`);
    if (unmatched.length) {
      console.log('\n  Unmatched (need a manual look or a new driver row):');
      unmatched.forEach((u) => console.log(`    - ${u}`));
    }
    if (!COMMIT) console.log('\nDry-run only. Re-run with --commit to write.\n');
    else console.log('\nDone.\n');
  } finally {
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
