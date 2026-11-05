/**
 * The band watch's back catalogue (docs/TOUR-FINDER-SPEC.md §21.8) — bands
 * from past lost, cancelled and completed jobs, looked up on Ticketmaster
 * first, so the ones Ticketmaster knows can be watched in bulk without
 * anyone matching them by hand.
 *
 * Who is on it: per closed job of the last YEARS_BACK years, its Band org,
 * else its client org — never an internal job, an alternative-quote loss, a
 * company-type org (NOT_A_BAND_TYPES), a deleted org, or an org with any watch
 * (watching, or deliberately stopped).
 *
 * The look-up is a background job a manager starts (one to three Ticketmaster
 * calls a band — actSearchNames); its answers are kept in
 * `band_watch_candidates` (migration 333) for 30 days so the list opens fast.
 * It shares the band watch's Ticketmaster lock and never runs beside a lead
 * search.
 */
import { query } from '../../config/database';
import { isTicketmasterConfigured, resetTicketmasterCallBudget } from './ticketmaster';
import { isRunActive } from './pipeline';
import { notAltQuoteLossSql } from '../job-groups';
import {
  findActForName, startWatch, claimTicketmaster, releaseTicketmaster, NOT_A_BAND_TYPES,
  ActLookup, TmCandidate,
} from './band-watch';

/* eslint-disable @typescript-eslint/no-explicit-any */

const YEARS_BACK = 3;
/** A look-up younger than this is reused. */
const FRESH_SQL = `INTERVAL '30 days'`;
/** Bands looked up per run — up to ~4,500 Ticketmaster calls at three names each, inside the day's budget. */
const LOOKUP_RUN_LIMIT = 1400;
/** Bands watched in one click. */
export const WATCH_BATCH_LIMIT = 500;

/** The back catalogue, one row per org. $1 = NOT_A_BAND_TYPES. */
const CANDIDATES_SQL = `
  WITH closed AS (
    SELECT j.id, j.hh_job_number, j.pipeline_status,
           COALESCE(j.job_date, j.out_date, j.lost_at, j.cancelled_at, j.created_at) AS job_at,
           COALESCE(
             (SELECT jo.organisation_id FROM job_organisations jo
                JOIN organisations bo ON bo.id = jo.organisation_id AND bo.is_deleted = false
               WHERE jo.job_id = j.id AND jo.role = 'band'
               ORDER BY jo.is_primary DESC, jo.created_at LIMIT 1),
             j.client_id) AS org_id
      FROM jobs j
     WHERE j.is_deleted = false AND COALESCE(j.is_internal, false) = false
       AND j.pipeline_status IN ('lost', 'cancelled', 'completed')
       AND ${notAltQuoteLossSql('j')}
       AND COALESCE(j.job_date, j.out_date, j.created_at) >= NOW() - INTERVAL '${YEARS_BACK} years'
  )
  SELECT o.id AS organisation_id, o.name, o.type,
         COUNT(*)::int AS jobs,
         COUNT(*) FILTER (WHERE c.pipeline_status = 'completed')::int AS booked,
         COUNT(*) FILTER (WHERE c.pipeline_status = 'lost')::int AS lost,
         COUNT(*) FILTER (WHERE c.pipeline_status = 'cancelled')::int AS cancelled,
         MAX(c.job_at) AS last_job_at,
         (ARRAY_AGG(c.id ORDER BY c.job_at DESC NULLS LAST))[1] AS last_job_id,
         (ARRAY_AGG(c.hh_job_number ORDER BY c.job_at DESC NULLS LAST))[1] AS last_job_number
    FROM closed c
    JOIN organisations o ON o.id = c.org_id AND o.is_deleted = false
   WHERE COALESCE(o.type, '') <> ALL($1::text[])
     AND NOT EXISTS (SELECT 1 FROM band_watches bw WHERE bw.organisation_id = o.id)
   GROUP BY o.id`;

export interface LookupProgress {
  running: boolean;
  done: number;
  total: number;
  started_at: string | null;
  finished_at: string | null;
  /** Why it stopped early, if it did. */
  error: string | null;
}

const progress: LookupProgress = {
  running: false, done: 0, total: 0, started_at: null, finished_at: null, error: null,
};

export function getLookupProgress(): LookupProgress {
  return { ...progress };
}

/** The list, newest job first, with what Ticketmaster said (if looked up yet). */
export async function listBackCatalogue(): Promise<{ rows: any[]; counts: Record<string, number> }> {
  const r = await query(
    `SELECT c.*, bwc.tm_status, bwc.exact_count, bwc.tm_attraction_id, bwc.tm_attraction_name,
            bwc.tm_upcoming, bwc.looked_up_at
       FROM (${CANDIDATES_SQL}) c
       LEFT JOIN band_watch_candidates bwc ON bwc.organisation_id = c.organisation_id
      ORDER BY c.last_job_at DESC NULLS LAST, lower(c.name)`,
    [NOT_A_BAND_TYPES],
  );
  const counts = { total: r.rows.length, known: 0, ambiguous: 0, unknown: 0, not_looked_up: 0 };
  for (const row of r.rows) {
    if (row.tm_status === 'known') counts.known += 1;
    else if (row.tm_status === 'ambiguous') counts.ambiguous += 1;
    else if (row.tm_status === 'unknown') counts.unknown += 1;
    else counts.not_looked_up += 1;
  }
  return { rows: r.rows, counts };
}

async function saveLookup(orgId: string, look: ActLookup): Promise<void> {
  await query(
    `INSERT INTO band_watch_candidates
       (organisation_id, tm_status, exact_count, tm_attraction_id, tm_attraction_name, tm_upcoming, tm_candidates, looked_up_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     ON CONFLICT (organisation_id) DO UPDATE SET
       tm_status = EXCLUDED.tm_status, exact_count = EXCLUDED.exact_count,
       tm_attraction_id = EXCLUDED.tm_attraction_id, tm_attraction_name = EXCLUDED.tm_attraction_name,
       tm_upcoming = EXCLUDED.tm_upcoming, tm_candidates = EXCLUDED.tm_candidates, looked_up_at = NOW()`,
    [orgId, look.status, look.exactCount, look.act?.id ?? null, look.act?.name ?? null,
      look.act?.upcoming ?? null, JSON.stringify(look.candidates)],
  );
}

async function runLookup(): Promise<void> {
  Object.assign(progress, {
    running: true, done: 0, total: 0, started_at: new Date().toISOString(), finished_at: null, error: null,
  });
  try {
    resetTicketmasterCallBudget();
    const due = await query(
      `SELECT c.organisation_id, c.name FROM (${CANDIDATES_SQL}) c
         LEFT JOIN band_watch_candidates bwc ON bwc.organisation_id = c.organisation_id
        WHERE bwc.organisation_id IS NULL OR bwc.looked_up_at < NOW() - ${FRESH_SQL}
        ORDER BY c.last_job_at DESC NULLS LAST
        LIMIT ${LOOKUP_RUN_LIMIT}`,
      [NOT_A_BAND_TYPES],
    );
    progress.total = due.rows.length;
    for (const row of due.rows) {
      // A lead already linked to the band knows its act — no call needed.
      const fromLead = await query(
        `SELECT tm_artist_id, artist_name FROM leads
          WHERE matched_organisation_id = $1 AND COALESCE(tm_artist_id, '') <> ''
            AND COALESCE(match_via, 'org_name') <> 'job_name'
          ORDER BY updated_at DESC LIMIT 1`,
        [row.organisation_id],
      );
      let look: ActLookup | null;
      if (fromLead.rows[0]) {
        const act: TmCandidate = {
          id: fromLead.rows[0].tm_artist_id, name: fromLead.rows[0].artist_name,
          segment: null, genre: null, upcoming: null, url: null, exact: true,
        };
        look = { status: 'known', act, exactCount: 1, candidates: [act], searched: [] };
      } else {
        look = await findActForName(row.name as string);
      }
      if (look === null) {
        progress.error = `Ticketmaster stopped answering after ${progress.done} of ${progress.total} — run it again later to finish`;
        break;
      }
      await saveLookup(row.organisation_id, look);
      progress.done += 1;
    }
  } catch (err) {
    progress.error = err instanceof Error ? err.message : String(err);
    console.error('[back-catalogue] look-up failed:', err);
  } finally {
    progress.running = false;
    progress.finished_at = new Date().toISOString();
    console.log('[back-catalogue] look-up done: %d of %d%s', progress.done, progress.total,
      progress.error ? ` (${progress.error})` : '');
  }
}

/** Start the look-up in the background. Returns why not, or null when started. */
export async function startBackCatalogueLookup(): Promise<string | null> {
  if (!isTicketmasterConfigured()) return 'Ticketmaster isn’t set up on the server';
  if (await isRunActive()) return 'A lead search is running — try again when it finishes';
  const busy = claimTicketmaster('back_catalogue');
  if (busy) return busy.charAt(0).toUpperCase() + busy.slice(1);
  setImmediate(() => {
    runLookup().finally(() => releaseTicketmaster('back_catalogue'));
  });
  return null;
}

/**
 * Watch the chosen bands. Each watch starts from the band's latest closed job
 * and takes its look-up (no second search): known → matched, several acts →
 * "Match these", nothing → 'unknown'. One not looked up yet waits for the next
 * daily run. Orgs no longer on the list (watched meanwhile) are skipped.
 */
export async function watchFromBackCatalogue(
  orgIds: string[],
  userId: string,
): Promise<{ watched: number; skipped: number }> {
  const ids = Array.from(new Set(orgIds)).slice(0, WATCH_BATCH_LIMIT);
  const r = await query(
    `SELECT c.organisation_id, c.last_job_id, bwc.tm_status, bwc.exact_count, bwc.tm_attraction_id,
            bwc.tm_attraction_name, bwc.tm_upcoming, bwc.tm_candidates
       FROM (${CANDIDATES_SQL}) c
       LEFT JOIN band_watch_candidates bwc ON bwc.organisation_id = c.organisation_id
      WHERE c.organisation_id = ANY($2::uuid[])`,
    [NOT_A_BAND_TYPES, ids],
  );
  let watched = 0;
  for (const row of r.rows) {
    let lookup: ActLookup | null = null;
    if (row.tm_status) {
      const act: TmCandidate | null = row.tm_status === 'known' && row.tm_attraction_id
        ? {
          id: row.tm_attraction_id, name: row.tm_attraction_name, segment: null, genre: null,
          upcoming: row.tm_upcoming, url: null, exact: true,
        }
        : null;
      lookup = {
        status: row.tm_status, act, exactCount: Number(row.exact_count) || 0,
        candidates: (row.tm_candidates as TmCandidate[] | null) ?? [], searched: [],
      };
    }
    try {
      await startWatch(row.organisation_id, { jobId: row.last_job_id, userId, lookup, deferLookup: true });
      watched += 1;
    } catch (err) {
      console.error('[back-catalogue] watching %s failed:', row.organisation_id, err);
    }
  }
  return { watched, skipped: ids.length - watched };
}
