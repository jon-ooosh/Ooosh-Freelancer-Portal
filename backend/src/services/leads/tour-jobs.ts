/**
 * Jobs that belong to a lead's tour — "we've already quoted / booked / lost
 * this one". Spec: TOUR-FINDER-SPEC §19. Table: lead_tour_jobs (migration 279).
 *
 * A job is THIS tour's when its dates overlap the tour widened by
 * TOUR_MARGIN_DAYS either side (jon, Oct 2026: bands start or finish in the UK
 * around EU legs, and rehearsals/collections sit before the first date) and:
 *   - AUTO-LINKED: it belongs to the band's matched org (client or any
 *     job_organisations role — the org Hire History set). For a match made via
 *     a management company (`match_via = 'job_name'`), only that company's jobs
 *     NAMED after the band count — the company books other acts too.
 *   - SUGGESTED: it's only NAMED after the band (bandNameRegex) — staff confirm.
 * Staff can also link one by hand, and unlink ('rejected' — never re-linked).
 *
 * An OPEN or BOOKED linked job moves the lead to In pipeline (`liveTourJobSql`
 * — used by STAGE_SQL and the dashboard card). A lost / cancelled / dismissed
 * one leaves it in To review with a quick "Dismiss — already quoted".
 * Linking never changes scoring: the job is already in the band's history once.
 */
import { query } from '../../config/database';
import { JOB_OUTCOME_SQL, JOB_BOOKED_SQL } from '../job-outcomes';
import { bandNameRegex } from './history';
import { logLeadEvent } from './events';

export const TOUR_MARGIN_DAYS = 14;

/** A job's own date span (alias `j`). */
const JOB_START = `COALESCE(j.out_date, j.job_date)::date`;
const JOB_END = `COALESCE(j.return_date, j.job_end, j.job_date, j.out_date)::date`;

/** What became of a tour job, for display (alias `j`). Dismissed enquiries first — it's an overlay on an open status. */
export const TOUR_JOB_OUTCOME_SQL = `CASE
    WHEN j.dismissed_at IS NOT NULL THEN 'dismissed'
    WHEN ${JOB_OUTCOME_SQL.cancelled} THEN 'cancelled'
    WHEN ${JOB_OUTCOME_SQL.lostOnly} THEN 'lost'
    WHEN ${JOB_BOOKED_SQL} THEN 'booked'
    WHEN ${JOB_OUTCOME_SQL.open} THEN 'open'
    ELSE 'other' END`;

/** Does the lead (alias given) have a linked tour job that's still open or booked? */
export function liveTourJobSql(leadAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM lead_tour_jobs ltj JOIN jobs j ON j.id = ltj.job_id
     WHERE ltj.lead_id = ${leadAlias}.id AND ltj.status = 'linked'
       AND j.is_deleted = false AND j.dismissed_at IS NULL
       AND (${JOB_OUTCOME_SQL.open} OR ${JOB_BOOKED_SQL}))`;
}

interface LeadForSync {
  id: string;
  artist_name: string;
  first_date: string | null;
  last_date: string | null;
  matched_organisation_id: string | null;
  match_via: string | null;
  converted_job_id: string | null;
}

/** Jobs whose dates overlap the widened tour. $1 tour first date, $2 last date, $3 margin. */
const OVERLAP = `${JOB_START} IS NOT NULL
  AND ${JOB_START} <= ($2::date + $3::int)
  AND ${JOB_END} >= ($1::date - $3::int)`;

async function candidates(lead: LeadForSync): Promise<{ auto: string[]; named: string[] }> {
  if (!lead.first_date) return { auto: [], named: [] };
  const first = lead.first_date;
  const last = lead.last_date ?? lead.first_date;
  const regex = bandNameRegex(lead.artist_name);
  const own = lead.converted_job_id; // the lead's own enquiry is already linked as such

  let auto: string[] = [];
  if (lead.matched_organisation_id) {
    const scopeRegex = lead.match_via === 'job_name' ? regex : null;
    const r = await query(
      `SELECT j.id FROM jobs j
        WHERE j.is_deleted = false AND COALESCE(j.is_internal, false) = false
          AND (j.client_id = $4 OR j.id IN (SELECT jo.job_id FROM job_organisations jo WHERE jo.organisation_id = $4))
          AND ($5::text IS NULL OR j.job_name ~* $5::text)
          AND j.id IS DISTINCT FROM $6::uuid
          AND ${OVERLAP}`,
      [first, last, TOUR_MARGIN_DAYS, lead.matched_organisation_id, scopeRegex, own],
    );
    auto = r.rows.map((x) => x.id as string);
  }

  let named: string[] = [];
  if (regex) {
    const r = await query(
      `SELECT j.id FROM jobs j
        WHERE j.is_deleted = false AND COALESCE(j.is_internal, false) = false
          AND j.job_name ~* $4::text
          AND j.id IS DISTINCT FROM $5::uuid
          AND ${OVERLAP}`,
      [first, last, TOUR_MARGIN_DAYS, regex, own],
    );
    named = r.rows.map((x) => x.id as string).filter((id) => !auto.includes(id));
  }
  return { auto, named };
}

async function jobLabel(jobId: string): Promise<string> {
  const r = await query(
    `SELECT j.hh_job_number, j.job_name, ${TOUR_JOB_OUTCOME_SQL} AS outcome FROM jobs j WHERE j.id = $1`,
    [jobId],
  );
  const j = r.rows[0];
  if (!j) return 'job';
  return `${j.hh_job_number ? `#${j.hh_job_number} ` : ''}${j.job_name ?? ''} (${j.outcome})`.trim();
}

export interface TourJobSyncResult { linked: number; suggested: number; removed: number; }

/**
 * Bring one lead's automatic links up to date. Hand-made links and staff
 * rejections are never touched; an automatic link whose job no longer fits
 * (dates moved, org unlinked) is dropped.
 */
export async function syncTourJobs(leadId: string): Promise<TourJobSyncResult> {
  const out: TourJobSyncResult = { linked: 0, suggested: 0, removed: 0 };
  const l = await query(
    // Dates as text: node-postgres turns DATE into a local-midnight Date object,
    // and converting that back can shift a day under BST.
    `SELECT id, artist_name, first_date::text AS first_date, last_date::text AS last_date,
            matched_organisation_id, match_via, converted_job_id
       FROM leads WHERE id = $1`,
    [leadId],
  );
  const lead = l.rows[0] as LeadForSync | undefined;
  if (!lead) return out;

  const { auto, named } = await candidates(lead);
  const existing = await query(`SELECT job_id, status, link_type FROM lead_tour_jobs WHERE lead_id = $1`, [leadId]);
  const byJob = new Map(existing.rows.map((r) => [r.job_id as string, r as { status: string; link_type: string }]));

  for (const jobId of auto) {
    const row = byJob.get(jobId);
    if (row?.status === 'rejected' || row?.status === 'linked') continue;
    await query(
      `INSERT INTO lead_tour_jobs (lead_id, job_id, status, link_type) VALUES ($1, $2, 'linked', 'auto')
       ON CONFLICT (lead_id, job_id) DO UPDATE SET status = 'linked', link_type = 'auto', updated_at = NOW()`,
      [leadId, jobId],
    );
    out.linked += 1;
    await logLeadEvent(leadId, 'tour_job_linked', { detail: await jobLabel(jobId) });
  }
  for (const jobId of named) {
    if (byJob.has(jobId)) continue;
    await query(
      `INSERT INTO lead_tour_jobs (lead_id, job_id, status, link_type) VALUES ($1, $2, 'suggested', 'name')
       ON CONFLICT (lead_id, job_id) DO NOTHING`,
      [leadId, jobId],
    );
    out.suggested += 1;
  }
  const keep = new Set([...auto, ...named]);
  for (const [jobId, row] of byJob) {
    if (row.link_type === 'manual' || row.status === 'rejected' || keep.has(jobId)) continue;
    // A 'name' link staff confirmed stays; only unconfirmed suggestions and auto links lapse.
    if (row.link_type === 'name' && row.status === 'linked') continue;
    await query(`DELETE FROM lead_tour_jobs WHERE lead_id = $1 AND job_id = $2`, [leadId, jobId]);
    out.removed += 1;
  }
  return out;
}

/** Every open lead whose tour isn't long over — run after matching on each search / re-process. */
export async function syncAllTourJobs(): Promise<TourJobSyncResult> {
  const total: TourJobSyncResult = { linked: 0, suggested: 0, removed: 0 };
  const leads = await query(
    `SELECT id FROM leads
      WHERE status NOT IN ('dismissed', 'not_relevant')
        AND COALESCE(last_date, first_date) >= CURRENT_DATE - 30`,
  );
  for (const l of leads.rows) {
    try {
      const r = await syncTourJobs(l.id);
      total.linked += r.linked; total.suggested += r.suggested; total.removed += r.removed;
    } catch (err) {
      console.error('[leads/tour-jobs] sync failed for %s:', l.id, err);
    }
  }
  console.log('[leads/tour-jobs] done:', total);
  return total;
}
