/**
 * Audit HireHop ↔ Ooosh pipeline status mismatches.
 *
 * Read-only. Reports every job where `jobs.status` (HH integer) doesn't sit in
 * the set of HH codes acceptable for the row's `pipeline_status`. The point
 * isn't strict equality — several OP states share an HH code (e.g.
 * new_enquiry/quoting/paused all → 0; prepped/dispatched both → 5) — so this
 * checks set membership rather than direct equality.
 *
 * Output: summary table grouped by (pipeline_status, hh_status) pair, then
 * the first 200 individual rows for triage. Optional `--csv` writes a full
 * CSV to ./status-mismatch.csv.
 *
 * Run on the server:
 *   cd /var/www/ooosh-portal/backend
 *   npx ts-node src/scripts/audit-status-mismatch.ts
 *   npx ts-node src/scripts/audit-status-mismatch.ts --csv
 */

import * as fs from 'fs';
import * as path from 'path';
import { query } from '../config/database';

// Acceptable HH codes per OP pipeline_status. Anything outside this set
// counts as a mismatch.
const ACCEPTABLE: Record<string, number[]> = {
  new_enquiry: [0],
  quoting: [0],
  chasing: [0], // legacy — derived now, but historic rows may still hold it
  paused: [0],
  provisional: [1],
  confirmed: [2, 3, 4],
  prepping: [2, 3, 4],
  prepped: [3, 4, 5],
  dispatched: [4, 5, 6],
  returned_incomplete: [6],
  returned: [7, 8],
  completed: [11],
  lost: [0, 10],
  cancelled: [9],
};

const HH_LABEL: Record<number, string> = {
  0: 'Enquiry',
  1: 'Provisional',
  2: 'Booked',
  3: 'Prepped',
  4: 'Part Dispatched',
  5: 'Dispatched',
  6: 'Returned Incomplete',
  7: 'Returned',
  8: 'Requires Attention',
  9: 'Cancelled',
  10: 'Not Interested',
  11: 'Completed',
};

// pg returns TIMESTAMPTZ as Date objects, not strings
type PgDate = Date | string | null;

interface Row {
  id: string;
  hh_job_number: number | null;
  pipeline_status: string;
  hh_status: number;
  job_name: string | null;
  client_name: string | null;
  job_date: PgDate;
  return_date: PgDate;
  updated_at: PgDate;
}

function toDateString(d: PgDate): string {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function toMs(d: PgDate): number {
  if (!d) return 0;
  if (d instanceof Date) return d.getTime();
  const parsed = new Date(String(d));
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

async function main() {
  const csvMode = process.argv.includes('--csv');

  console.log('Fetching all non-deleted jobs with HH + pipeline status...\n');
  const result = await query(
    `SELECT id, hh_job_number, pipeline_status, status AS hh_status,
            job_name, client_name, job_date, return_date, updated_at
     FROM jobs
     WHERE is_deleted = false
       AND pipeline_status IS NOT NULL
       AND status IS NOT NULL
     ORDER BY return_date DESC NULLS LAST, job_date DESC NULLS LAST`
  );

  const mismatches: Row[] = [];
  let unknownPipeline = 0;
  for (const r of result.rows as Row[]) {
    const allowed = ACCEPTABLE[r.pipeline_status];
    if (!allowed) {
      unknownPipeline++;
      mismatches.push(r);
      continue;
    }
    if (!allowed.includes(r.hh_status)) {
      mismatches.push(r);
    }
  }

  console.log(`Total jobs scanned: ${result.rows.length}`);
  console.log(`Total mismatches: ${mismatches.length}`);
  if (unknownPipeline > 0) {
    console.log(`(of which: ${unknownPipeline} have a pipeline_status not in the canonical map — those need manual review)`);
  }
  console.log('');

  // Group by (pipeline_status, hh_status) pair
  const groups = new Map<string, { count: number; pipeline_status: string; hh_status: number; oldest_return: PgDate; newest_return: PgDate }>();
  for (const r of mismatches) {
    const key = `${r.pipeline_status}::${r.hh_status}`;
    const entry = groups.get(key);
    const ret = r.return_date;
    if (entry) {
      entry.count++;
      if (ret && (!entry.oldest_return || toMs(ret) < toMs(entry.oldest_return))) entry.oldest_return = ret;
      if (ret && (!entry.newest_return || toMs(ret) > toMs(entry.newest_return))) entry.newest_return = ret;
    } else {
      groups.set(key, {
        count: 1,
        pipeline_status: r.pipeline_status,
        hh_status: r.hh_status,
        oldest_return: ret,
        newest_return: ret,
      });
    }
  }

  // Sort groups by count desc
  const sorted = Array.from(groups.values()).sort((a, b) => b.count - a.count);

  console.log('=== Grouped summary (largest buckets first) ===\n');
  console.log('count'.padEnd(7) + 'pipeline_status'.padEnd(22) + 'HH'.padEnd(5) + 'HH label'.padEnd(22) + 'return-date range');
  console.log('-'.repeat(95));
  for (const g of sorted) {
    const range = g.oldest_return && g.newest_return
      ? `${toDateString(g.oldest_return)} → ${toDateString(g.newest_return)}`
      : '(no return_date)';
    console.log(
      String(g.count).padEnd(7) +
      g.pipeline_status.padEnd(22) +
      String(g.hh_status).padEnd(5) +
      (HH_LABEL[g.hh_status] || '?').padEnd(22) +
      range
    );
  }
  console.log('');

  // First 200 rows for hand inspection
  console.log('=== First 200 mismatched rows (newest first by return_date) ===\n');
  console.log(
    'HH#'.padEnd(8) +
    'pipeline_status'.padEnd(22) +
    'HH'.padEnd(5) +
    'return_date'.padEnd(13) +
    'client — job_name'
  );
  console.log('-'.repeat(120));
  for (const r of mismatches.slice(0, 200)) {
    const ret = r.return_date ? toDateString(r.return_date) : '—';
    const label = `${r.client_name || '?'} — ${r.job_name || '?'}`.slice(0, 60);
    console.log(
      String(r.hh_job_number ?? '?').padEnd(8) +
      r.pipeline_status.padEnd(22) +
      String(r.hh_status).padEnd(5) +
      ret.padEnd(13) +
      label
    );
  }
  if (mismatches.length > 200) {
    console.log(`\n... ${mismatches.length - 200} more rows. Use --csv for the full list.`);
  }

  if (csvMode) {
    const csvPath = path.resolve(process.cwd(), 'status-mismatch.csv');
    const lines: string[] = [
      'hh_job_number,op_uuid,pipeline_status,hh_status,hh_label,client_name,job_name,job_date,return_date,updated_at',
    ];
    for (const r of mismatches) {
      const cells = [
        String(r.hh_job_number ?? ''),
        r.id,
        r.pipeline_status,
        String(r.hh_status),
        HH_LABEL[r.hh_status] || '',
        csvCell(r.client_name),
        csvCell(r.job_name),
        toDateString(r.job_date),
        toDateString(r.return_date),
        r.updated_at ? (r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)) : '',
      ];
      lines.push(cells.join(','));
    }
    fs.writeFileSync(csvPath, lines.join('\n'), 'utf8');
    console.log(`\nCSV written to ${csvPath}`);
  }

  process.exit(0);
}

function csvCell(v: string | null): string {
  if (!v) return '';
  const needsQuote = v.includes(',') || v.includes('"') || v.includes('\n');
  if (!needsQuote) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

main().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
