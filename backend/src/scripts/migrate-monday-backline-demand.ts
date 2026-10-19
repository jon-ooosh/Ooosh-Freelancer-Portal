/**
 * Monday.com → OP migration for the Backline Demand board (2227909940).
 *
 * The standalone Backline Matcher logged every "client asked for X" search to
 * this Monday board as demand intelligence (request count, total hire-days,
 * jobs, first/last seen, "do we have it" status). This one-shot pulls those
 * ~30 rows into OP's `backline_demand` table so the history survives Monday's
 * shutdown.
 *
 * Idempotent: upserts on normalised request name. Re-running is safe — counts
 * are SET from Monday (not incremented), so a second run produces the same rows.
 *
 * Column map (from find-alternative.js logToMonday):
 *   item.name         -> display_request (+ normalised_request key)
 *   numeric_mkzn9zfy  -> request_count
 *   numeric_mkznq7p3  -> total_hire_days
 *   text_mkzn1fqj     -> job_refs (comma-separated -> text[])
 *   date4             -> last_requested_at
 *   date_mkznfpvx     -> first_requested_at
 *   color_mkznsdrp    -> have_it_status (Yes/No/Sort of -> yes/no/sort_of)
 *
 * Usage (dry-run — default):
 *   cd backend && npx tsx src/scripts/migrate-monday-backline-demand.ts
 * To write:
 *   npx tsx src/scripts/migrate-monday-backline-demand.ts --commit
 */
import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const COMMIT = process.argv.includes('--commit');

const MONDAY_API_TOKEN = process.env.MONDAY_API_TOKEN;
const BOARD_ID = process.env.MONDAY_BOARD_ID_BACKLINE_DEMAND || '2227909940';

if (!MONDAY_API_TOKEN) {
  console.error('Missing MONDAY_API_TOKEN');
  process.exit(1);
}

const COLS = {
  count: 'numeric_mkzn9zfy',
  days: 'numeric_mkznq7p3',
  jobs: 'text_mkzn1fqj',
  lastRequested: 'date4',
  firstRequested: 'date_mkznfpvx',
  status: 'color_mkznsdrp',
} as const;

interface MondayColumnValue { id: string; text: string | null; value: string | null }
interface MondayItem { id: string; name: string; column_values: MondayColumnValue[] }

async function mondayQuery<T>(q: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      Authorization: MONDAY_API_TOKEN!,
      'Content-Type': 'application/json',
      'API-Version': '2024-01',
    },
    body: JSON.stringify({ query: q, variables }),
  });
  if (!res.ok) throw new Error(`Monday HTTP ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error('Monday errors: ' + body.errors.map((e) => e.message).join('; '));
  return body.data as T;
}

async function fetchAllItems(boardId: string): Promise<MondayItem[]> {
  const all: MondayItem[] = [];
  let cursor: string | null = null;
  do {
    interface Result {
      boards: Array<{ items_page: { cursor: string | null; items: MondayItem[] } }>;
    }
    const data: Result = await mondayQuery<Result>(
      `query ($boardId: ID!, $cursor: String) {
        boards(ids: [$boardId]) {
          items_page(limit: 100, cursor: $cursor) {
            cursor
            items { id name column_values { id text value } }
          }
        }
      }`,
      { boardId, cursor },
    );
    const page = data.boards?.[0]?.items_page;
    if (!page) break;
    all.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return all;
}

const cvText = (item: MondayItem, colId: string): string =>
  item.column_values.find((c) => c.id === colId)?.text?.trim() || '';

function cvNumber(item: MondayItem, colId: string): number {
  const t = cvText(item, colId);
  const n = parseInt(t.replace(/[,\s]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function cvDate(item: MondayItem, colId: string): string | null {
  const t = cvText(item, colId);
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? t.substring(0, 10) : null;
}

function normalise(name: string): string {
  return name.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function mapStatus(monday: string): 'yes' | 'no' | 'sort_of' {
  const s = monday.toLowerCase();
  if (s.includes('sort')) return 'sort_of';
  if (s.startsWith('yes')) return 'yes';
  return 'no';
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  console.log(`Backline demand migration — ${COMMIT ? 'COMMIT' : 'DRY RUN'} — board ${BOARD_ID}`);

  const items = await fetchAllItems(BOARD_ID);
  console.log(`Fetched ${items.length} items from Monday.`);

  let written = 0;
  for (const item of items) {
    const normalised = normalise(item.name);
    if (!normalised) {
      console.log(`  SKIP (empty name): ${item.id}`);
      continue;
    }
    const count = Math.max(cvNumber(item, COLS.count), 1);
    const days = cvNumber(item, COLS.days);
    const jobsRaw = cvText(item, COLS.jobs);
    const jobRefs = jobsRaw ? jobsRaw.split(',').map((j) => j.trim()).filter(Boolean) : [];
    const last = cvDate(item, COLS.lastRequested);
    const first = cvDate(item, COLS.firstRequested);
    const status = mapStatus(cvText(item, COLS.status));

    console.log(
      `  ${COMMIT ? 'UPSERT' : 'WOULD'}: "${item.name}" count=${count} days=${days} ` +
        `jobs=[${jobRefs.join(',')}] status=${status} first=${first || '—'} last=${last || '—'}`,
    );

    if (COMMIT) {
      await pool.query(
        `INSERT INTO backline_demand
           (normalised_request, display_request, request_count, total_hire_days,
            job_refs, have_it_status, source, first_requested_at, last_requested_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'monday_import',
                 COALESCE($7::timestamptz, NOW()), COALESCE($8::timestamptz, NOW()))
         ON CONFLICT (normalised_request) DO UPDATE SET
           display_request   = EXCLUDED.display_request,
           request_count     = EXCLUDED.request_count,
           total_hire_days   = EXCLUDED.total_hire_days,
           job_refs          = EXCLUDED.job_refs,
           have_it_status    = EXCLUDED.have_it_status,
           first_requested_at = LEAST(backline_demand.first_requested_at, EXCLUDED.first_requested_at),
           last_requested_at  = GREATEST(backline_demand.last_requested_at, EXCLUDED.last_requested_at),
           updated_at        = NOW()`,
        [normalised, item.name.trim(), count, days, jobRefs, status, first, last],
      );
      written++;
    }
  }

  console.log(COMMIT ? `\nDone. ${written} rows upserted.` : `\nDry run complete. ${items.length} rows would be written. Re-run with --commit.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
