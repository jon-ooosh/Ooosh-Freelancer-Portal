/**
 * Monday.com → OP migration for upcoming D&C and Crewed jobs.
 *
 * Reads both Monday boards, finds items whose HireHop reference matches an
 * existing OP `jobs` row, and creates a `quotes` row plus a
 * `quote_assignments` link for the freelancer. Unmatched HH numbers and
 * items without an OP person match are skipped and reported.
 *
 * Running this does NOT create new `jobs` rows — HH numbers that don't
 * already exist in OP are the caller's responsibility to fix upstream
 * (HireHop webhook / manual re-sync).
 *
 * Writeback: on the D&C board, column `text_mm2krnzm` is stamped with
 * "yes" on success or "fail: reason" on failure so Jon can triage at a
 * glance. Crewed board writeback is off until Jon adds an equivalent
 * tracking column.
 *
 * Usage (dry-run — default):
 *   cd backend
 *   npx tsx src/scripts/migrate-monday-upcoming.ts
 *
 * To actually write:
 *   npx tsx src/scripts/migrate-monday-upcoming.ts --commit
 *
 * Optional flags:
 *   --only-dc           migrate only the D&C board
 *   --only-crew         migrate only the Crewed Jobs board
 *   --since 2026-01-01  override the "upcoming" cutoff (default: today)
 *   --refresh-venues    back-fill venue_id on already-migrated quotes
 *                       (looks up Monday venue board → external_id_map)
 *   --refresh-costings  back-fill client_charge / expenses / breakdown text
 *                       on already-migrated quotes (only fills blanks)
 *
 * Diagnostics (read-only — no --commit needed):
 *   --dump-board-cols          print every column on the D&C board
 *   --dump-item <mondayItemId> print full column_values for one item
 *                              (use this to debug venue / costing parsing)
 *
 * Required env vars (alongside DATABASE_URL):
 *   MONDAY_API_TOKEN
 *   MONDAY_BOARD_ID_DELIVERIES   (D&C board, e.g. 2028045828)
 *   MONDAY_BOARD_ID_CREW_JOBS    (Crewed Jobs board)
 *
 * Idempotent: re-running skips Monday items whose tracking column already
 * reads "yes" (D&C). Crewed items currently re-migrate until a tracking
 * column exists — the quote INSERT guards against near-duplicates by
 * checking (job_id, job_date, is_local, venue_id) as a heuristic.
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// ── CLI args ─────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const ONLY_DC = args.includes('--only-dc');
const ONLY_CREW = args.includes('--only-crew');
const REFRESH_VENUES = args.includes('--refresh-venues');
const REFRESH_COSTINGS = args.includes('--refresh-costings');
const DUMP_ITEM_IDX = args.indexOf('--dump-item');
const DUMP_ITEM_ID = DUMP_ITEM_IDX >= 0 ? args[DUMP_ITEM_IDX + 1] : null;
const DUMP_BOARD_COLS = args.includes('--dump-board-cols');
const SINCE_IDX = args.indexOf('--since');
const SINCE = SINCE_IDX >= 0 ? args[SINCE_IDX + 1] : new Date().toISOString().slice(0, 10);

// ── Env ──────────────────────────────────────────────────────────────

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const DC_BOARD_ID = process.env.MONDAY_BOARD_ID_DELIVERIES;
const CREW_BOARD_ID = process.env.MONDAY_BOARD_ID_CREW_JOBS;

if (!MONDAY_API_TOKEN) {
  console.error('Missing MONDAY_API_TOKEN');
  process.exit(1);
}

// Board-id checks are per-mode so modes that only touch one board don't
// fail at startup for missing env vars they don't actually need.
function requireDcBoard(): void {
  if (!DC_BOARD_ID) {
    console.error('Missing MONDAY_BOARD_ID_DELIVERIES');
    process.exit(1);
  }
}
function requireCrewBoard(): void {
  if (!CREW_BOARD_ID) {
    console.error('Missing MONDAY_BOARD_ID_CREW_JOBS');
    process.exit(1);
  }
}

// ── Column IDs (mirror of src/lib/monday.ts) ────────────────────────

const DC_COLS = {
  hhRef: 'text2',
  deliverCollect: 'status_1',          // "Delivery" / "Collection"
  whatIsIt: 'status4',                 // "Equipment" / "A vehicle"
  date: 'date4',
  timeToArrive: 'hour',
  venueConnect: 'connect_boards6',     // → venues board 2406443142
  driverEmailGC: 'driver_email__gc_',
  status: 'status90',
  keyPoints: 'key_points___summary',
  runGroup: 'color_mkxvwn11',
  driverPayMirror: 'lookup_mkzsfkg2',
  driverPayDirect: 'numeric_mm0688f9', // freelancer fee (driver pay)
  clientCharge: 'numeric_mm06wq2n',    // fee to charge client
  expensesIncluded: 'numeric_mm08av8f',     // expenses included in client charge
  expensesNotIncluded: 'numeric_mm08jhcw',  // expenses freelancer claims back
  expensesBreakdown: 'long_text_mm08cpst',  // free-text breakdown — appended to internal_notes
  clientEmail: 'email',
  tracking: 'text_mm2krnzm',           // OP migration status
} as const;

const CREW_COLS = {
  hhRef: 'text_mm081gk5',
  freelancerEmailGC: 'text_mm09da3v',
  jobType: 'color_mm062e1x',
  status: 'color_mm06zxg3',
  destination: 'text_mm065ytz',
  venueLink: 'board_relation_mm09vpr1',
  jobDate: 'date_mm067tnh',
  jobFinishDate: 'date_mm085d7c',
  arrivalTime: 'hour_mm06y636',
  workType: 'color_mm063qgs',
  workTypeOther: 'text_mm06542v',
  workDurationHours: 'numeric_mm06qxty',
  workDescription: 'text_mm06f0bj',
  freelancerFee: 'numeric_mm06fx2z',
  numberOfDays: 'numeric_mm063z0y',
  expensesIncluded: 'numeric_mm0815zc',
  expensesNotIncluded: 'numeric_mm086asx',
} as const;

// ── Monday helpers ───────────────────────────────────────────────────

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

interface MondayColumn {
  id: string;
  text: string | null;
  value: string | null;
  /** Typed field for board_relation / connect_boards columns. Populated
   *  via the GraphQL union fragment `... on BoardRelationValue`. */
  linked_item_ids?: string[];
}
interface MondayItem {
  id: string;
  name: string;
  group?: { id: string | null } | null;
  column_values: MondayColumn[];
}

/**
 * D&C Monday group for "upcoming / to be arranged" items — these don't yet
 * have a freelancer assigned. They're the most important to migrate so
 * staff can see + arrange them in OP's Transport Ops page. For items in
 * this group we create the quote without an assignment, skipping the
 * usual freelancer-email check.
 */
const DC_UNASSIGNED_GROUP_ID = 'new_group';

async function fetchBoardItems(boardId: string, cols: string[]): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    // Use the typed BoardRelationValue fragment so connect_boards / board_relation
    // columns return linked_item_ids directly. Bypasses guessing the value JSON
    // shape (Monday's API has changed it across versions: linkedPulseIds vs
    // linked_pulse_ids vs ids[]). The base { id text value } still works for
    // all other column types.
    const query = `
      query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items {
              id
              name
              group { id }
              column_values(ids: ${JSON.stringify(cols)}) {
                id
                text
                value
                ... on BoardRelationValue {
                  linked_item_ids
                }
              }
            }
          }
        }
      }
    `;
    interface PageResponse {
      boards: Array<{
        items_page: {
          cursor: string | null;
          items: MondayItem[];
        };
      }>;
    }
    const data: PageResponse = await mondayQuery<PageResponse>(query, { boardId, cursor });
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

async function writeTrackingColumn(
  boardId: string,
  itemId: string,
  columnId: string,
  value: string
): Promise<void> {
  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: String!) {
      change_simple_column_value(board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
    }
  `;
  await mondayQuery(mutation, { boardId, itemId, columnId, value });
}

function cv(item: MondayItem, columnId: string): MondayColumn | undefined {
  return item.column_values.find((c) => c.id === columnId);
}

function cvText(item: MondayItem, columnId: string): string {
  return cv(item, columnId)?.text?.trim() || '';
}

/**
 * Extract the FIRST linked Monday item id from a board_relation /
 * connect_boards column. Tries in order:
 *   1. The typed `linked_item_ids` field (Monday API 2024-01 canonical)
 *   2. Multiple historical JSON shapes (linkedPulseIds / linked_pulse_ids / ids)
 * Returns null if nothing usable is present.
 */
function extractLinkedMondayId(item: MondayItem, columnId: string): string | null {
  const col = cv(item, columnId);
  if (!col) return null;

  // 1. Typed field (Monday API 2024-01)
  if (Array.isArray(col.linked_item_ids) && col.linked_item_ids.length > 0) {
    const first = col.linked_item_ids[0];
    if (first != null && String(first).trim() !== '') return String(first);
  }

  // 2. JSON fallbacks — try every shape Monday has used.
  if (col.value) {
    try {
      const parsed = JSON.parse(col.value) as Record<string, unknown>;

      // Shape A: { linkedPulseIds: [{ linkedPulseId: 123 }] }
      const a = (parsed.linkedPulseIds as Array<{ linkedPulseId?: number | string }> | undefined)?.[0]?.linkedPulseId;
      if (a != null) return String(a);

      // Shape B: { linked_pulse_ids: [{ linked_pulse_id: 123 }] }
      const b = (parsed.linked_pulse_ids as Array<{ linked_pulse_id?: number | string }> | undefined)?.[0]?.linked_pulse_id;
      if (b != null) return String(b);

      // Shape C: { ids: [123, 456] }
      const c = (parsed.ids as Array<number | string> | undefined)?.[0];
      if (c != null) return String(c);

      // Shape D: { item_ids: [123] }
      const d = (parsed.item_ids as Array<number | string> | undefined)?.[0];
      if (d != null) return String(d);
    } catch {
      /* fall through */
    }
  }

  return null;
}

// ── DB ───────────────────────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function findOpJobByHhNumber(hhRef: string): Promise<{ id: string; client_id: string | null; client_name: string | null } | null> {
  const num = parseInt(hhRef, 10);
  if (!Number.isFinite(num)) return null;
  const r = await pool.query(
    `SELECT id, client_id, client_name FROM jobs WHERE hh_job_number = $1 LIMIT 1`,
    [num]
  );
  return r.rows[0] || null;
}

async function findPersonByEmail(email: string): Promise<{ id: string; is_freelancer: boolean; is_approved: boolean } | null> {
  if (!email) return null;
  const r = await pool.query(
    `SELECT id, is_freelancer, is_approved FROM people WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email.trim()]
  );
  return r.rows[0] || null;
}

async function findVenueByMondayId(mondayVenueId: string): Promise<{ id: string } | null> {
  if (!mondayVenueId) return null;
  // external_id_map stores Monday IDs for address-book entities
  const r = await pool.query(
    `SELECT entity_id AS id FROM external_id_map
     WHERE external_system = 'monday' AND external_id = $1 AND entity_type = 'venues' LIMIT 1`,
    [mondayVenueId]
  );
  return r.rows[0] || null;
}

// ── Per-item result tracking ─────────────────────────────────────────

interface MigrationOutcome {
  itemId: string;
  itemName: string;
  board: 'dc' | 'crew';
  hhRef: string | null;
  status: 'ok' | 'skip' | 'fail';
  reason: string;
}

const outcomes: MigrationOutcome[] = [];

// ── D&C migration ────────────────────────────────────────────────────

async function migrateDC(): Promise<void> {
  console.log('\n=== D&C board ===');
  const cols = Object.values(DC_COLS);
  const items = await fetchBoardItems(DC_BOARD_ID!, cols);
  console.log(`Fetched ${items.length} D&C items`);

  // Diagnostic: count items by group id so we can verify the
  // "unassigned / to be arranged" group id is correct.
  const groupCounts = new Map<string, number>();
  for (const it of items) {
    const g = it.group?.id || '(no group)';
    groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
  }
  const sorted = [...groupCounts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('D&C items by group id (top 10):');
  for (const [g, n] of sorted.slice(0, 10)) {
    const marker = g === DC_UNASSIGNED_GROUP_ID ? '  <-- DC_UNASSIGNED_GROUP_ID' : '';
    console.log(`  ${g}: ${n}${marker}`);
  }

  for (const item of items) {
    const tracking = cvText(item, DC_COLS.tracking).toLowerCase();
    if (tracking === 'yes') {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'dc', hhRef: null, status: 'skip', reason: 'already migrated' });
      continue;
    }
    const hhRef = cvText(item, DC_COLS.hhRef);
    const dateStr = cvText(item, DC_COLS.date);
    const status = cvText(item, DC_COLS.status);
    const isUnassignedGroup = item.group?.id === DC_UNASSIGNED_GROUP_ID;

    // Filter: upcoming only (date >= SINCE), not completed/cancelled.
    // Unassigned-group items ("to be arranged") bypass date + status filters
    // — they're the pile we most need in OP for staff to pick up.
    if (!isUnassignedGroup) {
      if (!dateStr || dateStr < SINCE) {
        outcomes.push({ itemId: item.id, itemName: item.name, board: 'dc', hhRef: hhRef || null, status: 'skip', reason: `date ${dateStr || 'blank'} < ${SINCE}` });
        continue;
      }
      const statusLower = status.toLowerCase();
      if (statusLower.includes('complete') || statusLower.includes('cancel') || statusLower.includes('done')) {
        outcomes.push({ itemId: item.id, itemName: item.name, board: 'dc', hhRef: hhRef || null, status: 'skip', reason: `status is "${status}"` });
        continue;
      }
    }

    if (!hhRef) {
      await recordFailure(item, 'dc', 'no HH ref on Monday item');
      continue;
    }

    const opJob = await findOpJobByHhNumber(hhRef);
    if (!opJob) {
      await recordFailure(item, 'dc', `no OP job with HH ${hhRef}`);
      continue;
    }

    const freelancerEmail = cvText(item, DC_COLS.driverEmailGC);
    const person = await findPersonByEmail(freelancerEmail);
    if (!person && !isUnassignedGroup) {
      await recordFailure(item, 'dc', freelancerEmail ? `freelancer "${freelancerEmail}" not in OP people` : 'no freelancer email on Monday item');
      continue;
    }
    // Unassigned-group items with no person → quote only, no assignment row.

    const deliverCollect = cvText(item, DC_COLS.deliverCollect).toLowerCase();
    const jobType = deliverCollect === 'collection' ? 'collection' : 'delivery';
    const whatIsIt = cvText(item, DC_COLS.whatIsIt).toLowerCase();
    const whatIsItNorm = whatIsIt.startsWith('vehicle') || whatIsIt === 'a vehicle' ? 'vehicle' : 'equipment';
    const timeRaw = cv(item, DC_COLS.timeToArrive)?.value ? JSON.parse(cv(item, DC_COLS.timeToArrive)!.value!) : null;
    const arrivalTime = timeRaw?.hour != null ? `${String(timeRaw.hour).padStart(2, '0')}:${String(timeRaw.minute || 0).padStart(2, '0')}` : null;
    const runGroup = cvText(item, DC_COLS.runGroup) || null;
    const keyPoints = cvText(item, DC_COLS.keyPoints) || null;
    const driverPay = Number(cvText(item, DC_COLS.driverPayDirect)) || Number(cvText(item, DC_COLS.driverPayMirror)) || null;
    const clientEmail = cvText(item, DC_COLS.clientEmail) || null;

    // Venue link — use typed Monday field first, JSON fallback for older shapes.
    let venueId: string | null = null;
    const mondayVenueId = extractLinkedMondayId(item, DC_COLS.venueConnect);
    if (mondayVenueId) {
      const venue = await findVenueByMondayId(mondayVenueId);
      if (venue) venueId = venue.id;
    }

    // Costings: client charge, expenses, breakdown text
    const clientCharge = Number(cvText(item, DC_COLS.clientCharge)) || null;
    const expensesIncluded = Number(cvText(item, DC_COLS.expensesIncluded)) || null;
    const expensesNotIncluded = Number(cvText(item, DC_COLS.expensesNotIncluded)) || null;
    const expensesBreakdown = cvText(item, DC_COLS.expensesBreakdown) || null;
    const internalNotesFromMonday = expensesBreakdown
      ? `Expenses breakdown (from Monday):\n${expensesBreakdown}`
      : null;

    const driverSummary = person
      ? `driver ${freelancerEmail} (${person.id})`
      : `UNASSIGNED (group ${DC_UNASSIGNED_GROUP_ID})`;

    if (!COMMIT) {
      const venueLabel = venueId ? `venue ✓` : (mondayVenueId ? `venue NOT in OP (mid=${mondayVenueId})` : 'no venue link');
      const charge = clientCharge ? `£${clientCharge} client / £${driverPay || 0} driver` : `£${driverPay || 0} driver`;
      outcomes.push({
        itemId: item.id,
        itemName: item.name,
        board: 'dc',
        hhRef,
        status: 'ok',
        reason: `would insert: ${jobType}/${whatIsItNorm} @ ${dateStr || 'TBC'} ${arrivalTime || ''} — ${driverSummary} — ${charge} — ${venueLabel}`,
      });
      continue;
    }

    // Write
    try {
      await pool.query('BEGIN');
      const quoteInsert = await pool.query(
        `INSERT INTO quotes (
           job_id, job_type, calculation_mode, what_is_it,
           venue_id, venue_name,
           job_date, arrival_time,
           key_points, run_group,
           freelancer_fee, freelancer_fee_rounded,
           client_charge_total, client_charge_rounded,
           expenses_included, expenses_not_included,
           internal_notes,
           is_local, status, ops_status,
           created_by
         ) VALUES (
           $1, $2, 'hourly', $3,
           $4, $5,
           $6, $7,
           $8, $9,
           $10, $10,
           $11, $11,
           $12, $13,
           $14,
           false, 'confirmed', 'arranging',
           NULL
         )
         RETURNING id`,
        [
          opJob.id,
          jobType,
          whatIsItNorm,
          venueId,
          null, // venue_name resolved from venue_id join
          dateStr || null,
          arrivalTime,
          keyPoints,
          runGroup,
          driverPay,
          clientCharge,
          expensesIncluded,
          expensesNotIncluded,
          internalNotesFromMonday,
        ]
      );
      const quoteId = quoteInsert.rows[0].id;

      // Only create the assignment row when we have a real person — for
      // unassigned-group items we leave the quote free for staff to
      // assign in Transport Ops.
      if (person) {
        await pool.query(
          `INSERT INTO quote_assignments (
             quote_id, person_id, role, agreed_rate, rate_type, status, is_ooosh_crew, created_by
           ) VALUES ($1, $2, 'driver', $3, 'flat', 'confirmed', false, NULL)`,
          [quoteId, person.id, driverPay]
        );
      }
      await pool.query('COMMIT');

      // Writeback
      try {
        await writeTrackingColumn(DC_BOARD_ID!, item.id, DC_COLS.tracking, 'yes');
      } catch (wbErr) {
        console.error(`  writeback failed for item ${item.id}:`, wbErr);
      }

      if (clientEmail) {
        // Future: attach client email somewhere — for now log
        console.log(`  note: Monday had client email ${clientEmail} (not stored on quote)`);
      }

      outcomes.push({ itemId: item.id, itemName: item.name, board: 'dc', hhRef, status: 'ok', reason: `migrated quote ${quoteId}` });
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {/* noop */});
      await recordFailure(item, 'dc', `DB error: ${(err as Error).message}`);
    }
  }
}

// ── Crew migration ───────────────────────────────────────────────────

async function migrateCrew(): Promise<void> {
  console.log('\n=== Crewed Jobs board ===');
  const cols = Object.values(CREW_COLS);
  const items = await fetchBoardItems(CREW_BOARD_ID!, cols);
  console.log(`Fetched ${items.length} Crewed items`);

  for (const item of items) {
    const hhRef = cvText(item, CREW_COLS.hhRef);
    const dateStr = cvText(item, CREW_COLS.jobDate);
    const status = cvText(item, CREW_COLS.status);

    if (!dateStr || dateStr < SINCE) {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef: hhRef || null, status: 'skip', reason: `date ${dateStr || 'blank'} < ${SINCE}` });
      continue;
    }
    const statusLower = status.toLowerCase();
    if (statusLower.includes('complete') || statusLower.includes('cancel') || statusLower.includes('done')) {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef: hhRef || null, status: 'skip', reason: `status is "${status}"` });
      continue;
    }

    if (!hhRef) {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef: null, status: 'fail', reason: 'no HH ref on Monday item' });
      continue;
    }

    const opJob = await findOpJobByHhNumber(hhRef);
    if (!opJob) {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef, status: 'fail', reason: `no OP job with HH ${hhRef}` });
      continue;
    }

    const freelancerEmail = cvText(item, CREW_COLS.freelancerEmailGC);
    const person = await findPersonByEmail(freelancerEmail);
    if (!person) {
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef, status: 'fail', reason: freelancerEmail ? `freelancer "${freelancerEmail}" not in OP people` : 'no freelancer email' });
      continue;
    }

    const jobType = 'crewed';
    const workType = cvText(item, CREW_COLS.workType) || null;
    const workTypeOther = cvText(item, CREW_COLS.workTypeOther) || null;
    const workDescription = cvText(item, CREW_COLS.workDescription) || null;
    const workDurationHrs = Number(cvText(item, CREW_COLS.workDurationHours)) || null;
    const numDays = Number(cvText(item, CREW_COLS.numberOfDays)) || 1;
    const freelancerFee = Number(cvText(item, CREW_COLS.freelancerFee)) || null;
    const jobFinishDate = cvText(item, CREW_COLS.jobFinishDate) || null;
    const destination = cvText(item, CREW_COLS.destination) || null;
    const timeRaw = cv(item, CREW_COLS.arrivalTime)?.value ? JSON.parse(cv(item, CREW_COLS.arrivalTime)!.value!) : null;
    const arrivalTime = timeRaw?.hour != null ? `${String(timeRaw.hour).padStart(2, '0')}:${String(timeRaw.minute || 0).padStart(2, '0')}` : null;

    let venueId: string | null = null;
    const mondayVenueId = extractLinkedMondayId(item, CREW_COLS.venueLink);
    if (mondayVenueId) {
      const venue = await findVenueByMondayId(mondayVenueId);
      if (venue) venueId = venue.id;
    }

    if (!COMMIT) {
      outcomes.push({
        itemId: item.id,
        itemName: item.name,
        board: 'crew',
        hhRef,
        status: 'ok',
        reason: `would insert: crewed ${workType || ''} @ ${dateStr} ${arrivalTime || ''} — ${freelancerEmail} (${person.id}) @ £${freelancerFee || '?'}`,
      });
      continue;
    }

    try {
      await pool.query('BEGIN');
      const quoteInsert = await pool.query(
        `INSERT INTO quotes (
           job_id, job_type, calculation_mode,
           venue_id, venue_name,
           job_date, job_finish_date, arrival_time, is_multi_day,
           work_type, work_type_other, work_description, work_duration_hrs,
           num_days,
           freelancer_fee, freelancer_fee_rounded,
           is_local, status, ops_status,
           created_by
         ) VALUES (
           $1, $2, 'hourly',
           $3, $4,
           $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13,
           $14, $14,
           false, 'confirmed', 'arranging',
           NULL
         )
         RETURNING id`,
        [
          opJob.id,
          jobType,
          venueId,
          destination,
          dateStr,
          jobFinishDate,
          arrivalTime,
          !!jobFinishDate && jobFinishDate !== dateStr,
          workType,
          workTypeOther,
          workDescription,
          workDurationHrs,
          numDays,
          freelancerFee,
        ]
      );
      const quoteId = quoteInsert.rows[0].id;

      await pool.query(
        `INSERT INTO quote_assignments (
           quote_id, person_id, role, agreed_rate, rate_type, status, is_ooosh_crew, created_by
         ) VALUES ($1, $2, 'crew', $3, 'flat', 'confirmed', false, NULL)`,
        [quoteId, person.id, freelancerFee]
      );
      await pool.query('COMMIT');

      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef, status: 'ok', reason: `migrated quote ${quoteId}` });
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {/* noop */});
      outcomes.push({ itemId: item.id, itemName: item.name, board: 'crew', hhRef, status: 'fail', reason: `DB error: ${(err as Error).message}` });
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

async function recordFailure(item: MondayItem, board: 'dc' | 'crew', reason: string): Promise<void> {
  const groupId = item.group?.id || '(no group)';
  const reasonWithGroup = `${reason} [group: ${groupId}]`;
  outcomes.push({ itemId: item.id, itemName: item.name, board, hhRef: cvText(item, board === 'dc' ? DC_COLS.hhRef : CREW_COLS.hhRef) || null, status: 'fail', reason: reasonWithGroup });
  if (COMMIT && board === 'dc') {
    try {
      await writeTrackingColumn(DC_BOARD_ID!, item.id, DC_COLS.tracking, `fail: ${reason.slice(0, 100)}`);
    } catch {/* ignore writeback failure */}
  }
}

// ── Main ─────────────────────────────────────────────────────────────

// ── Refresh venue_id on already-migrated D&C quotes ─────────────────
// Monday venue board is migrated separately (migrate-monday-venues.ts).
// Once venues exist in OP with external_id_map entries, this pass walks
// every D&C item whose tracking column reads "yes" and fills in the
// venue_id on the corresponding OP quote by:
//   1. Resolving the Monday venue id on the item to an OP venue
//   2. Matching the OP quote by (hh_job_number → job_id, job_type, job_date)
// Only updates quotes where venue_id IS NULL and venue_name IS NULL —
// i.e. the ones the initial migration created without a venue link.
// Keeps staff-edited quotes untouched.

async function refreshVenueLinks(): Promise<void> {
  console.log('\n=== D&C venue-link refresh ===');
  const cols = Object.values(DC_COLS);
  const items = await fetchBoardItems(DC_BOARD_ID!, cols);
  console.log(`Fetched ${items.length} D&C items from Monday`);

  let scanned = 0, matched = 0, updated = 0, noMondayVenue = 0, noOpVenue = 0, noQuote = 0, ambiguous = 0, skipped = 0;

  for (const item of items) {
    if (cvText(item, DC_COLS.tracking).toLowerCase() !== 'yes') {
      continue; // only refresh items we actually migrated
    }
    scanned++;

    // Use the typed Monday field (with JSON fallbacks) — handles every shape
    // Monday has used for board_relation columns across API versions.
    const mondayVenueId = extractLinkedMondayId(item, DC_COLS.venueConnect);
    if (!mondayVenueId) { noMondayVenue++; continue; }

    const opVenue = await findVenueByMondayId(mondayVenueId);
    if (!opVenue) { noOpVenue++; continue; }

    // Heuristic match to OP quote: HH → job_id, plus job_type + job_date
    // Only quotes that currently have NO venue — leave human-edited ones alone.
    const hhRef = cvText(item, DC_COLS.hhRef);
    const dateStr = cvText(item, DC_COLS.date);
    const deliverCollect = cvText(item, DC_COLS.deliverCollect).toLowerCase();
    const jobType = deliverCollect === 'collection' ? 'collection' : 'delivery';
    if (!hhRef || !dateStr) { skipped++; continue; }

    const opJob = await findOpJobByHhNumber(hhRef);
    if (!opJob) { skipped++; continue; }

    const matchRes = await pool.query(
      `SELECT id FROM quotes
       WHERE job_id = $1 AND job_type = $2 AND job_date = $3
         AND venue_id IS NULL AND (venue_name IS NULL OR venue_name = '')
         AND is_deleted = false`,
      [opJob.id, jobType, dateStr]
    );
    if (matchRes.rows.length === 0) { noQuote++; continue; }
    if (matchRes.rows.length > 1) { ambiguous++; continue; }
    matched++;

    if (!COMMIT) continue;

    await pool.query(
      `UPDATE quotes SET venue_id = $1, updated_at = NOW() WHERE id = $2`,
      [opVenue.id, matchRes.rows[0].id]
    );
    updated++;
  }

  console.log('\n=== Refresh summary ===');
  console.log(`scanned (tracking=yes): ${scanned}`);
  console.log(`  matched to OP quote:    ${matched}`);
  console.log(`  ${COMMIT ? 'updated' : 'would update'}:            ${COMMIT ? updated : matched}`);
  console.log(`  no Monday venue link:   ${noMondayVenue}`);
  console.log(`  Monday venue not in OP: ${noOpVenue}  (run migrate-monday-venues.ts --commit first)`);
  console.log(`  no matching OP quote:   ${noQuote}  (quote may have been staff-edited)`);
  console.log(`  ambiguous (>1 match):   ${ambiguous}`);
  console.log(`  data-insufficient:      ${skipped}`);
}

// ── Refresh costings on already-migrated D&C quotes ────────────────
// Initial migration only pulled the freelancer fee. This pass walks
// every D&C item with tracking="yes" and back-fills:
//   - client_charge_total / client_charge_rounded (fee to charge client)
//   - expenses_included / expenses_not_included
//   - internal_notes (appends the Monday "expenses breakdown" free text)
// Only updates the OP quote where the corresponding fields are NULL/blank,
// so any staff edits since migration are preserved. Matches Monday → OP
// quote via (hh_job_number → job_id, job_type, job_date) — same heuristic
// as refreshVenueLinks.

async function refreshCostings(): Promise<void> {
  console.log('\n=== D&C costings refresh ===');
  const cols = Object.values(DC_COLS);
  const items = await fetchBoardItems(DC_BOARD_ID!, cols);
  console.log(`Fetched ${items.length} D&C items from Monday`);

  let scanned = 0, matched = 0, updated = 0, noQuote = 0, ambiguous = 0, skipped = 0, nothingToSet = 0;

  for (const item of items) {
    if (cvText(item, DC_COLS.tracking).toLowerCase() !== 'yes') continue;
    scanned++;

    const hhRef = cvText(item, DC_COLS.hhRef);
    const dateStr = cvText(item, DC_COLS.date);
    const deliverCollect = cvText(item, DC_COLS.deliverCollect).toLowerCase();
    const jobType = deliverCollect === 'collection' ? 'collection' : 'delivery';
    if (!hhRef || !dateStr) { skipped++; continue; }

    const opJob = await findOpJobByHhNumber(hhRef);
    if (!opJob) { skipped++; continue; }

    const clientCharge = Number(cvText(item, DC_COLS.clientCharge)) || null;
    const expensesIncluded = Number(cvText(item, DC_COLS.expensesIncluded)) || null;
    const expensesNotIncluded = Number(cvText(item, DC_COLS.expensesNotIncluded)) || null;
    const expensesBreakdown = cvText(item, DC_COLS.expensesBreakdown) || null;

    if (clientCharge == null && expensesIncluded == null && expensesNotIncluded == null && !expensesBreakdown) {
      nothingToSet++;
      continue;
    }

    // Match the OP quote — narrow to the same job/type/date (mirrors the
    // venue refresh). Don't filter on venue_id NULL here, costings should
    // backfill regardless of venue state.
    const matchRes = await pool.query(
      `SELECT id, client_charge_total, expenses_included, expenses_not_included, internal_notes
       FROM quotes
       WHERE job_id = $1 AND job_type = $2 AND job_date = $3
         AND is_deleted = false`,
      [opJob.id, jobType, dateStr]
    );
    if (matchRes.rows.length === 0) { noQuote++; continue; }
    if (matchRes.rows.length > 1) { ambiguous++; continue; }
    matched++;

    const existing = matchRes.rows[0];
    const updates: string[] = [];
    const params: unknown[] = [];

    // Only fill blanks — preserve staff edits.
    if (clientCharge != null && (existing.client_charge_total == null || Number(existing.client_charge_total) === 0)) {
      params.push(clientCharge);
      updates.push(`client_charge_total = $${params.length}, client_charge_rounded = $${params.length}`);
    }
    if (expensesIncluded != null && (existing.expenses_included == null || Number(existing.expenses_included) === 0)) {
      params.push(expensesIncluded);
      updates.push(`expenses_included = $${params.length}`);
    }
    if (expensesNotIncluded != null && (existing.expenses_not_included == null || Number(existing.expenses_not_included) === 0)) {
      params.push(expensesNotIncluded);
      updates.push(`expenses_not_included = $${params.length}`);
    }
    if (expensesBreakdown) {
      const block = `Expenses breakdown (from Monday):\n${expensesBreakdown}`;
      const current = (existing.internal_notes || '').toString();
      // Skip if the block is already present (idempotent re-run).
      if (!current.includes('Expenses breakdown (from Monday):')) {
        const newNotes = current.trim() ? `${current.trim()}\n\n${block}` : block;
        params.push(newNotes);
        updates.push(`internal_notes = $${params.length}`);
      }
    }

    if (updates.length === 0) {
      nothingToSet++;
      continue;
    }

    if (!COMMIT) continue;

    params.push(existing.id);
    await pool.query(
      `UPDATE quotes SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
      params
    );
    updated++;
  }

  console.log('\n=== Costings refresh summary ===');
  console.log(`scanned (tracking=yes):     ${scanned}`);
  console.log(`  matched to OP quote:        ${matched}`);
  console.log(`  ${COMMIT ? 'updated' : 'would update'}:                ${COMMIT ? updated : matched - nothingToSet}`);
  console.log(`  nothing to set / unchanged: ${nothingToSet}`);
  console.log(`  no matching OP quote:       ${noQuote}`);
  console.log(`  ambiguous (>1 match):       ${ambiguous}`);
  console.log(`  data-insufficient:          ${skipped}`);
}

// ── Diagnostic: dump every column on the D&C board ──────────────────

async function dumpBoardColumns(boardId: string): Promise<void> {
  interface ColDef { id: string; title: string; type: string }
  interface Result { boards: Array<{ columns: ColDef[] }> }
  const data = await mondayQuery<Result>(`
    query ($boardId: ID!) {
      boards(ids: [$boardId]) {
        columns { id title type }
      }
    }
  `, { boardId });
  const cols = data.boards?.[0]?.columns || [];
  console.log(`\nBoard ${boardId} — ${cols.length} columns:`);
  for (const c of cols) {
    console.log(`  ${c.id.padEnd(34)} | ${c.type.padEnd(18)} | ${c.title}`);
  }
}

// ── Diagnostic: dump full column_values for one item ────────────────

async function dumpItem(itemId: string): Promise<void> {
  interface Result {
    items: Array<{
      id: string;
      name: string;
      board: { id: string; name: string };
      group: { id: string; title: string };
      column_values: Array<{
        id: string;
        type: string;
        text: string | null;
        value: string | null;
        linked_item_ids?: string[];
      }>;
    }>;
  }
  const data = await mondayQuery<Result>(`
    query ($itemId: ID!) {
      items(ids: [$itemId]) {
        id
        name
        board { id name }
        group { id title }
        column_values {
          id
          type
          text
          value
          ... on BoardRelationValue { linked_item_ids }
        }
      }
    }
  `, { itemId });
  const it = data.items?.[0];
  if (!it) {
    console.log(`No Monday item with id ${itemId}`);
    return;
  }
  console.log(`\nItem ${it.id} "${it.name}"`);
  console.log(`  board: ${it.board.id} "${it.board.name}"`);
  console.log(`  group: ${it.group.id} "${it.group.title}"`);
  console.log(`  ${it.column_values.length} column values:\n`);
  for (const c of it.column_values) {
    console.log(`  ${c.id.padEnd(34)} | ${c.type.padEnd(18)} | text="${(c.text || '').slice(0, 60)}"`);
    if (c.value) console.log(`    value: ${c.value}`);
    if (c.linked_item_ids && c.linked_item_ids.length > 0) {
      console.log(`    linked_item_ids: ${JSON.stringify(c.linked_item_ids)}`);
    }
  }
}

async function main(): Promise<void> {
  if (DUMP_BOARD_COLS) {
    requireDcBoard();
    await dumpBoardColumns(DC_BOARD_ID!);
    await pool.end();
    return;
  }

  if (DUMP_ITEM_ID) {
    await dumpItem(DUMP_ITEM_ID);
    await pool.end();
    return;
  }

  if (REFRESH_COSTINGS) {
    console.log(`Costings refresh ${COMMIT ? '(COMMIT MODE)' : '(DRY RUN)'}`);
    requireDcBoard();
    await refreshCostings();
    await pool.end();
    return;
  }

  if (REFRESH_VENUES) {
    console.log(`Venue-link refresh ${COMMIT ? '(COMMIT MODE)' : '(DRY RUN)'}`);
    requireDcBoard();
    await refreshVenueLinks();
    await pool.end();
    return;
  }

  console.log(`Monday → OP migration ${COMMIT ? '(COMMIT MODE)' : '(DRY RUN)'}`);
  console.log(`Cutoff date (SINCE): ${SINCE}`);

  if (!ONLY_CREW) { requireDcBoard(); await migrateDC(); }
  if (!ONLY_DC) { requireCrewBoard(); await migrateCrew(); }

  // Summary
  const by = (board: 'dc' | 'crew', st: MigrationOutcome['status']) =>
    outcomes.filter((o) => o.board === board && o.status === st).length;
  console.log('\n=== Summary ===');
  console.log(`D&C   — ok: ${by('dc', 'ok')}  skip: ${by('dc', 'skip')}  fail: ${by('dc', 'fail')}`);
  console.log(`Crew  — ok: ${by('crew', 'ok')}  skip: ${by('crew', 'skip')}  fail: ${by('crew', 'fail')}`);

  const fails = outcomes.filter((o) => o.status === 'fail');
  if (fails.length > 0) {
    console.log('\nFailures:');
    for (const f of fails) {
      console.log(`  [${f.board}] item ${f.itemId} "${f.itemName}" (HH ${f.hhRef || 'none'}): ${f.reason}`);
    }
  }

  const oks = outcomes.filter((o) => o.status === 'ok');
  if (!COMMIT && oks.length > 0) {
    console.log('\nWould migrate:');
    for (const o of oks.slice(0, 20)) {
      console.log(`  [${o.board}] ${o.itemName}: ${o.reason}`);
    }
    if (oks.length > 20) console.log(`  ... and ${oks.length - 20} more`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  pool.end().catch(() => {/* noop */});
  process.exit(1);
});
