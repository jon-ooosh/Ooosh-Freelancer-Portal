/**
 * shop-routing.ts — which jobs a till sale may be put on, and finding them.
 *
 * Step 7 of `docs/SHOP-SALES-SPEC.md`. A sale either pools on the week's shop
 * job (a walk-in) or goes on a real job — almost always a band rehearsing in
 * one of the rooms. Selling onto their job is the preferred path (§5): it can
 * ride an invoice they are already paying, and it takes volume off the shop job.
 *
 * Stock: HireHop only takes sale stock off the shelf once a job is DISPATCHED
 * (§2.1), and jon verified (Sep 2026, job 16749) that a line added to an
 * already-RETURNED job consumes immediately too. Rehearsal jobs are dispatched
 * like any other, so no warning is shown for a job that hasn't been yet.
 *
 * Never offered: cancelled, lost and completed jobs (nothing should be added to
 * a closed job), internal jobs, and the weekly shop jobs themselves — those are
 * never in OP's `jobs` table at all (§3.5). A locked job in HireHop is caught by
 * the drain, which reads the job before pushing (`shop-drain.ts`).
 */
import { query } from '../config/database';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Statuses a sale must never be added to. */
const CLOSED_STATUSES = ['cancelled', 'lost', 'completed'];

export interface SellableJob {
  id: string;
  hhJobNumber: number;
  jobName: string | null;
  pipelineStatus: string | null;
  // The four name fields `frontend/src/lib/jobOrgName.ts` needs — the ONE
  // definition of "whose job is this". The till calls it; nothing here guesses.
  lead_org_name: string | null;
  client_org_name: string | null;
  company_name: string | null;
  client_name: string | null;
  /** Rooms booked, e.g. ["Room 1 · lockout"], for the "in today" list. */
  rooms?: string[];
}

const SELECT_SQL = `
  SELECT j.id, j.hh_job_number, j.job_name, j.pipeline_status,
         j.company_name, j.client_name,
         o.name AS client_org_name,
         (SELECT lo.name FROM job_organisations jo
            JOIN organisations lo ON lo.id = jo.organisation_id
           WHERE jo.job_id = j.id AND jo.is_primary = true LIMIT 1) AS lead_org_name,
         j.hh_derived_flags->'rehearsal_detail'->'rooms' AS rehearsal_rooms
    FROM jobs j
    LEFT JOIN organisations o ON o.id = j.client_id AND o.is_deleted = false`;

const SELLABLE_WHERE = `
      COALESCE(j.is_deleted, false) = false
  AND COALESCE(j.is_internal, false) = false
  AND j.hh_job_number IS NOT NULL
  AND COALESCE(j.pipeline_status, '') <> ALL($1::text[])`;

function toJob(r: any): SellableJob {
  const rooms = Array.isArray(r.rehearsal_rooms)
    ? r.rehearsal_rooms.map((x: any) => `${x.room}${x.flavour && x.flavour !== 'base' ? ` · ${x.flavour}` : ''}`)
    : undefined;
  return {
    id: r.id,
    hhJobNumber: Number(r.hh_job_number),
    jobName: r.job_name ?? null,
    pipelineStatus: r.pipeline_status ?? null,
    lead_org_name: r.lead_org_name ?? null,
    client_org_name: r.client_org_name ?? null,
    company_name: r.company_name ?? null,
    client_name: r.client_name ?? null,
    rooms,
  };
}

/** Today's date in the UK, as the rehearsal session dates are. */
function todayLondon(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

/**
 * The bands in the rehearsal rooms today — the till's one-tap shortlist.
 *
 * Built from the same `rehearsal_detail` the sitter roster uses (derived from
 * the job's room lines in HireHop), so the till and the roster can't disagree
 * about who is in. Day-time AND evening sessions: a daytime band buys gaffa
 * too. Two bands in → two buttons, which is the spec's two-band picker.
 */
export async function listJobsInToday(date: string = todayLondon()): Promise<SellableJob[]> {
  const r = await query(
    `${SELECT_SQL}
      WHERE ${SELLABLE_WHERE}
        AND jsonb_array_length(COALESCE(j.hh_derived_flags->'rehearsal_detail'->'rooms', '[]'::jsonb)) > 0
        AND (j.hh_derived_flags->'rehearsal_detail'->>'first_session_date') <= $2
        AND (j.hh_derived_flags->'rehearsal_detail'->>'last_session_date') >= $2
      ORDER BY j.hh_job_number`,
    [CLOSED_STATUSES, date],
  );
  return r.rows.map(toJob);
}

/**
 * Find any open job by HireHop number, job name or client/band name. For the
 * band that isn't in a room today — collecting a van, say, and adding strings.
 */
export async function searchSellableJobs(q: string, limit = 10): Promise<SellableJob[]> {
  const term = q.trim();
  if (term.length < 2) return [];
  const cap = Math.min(Math.max(limit, 1), 25);
  const asNumber = /^\d+$/.test(term) ? Number(term) : null;
  const r = await query(
    `${SELECT_SQL}
      WHERE ${SELLABLE_WHERE}
        AND (
              ($2::int IS NOT NULL AND j.hh_job_number = $2::int)
           OR j.job_name ILIKE $3 OR j.client_name ILIKE $3 OR j.company_name ILIKE $3
           OR o.name ILIKE $3
           OR EXISTS (SELECT 1 FROM job_organisations jo
                        JOIN organisations lo ON lo.id = jo.organisation_id
                       WHERE jo.job_id = j.id AND lo.name ILIKE $3)
        )
      ORDER BY (j.hh_job_number = $2::int) DESC NULLS LAST, j.job_date DESC NULLS LAST
      LIMIT $4`,
    [CLOSED_STATUSES, asNumber, `%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, cap],
  );
  return r.rows.map(toJob);
}

/**
 * Can a sale be put on this job? Throws a message the operator can act on.
 * Checked when the sale is recorded, so a closed job is refused at the counter
 * rather than discovered by the drain after the customer has gone.
 */
export async function assertSellableJob(jobId: string): Promise<void> {
  const r = await query(
    `SELECT hh_job_number, pipeline_status, COALESCE(is_deleted, false) AS is_deleted,
            COALESCE(is_internal, false) AS is_internal
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  const j = r.rows[0];
  if (!j || j.is_deleted) throw new Error('That job no longer exists — sell it as a walk-in.');
  if (!j.hh_job_number) throw new Error('That job has no HireHop job number yet.');
  if (j.is_internal) throw new Error('That is an internal job — record it as "Used for Ooosh" instead.');
  if (CLOSED_STATUSES.includes(j.pipeline_status)) {
    throw new Error(`That job is ${j.pipeline_status} — sell it as a walk-in instead.`);
  }
}
