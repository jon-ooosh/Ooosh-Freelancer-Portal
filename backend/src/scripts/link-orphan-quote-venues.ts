/**
 * Link quotes whose venue is free text to a real venue record.
 *
 * `quotes.venue_id` is the only thing that carries an address to the
 * freelancer: the portal reads `LEFT JOIN venues v ON v.id = q.venue_id` and
 * `venue_address` / `venue_city` come from nowhere else. A quote with
 * `venue_name` set and `venue_id` NULL gives the driver a name with no
 * address, no postcode and none of the venue's parking / load-in / access
 * notes. 97 of 675 quotes were in that state in Sep 2026.
 *
 * The picker now offers create-on-no-match so the number stops growing
 * (PR #1232). This is the historic tail.
 *
 * ── What it will and won't do ───────────────────────────────────────────
 * AUTO-LINKS only on an **exact case-insensitive name match** to exactly one
 * non-deleted venue — the same rule `hirehop-job-sync.ts` uses to link a job's
 * venue, so this introduces no new notion of "same place". That is safe
 * because it changes no text: the quote keeps its `venue_name` and merely
 * gains the `venue_id` that name already implies.
 *
 * It deliberately does NOT fuzzy-match. "Brixton" is not Brixton Academy,
 * "O2" is one of a dozen venues, and a wrong link is worse than no link: the
 * portal would then show the driver a confidently WRONG address, which is the
 * one outcome worse than none. Anything that isn't an exact single match is
 * reported for a human, grouped by name so one decision can cover several
 * quotes.
 *
 * Plenty of the remainder are not venues at all ("client's house", "our
 * warehouse", "TBC", a bare postcode) and should stay as free text forever —
 * that's why the report exists instead of a bulk "create the missing ones".
 *
 * Reads are ordered so the useful end of the report comes last: future-dated
 * quotes are where an address still matters.
 *
 * Usage:
 *   cd backend
 *   npx tsx src/scripts/link-orphan-quote-venues.ts              # dry-run + report
 *   npx tsx src/scripts/link-orphan-quote-venues.ts --commit      # apply exact matches
 *   npx tsx src/scripts/link-orphan-quote-venues.ts --future-only # only quotes still to come
 */
// `config/database` loads dotenv itself as it initialises the pool, and ES
// imports hoist — so there is deliberately no dotenv call here.
import pool, { query } from '../config/database';

const commit = process.argv.includes('--commit');
const futureOnly = process.argv.includes('--future-only');

interface OrphanRow {
  id: string;
  venue_name: string;
  job_type: string;
  job_date: string | null;
  status: string;
  hh_job_number: number | null;
  match_count: string;
  matched_venue_id: string | null;
  matched_venue_name: string | null;
}

function fmt(d: string | null): string {
  return d ? new Date(d).toISOString().split('T')[0] : 'no date';
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  // For each orphan quote, how many non-deleted venues share its name
  // (case-insensitive, trimmed)? 1 = safe to link. 0 = no such venue.
  // >1 = ambiguous duplicates in the venues table; a human picks.
  const orphans = await query(
    `SELECT q.id, TRIM(q.venue_name) AS venue_name, q.job_type, q.job_date, q.status,
            j.hh_job_number,
            (SELECT COUNT(*) FROM venues v
              WHERE v.is_deleted = false
                AND lower(TRIM(v.name)) = lower(TRIM(q.venue_name))) AS match_count,
            (SELECT v.id FROM venues v
              WHERE v.is_deleted = false
                AND lower(TRIM(v.name)) = lower(TRIM(q.venue_name))
              LIMIT 1) AS matched_venue_id,
            (SELECT v.name FROM venues v
              WHERE v.is_deleted = false
                AND lower(TRIM(v.name)) = lower(TRIM(q.venue_name))
              LIMIT 1) AS matched_venue_name
       FROM quotes q
       LEFT JOIN jobs j ON j.id = q.job_id
      WHERE q.is_deleted = false
        AND q.venue_id IS NULL
        AND COALESCE(TRIM(q.venue_name), '') <> ''
        ${futureOnly ? 'AND q.job_date >= CURRENT_DATE' : ''}
      ORDER BY q.job_date ASC NULLS FIRST`,
    []
  );

  const rows = orphans.rows as OrphanRow[];
  console.log(`\n${commit ? 'APPLYING' : 'DRY RUN'} — orphan quote venues${futureOnly ? ' (future-dated only)' : ''}`);
  console.log(`${rows.length} quote(s) with a venue name but no venue link\n`);

  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const exact = rows.filter((r) => Number(r.match_count) === 1);
  const ambiguous = rows.filter((r) => Number(r.match_count) > 1);
  const unmatched = rows.filter((r) => Number(r.match_count) === 0);

  // ── The linkable ones ─────────────────────────────────────────────
  console.log(`── ${exact.length} can be linked automatically (exact single name match) ──`);
  for (const r of exact) {
    console.log(
      `  #${String(r.hh_job_number ?? '—').padEnd(6)} ${r.job_type.padEnd(10)} ` +
      `${fmt(r.job_date).padEnd(10)} ${r.status.padEnd(10)} "${r.venue_name}" → ${r.matched_venue_name}`
    );
  }

  // ── The ones a human has to settle ───────────────────────────────
  if (ambiguous.length > 0) {
    console.log(`\n── ${ambiguous.length} ambiguous — more than one venue has this name ──`);
    console.log('   (duplicate venue records; merge them or pick per quote)');
    for (const r of ambiguous) {
      console.log(
        `  #${String(r.hh_job_number ?? '—').padEnd(6)} ${fmt(r.job_date).padEnd(10)} ` +
        `"${r.venue_name}" — ${r.match_count} matches`
      );
    }
  }

  if (unmatched.length > 0) {
    // Grouped by name: one decision usually covers several quotes, and it
    // makes the "not actually a venue" entries obvious at a glance.
    const byName = new Map<string, OrphanRow[]>();
    for (const r of unmatched) {
      const key = r.venue_name.toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key)!.push(r);
    }
    const groups = [...byName.values()].sort((a, b) => b.length - a.length);

    console.log(`\n── ${unmatched.length} quote(s) across ${groups.length} name(s) with no matching venue ──`);
    console.log('   Nothing is created for these: many are not venues at all ("client\'s house",');
    console.log('   "TBC", a bare postcode) and should stay free text. For the ones that ARE');
    console.log('   venues, open the quote and use the picker\'s "Create venue" — it captures the');
    console.log('   address, which is the whole point of linking.\n');
    for (const g of groups) {
      const future = g.filter((r) => r.job_date && new Date(r.job_date) >= new Date()).length;
      console.log(
        `  ${String(g.length).padStart(3)}×  "${g[0].venue_name}"` +
        (future > 0 ? `   ⚠ ${future} still upcoming` : '')
      );
      for (const r of g) {
        console.log(`         #${String(r.hh_job_number ?? '—').padEnd(6)} ${r.job_type.padEnd(10)} ${fmt(r.job_date)}  ${r.status}`);
      }
    }
  }

  if (!commit) {
    console.log(`\nDry run — nothing changed. Re-run with --commit to link the ${exact.length} exact match(es).`);
    return;
  }

  if (exact.length === 0) {
    console.log('\nNothing to link automatically.');
    return;
  }

  // Link in one statement per quote — small set, and a per-row update keeps
  // the log honest about what moved. `venue_name` is deliberately left as it
  // is: the point is to ADD the link the name already implied, not to rewrite
  // anything a human typed.
  let linked = 0;
  for (const r of exact) {
    const res = await query(
      `UPDATE quotes SET venue_id = $1, updated_at = NOW()
       WHERE id = $2 AND venue_id IS NULL AND is_deleted = false
       RETURNING id`,
      [r.matched_venue_id, r.id]
    );
    if (res.rows.length > 0) linked++;
  }

  console.log(`\nLinked ${linked} quote(s) to an existing venue record.`);
  console.log(`${ambiguous.length + unmatched.length} left for a human — see the report above.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await pool.end();
  });
