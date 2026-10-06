/**
 * What OP already knows about a matched act — the client history a warm lead
 * carries. Feeds two things:
 *   - the AI scorer, so a band that has turned down ten quotes scores down and
 *     a repeat booker scores up (jon, Oct 2026: "if we've quoted ten jobs and
 *     they've declined them all, probably not much point sending an 11th");
 *   - the lead row, so staff see the same picture the AI weighed.
 *
 * Outcome buckets come from `services/job-outcomes.ts` — the same definitions
 * as the org Hire History tab.
 *
 * Which jobs count depends on HOW the lead matched (`leads.match_via`):
 *   - 'org_name' / 'created' / confirmed: every job linked to the org (client
 *     or any job_organisations role) — the org IS the band.
 *   - 'job_name': the org is a management / agency company that books several
 *     acts, so only ITS jobs named after this band count — the rest of that
 *     company's work isn't this band's history.
 */
import { query } from '../../config/database';
import { JOB_OUTCOME_SQL, JOB_BOOKED_SQL } from '../job-outcomes';
import { normaliseArtist } from './normalise';

/** A lost reason that isn't really a loss: we re-quoted and THAT one booked. */
const SUPERSEDED_REASON = 'Confirmed Alternative Quote (from us)';

/**
 * Outreach that got no reply — not a quote they turned down (jon, Oct 2026).
 * WE started it (a Cold-lead enquiry, or any enquiry made from a lead) and it
 * was closed as "No Decision" — what the 09:00 stale-enquiry auto-loser writes
 * when nobody answers. Counted separately, never as a loss. A lead-made
 * enquiry lost for a real reason (Price, Competitor…) is still a loss.
 */
const OUTREACH_NO_REPLY_SQL = `(${JOB_OUTCOME_SQL.lostOnly}
  AND j.lost_reason = 'No Decision'
  AND (j.enquiry_source = 'cold_lead' OR EXISTS (SELECT 1 FROM leads ld WHERE ld.converted_job_id = j.id)))`;

export interface ClientHistory {
  org_id: string;
  org_name: string;
  scope: 'org' | 'band_jobs';
  /** Enquiries, NOT counting unanswered outreach (that's outreach_no_reply). */
  enquiries: number;
  booked: number;
  open: number;
  lost: number;
  cancelled: number;
  /** Our cold outreach that got no reply — shown, but not a loss. */
  outreach_no_reply: number;
  lost_reasons: { reason: string; count: number }[];
  last_enquiry: string | null;
  last_booked: string | null;
  booked_value: number;
  retros: { great: number; ok: number; issues: number };
  do_not_hire: boolean;
  working_terms: string | null;
}

/**
 * Postgres regex (ARE) that finds the band's name as whole words in a job
 * name — "Wedding Present" matches "The Wedding Present - UK Tour" but not
 * "Wedding Presents Ltd". Null when the name is too short to search safely
 * ("Ride", "Yes" would match half the job book).
 */
export function bandNameRegex(artistName: string): string | null {
  const words = normaliseArtist(artistName).split(' ').filter(Boolean);
  if (words.join('').length < 5) return null;
  return `\\m(the[^a-z0-9]+)?${words.join('[^a-z0-9]+')}\\M`;
}

function isoDate(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export async function getClientHistory(
  orgId: string,
  opts: { matchVia: string | null; artistName: string },
): Promise<ClientHistory | null> {
  const org = await query(
    `SELECT id, name, do_not_hire, working_terms_type FROM organisations WHERE id = $1`,
    [orgId],
  );
  if (!org.rows[0]) return null;

  const regex = opts.matchVia === 'job_name' ? bandNameRegex(opts.artistName) : null;
  const scope: ClientHistory['scope'] = regex ? 'band_jobs' : 'org';
  // $1 org, $2 band-name regex (NULL = whole org), $3 the superseded lost
  // reason — only the queries that read lost_reason pass $3.
  const base: unknown[] = [orgId, regex];
  const withReason: unknown[] = [orgId, regex, SUPERSEDED_REASON];

  // Same job set as the org Hire History tab (client_id OR any job_organisations
  // role), minus Ooosh's own internal jobs.
  const jobSet = `
    WITH lead_jobs AS (
      SELECT j.* FROM jobs j
       WHERE j.is_deleted = false AND COALESCE(j.is_internal, false) = false
         AND (j.client_id = $1 OR j.id IN (SELECT jo.job_id FROM job_organisations jo WHERE jo.organisation_id = $1))
         AND ($2::text IS NULL OR j.job_name ~* $2::text)
    )`;

  const stats = await query(
    `${jobSet}
     SELECT
       COUNT(*) FILTER (WHERE NOT ${OUTREACH_NO_REPLY_SQL})::int AS enquiries,
       COUNT(*) FILTER (WHERE ${OUTREACH_NO_REPLY_SQL})::int AS outreach_no_reply,
       COUNT(*) FILTER (WHERE ${JOB_BOOKED_SQL})::int AS booked,
       COUNT(*) FILTER (WHERE ${JOB_OUTCOME_SQL.open})::int AS open,
       COUNT(*) FILTER (WHERE ${JOB_OUTCOME_SQL.lostOnly} AND COALESCE(j.lost_reason, '') <> $3::text AND NOT ${OUTREACH_NO_REPLY_SQL})::int AS lost,
       COUNT(*) FILTER (WHERE ${JOB_OUTCOME_SQL.cancelled})::int AS cancelled,
       MAX(j.created_at) AS last_enquiry,
       MAX(COALESCE(j.job_date, j.out_date)) FILTER (WHERE ${JOB_BOOKED_SQL}) AS last_booked,
       COALESCE(SUM(j.job_value) FILTER (WHERE ${JOB_BOOKED_SQL}), 0)::float AS booked_value
     FROM lead_jobs j`,
    withReason,
  );

  const reasons = await query(
    `${jobSet}
     SELECT COALESCE(NULLIF(TRIM(j.lost_reason), ''), 'No reason given') AS reason, COUNT(*)::int AS count
       FROM lead_jobs j
      WHERE ${JOB_OUTCOME_SQL.lostOnly} AND COALESCE(j.lost_reason, '') <> $3::text
        AND NOT ${OUTREACH_NO_REPLY_SQL}
      GROUP BY 1 ORDER BY 2 DESC`,
    withReason,
  );

  const retros = await query(
    `${jobSet}
     SELECT
       COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Great%')::int AS great,
       COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: OK%')::int AS ok,
       COUNT(*) FILTER (WHERE i.content LIKE 'Job retro: Issues%')::int AS issues
     FROM lead_jobs j
     JOIN interactions i ON i.job_id = j.id AND i.content LIKE 'Job retro:%'`,
    base,
  );

  const s = stats.rows[0] ?? {};
  const o = org.rows[0];
  return {
    org_id: orgId,
    org_name: o.name as string,
    scope,
    enquiries: s.enquiries ?? 0,
    booked: s.booked ?? 0,
    open: s.open ?? 0,
    lost: s.lost ?? 0,
    cancelled: s.cancelled ?? 0,
    outreach_no_reply: s.outreach_no_reply ?? 0,
    lost_reasons: reasons.rows.map((r) => ({ reason: r.reason as string, count: r.count as number })),
    last_enquiry: isoDate(s.last_enquiry),
    last_booked: isoDate(s.last_booked),
    booked_value: Math.round(Number(s.booked_value) || 0),
    retros: {
      great: retros.rows[0]?.great ?? 0,
      ok: retros.rows[0]?.ok ?? 0,
      issues: retros.rows[0]?.issues ?? 0,
    },
    do_not_hire: Boolean(o.do_not_hire),
    working_terms: (o.working_terms_type as string | null) ?? null,
  };
}

/**
 * One plain-English line — shown on the lead and given to the AI scorer.
 * e.g. "Via Big Mgmt Ltd (jobs named after the band): 10 enquiries — 0 booked,
 * 9 lost (Price ×6, No Decision ×3), 1 open. Last enquiry 2025-11-02."
 */
export function describeHistory(h: ClientHistory): string {
  const bits: string[] = [];
  const via = h.scope === 'band_jobs' ? `Via ${h.org_name} (jobs named after the band)` : `As ${h.org_name}`;
  // Older stored snapshots predate this field.
  const noReply = h.outreach_no_reply ?? 0;
  const noReplyLine = noReply
    ? `${noReply} cold outreach${noReply === 1 ? '' : 'es'} from us with no reply (not counted as lost).`
    : null;
  if (h.enquiries === 0) {
    bits.push(noReply
      ? `${via}: no enquiries or hires on record; ${noReplyLine}`
      : `${via}: in the address book, but no enquiries or hires on record.`);
  } else {
    const parts = [`${h.booked} booked`];
    if (h.lost) {
      const why = h.lost_reasons.map((r) => `${r.reason} ×${r.count}`).join(', ');
      parts.push(`${h.lost} lost${why ? ` (${why})` : ''}`);
    }
    if (h.cancelled) parts.push(`${h.cancelled} cancelled after booking`);
    if (h.open) parts.push(`${h.open} still open`);
    bits.push(`${via}: ${h.enquiries} enquir${h.enquiries === 1 ? 'y' : 'ies'} — ${parts.join(', ')}.`);
    if (noReplyLine) bits.push(noReplyLine.charAt(0).toUpperCase() + noReplyLine.slice(1));
    if (h.last_booked) bits.push(`Last booked ${h.last_booked}${h.booked_value ? ` (booked total ~£${h.booked_value.toLocaleString('en-GB')})` : ''}.`);
    if (h.last_enquiry) bits.push(`Last enquiry ${h.last_enquiry}.`);
    const r = h.retros;
    if (r.great + r.ok + r.issues > 0) bits.push(`Retros: ${r.great} great, ${r.ok} OK, ${r.issues} with issues.`);
  }
  if (h.do_not_hire) bits.push('⚠ Flagged Do Not Hire.');
  if (h.working_terms) bits.push(`Working terms: ${h.working_terms}.`);
  return bits.join(' ');
}
