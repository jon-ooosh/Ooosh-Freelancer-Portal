/**
 * Quote options — alternative quotes for ONE enquiry, as a group of jobs
 * (docs/QUOTE-VERSIONS-SPEC.md; "version" there is "option" here — jon, Oct 2026,
 * because OP already has "quote versions": the quote-PDF revisions of ONE job on
 * the Activity Timeline, `services/quote-versions.ts`. Different thing.)
 *
 * One option = one OP job + one HireHop job, always — every option has to go out
 * to the client as a HireHop quote, and the portal link carries the HireHop job
 * number, so paying a link IS picking an option. The group is a thin layer: a
 * member keeps every behaviour an ordinary job has (status, money, requirements,
 * chase, sync). `jobs.group_id / option_no / option_label` are the only additions.
 *
 * The whole module is PRE-CONFIRMATION (jon, 12 Oct 2026): options are added
 * while the client is choosing; once one confirms the rest are marked lost
 * ('Confirmed Alternative Quote (from us)') by a human and the group is history.
 * A confirmed job never gets a new option.
 *
 * This file owns: the "(Option N)" name suffix, option numbering, the lead rule,
 * the group reads, and the OP-side copy. The routes (`routes/pipeline.ts`
 * "QUOTE OPTIONS") own the HireHop calls and the transactions.
 */
import type { PoolClient } from 'pg';
import { query } from '../config/database';
import { PRE_CONFIRMED_STATUSES } from './pipeline-stage';

export const OPTION_GROUP_KIND = 'alternative';

// ── The "(Option N)" job-name suffix ────────────────────────────────────────
// Lives in the REAL job_name so HireHop, every quote PDF and every email agree.
// The Job Detail header renders it as a pill (frontend lib/quoteOptions.ts).

const OPTION_SUFFIX_RE = /\s*\(Option\s+(\d+)\)\s*$/i;

export function stripOptionSuffix(name: string | null | undefined): string {
  return String(name ?? '').replace(OPTION_SUFFIX_RE, '').trim();
}

export function withOptionSuffix(name: string | null | undefined, optionNo: number): string {
  const base = stripOptionSuffix(name) || 'Job';
  return `${base} (Option ${optionNo})`;
}

/** The option number a name carries, if any. */
export function optionNoFromName(name: string | null | undefined): number | null {
  const m = String(name ?? '').match(OPTION_SUFFIX_RE);
  return m ? parseInt(m[1], 10) : null;
}

// ── Lead option (spec §6.3) ─────────────────────────────────────────────────
// The lead is what the Kanban card and any roll-up read. Pinned (group.lead_job_id)
// wins; otherwise the most progressed live member, tie → lowest option_no.
// Lost / cancelled never lead while a live member exists.

const PROGRESSION_ORDER: string[] = [
  'paused', 'new_enquiry', 'quoting', 'provisional', 'confirmed', 'prepping', 'prepped',
  'dispatched', 'returned_incomplete', 'returned', 'completed',
];
const DEAD_STATUSES = new Set(['lost', 'cancelled']);

export function resolveLeadJob<T extends { id: string; option_no: number | null; pipeline_status: string | null }>(
  members: T[],
  pinnedLeadId: string | null | undefined,
): T | null {
  if (members.length === 0) return null;
  if (pinnedLeadId) {
    const pinned = members.find((m) => m.id === pinnedLeadId);
    if (pinned) return pinned;
  }
  const rank = (m: T) => {
    const s = m.pipeline_status || '';
    if (DEAD_STATUSES.has(s)) return -1;
    const i = PROGRESSION_ORDER.indexOf(s);
    return i === -1 ? 0 : i;
  };
  return [...members].sort((a, b) => {
    const d = rank(b) - rank(a);
    if (d !== 0) return d;
    return (a.option_no ?? 0) - (b.option_no ?? 0);
  })[0];
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface JobGroupRow {
  id: string;
  kind: string;
  label: string | null;
  lead_job_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobGroupMemberRow {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  option_no: number | null;
  option_label: string | null;
  pipeline_status: string | null;
  status: number | null;
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  job_value: number | null;
  next_chase_date: string | null;
  is_chasing: boolean;
  lost_reason: string | null;
  dismissed_at: string | null;
  is_van_and_driver: boolean | null;
  is_lead: boolean;
}

const MEMBER_SELECT = `
  SELECT j.id, j.hh_job_number, j.job_name, j.option_no, j.option_label,
         j.pipeline_status, j.status,
         j.out_date, j.job_date, j.job_end, j.return_date,
         j.job_value, j.next_chase_date,
         (j.next_chase_date IS NOT NULL AND j.next_chase_date <= CURRENT_DATE
          AND j.pipeline_status = ANY($2::text[])) AS is_chasing,
         j.lost_reason, j.dismissed_at, j.is_van_and_driver
    FROM jobs j
   WHERE j.group_id = $1 AND j.is_deleted = false
   ORDER BY j.option_no ASC NULLS LAST, j.created_at ASC`;

export async function getGroupById(groupId: string): Promise<{ group: JobGroupRow; members: JobGroupMemberRow[] } | null> {
  const g = await query(`SELECT * FROM job_groups WHERE id = $1`, [groupId]);
  if (g.rows.length === 0) return null;
  const group = g.rows[0] as JobGroupRow;
  const m = await query(MEMBER_SELECT, [groupId, PRE_CONFIRMED_STATUSES]);
  const rows = m.rows as Omit<JobGroupMemberRow, 'is_lead'>[];
  const lead = resolveLeadJob(rows, group.lead_job_id);
  const members = rows.map((r) => ({ ...r, is_lead: !!lead && lead.id === r.id }));
  return { group, members };
}

/** The next free option number in a group (MAX + 1). Never reuses a removed number. */
export async function nextOptionNo(client: PoolClient, groupId: string): Promise<number> {
  const r = await client.query(
    `SELECT COALESCE(MAX(option_no), 0) + 1 AS n FROM jobs WHERE group_id = $1`,
    [groupId],
  );
  return Number(r.rows[0].n);
}

// ── Eligibility ─────────────────────────────────────────────────────────────

export interface OptionEligibilityJob {
  pipeline_status: string | null;
  dismissed_at?: string | null;
  combined_into_job_id?: string | null;
  is_deleted?: boolean;
}

/**
 * Why this job can't take (or be) an option — null when it can. The whole
 * module is pre-confirmation, so a confirmed job never gets one.
 */
export function optionRefusalReason(job: OptionEligibilityJob): string | null {
  if (job.is_deleted) return 'This job has been deleted.';
  if (job.dismissed_at) return 'This enquiry has been dismissed.';
  if (job.combined_into_job_id) return 'This booking was combined into another booking.';
  if (!PRE_CONFIRMED_STATUSES.includes(job.pipeline_status || '')) {
    return 'Options are for enquiries the client is still choosing between — this job is past that point.';
  }
  return null;
}

// ── The OP-side copy (spec §5.3 step 2) ─────────────────────────────────────

export interface OptionDates {
  out_date: string | null;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
}

/**
 * INSERT the new option as a copy of the source job. Copied: client, venue,
 * managers, staff overrides (van & driver, self-drive count, internal), the
 * chase cadence (same next_chase_date so they chase together), details/notes,
 * tags, email routing, plus job_organisations and job_contacts rows.
 * NOT copied: pipeline_status (starts `quoting`), HireHop-owned data
 * (line_items, derived flags, requirements — the sync fills them), anything
 * money-related, files, interactions, dismissal.
 */
export async function insertOptionCopy(
  client: PoolClient,
  source: Record<string, any>,
  opts: {
    groupId: string;
    optionNo: number;
    optionLabel: string;
    hhJobNumber: number | null;
    dates: OptionDates;
    actorId: string;
  },
): Promise<Record<string, any>> {
  const jobName = withOptionSuffix(source.job_name, opts.optionNo);
  const inserted = await client.query(
    `INSERT INTO jobs (
       hh_job_number, job_name, job_type,
       client_id, client_name, company_name, client_ref, client_locked_at,
       venue_id, venue_name, address,
       out_date, job_date, job_end, return_date,
       out_time, start_time, return_time, end_time,
       manager1_name, manager1_person_id, manager2_name, manager2_person_id,
       details, notes, depot_name, tags,
       enquiry_source, likelihood, is_internal,
       is_van_and_driver, self_drive_van_override, email_routing,
       chase_interval_days, next_chase_date,
       status, status_name, pipeline_status, pipeline_status_changed_at,
       group_id, option_no, option_label,
       created_by
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6, $7, $8,
       $9, $10, $11,
       $12, $13, $14, $15,
       $16, $17, $18, $19,
       $20, $21, $22, $23,
       $24, $25, $26, $27,
       $28, $29, $30,
       $31, $32, $33,
       $34, $35,
       0, 'Enquiry', 'quoting', NOW(),
       $36, $37, $38,
       $39
     ) RETURNING *`,
    [
      opts.hhJobNumber, jobName, source.job_type,
      source.client_id, source.client_name, source.company_name, source.client_ref, source.client_locked_at,
      source.venue_id, source.venue_name, source.address,
      opts.dates.out_date, opts.dates.job_date, opts.dates.job_end, opts.dates.return_date,
      source.out_time, source.start_time, source.return_time, source.end_time,
      source.manager1_name, source.manager1_person_id, source.manager2_name, source.manager2_person_id,
      source.details, source.notes, source.depot_name, source.tags ?? [],
      source.enquiry_source, source.likelihood, source.is_internal ?? false,
      source.is_van_and_driver ?? false, source.self_drive_van_override,
      JSON.stringify(source.email_routing ?? {}),
      source.chase_interval_days, source.next_chase_date,
      opts.groupId, opts.optionNo, opts.optionLabel,
      opts.actorId,
    ],
  );
  const job = inserted.rows[0];

  // Band, promoter, management… the same cast on every option.
  await client.query(
    `INSERT INTO job_organisations (job_id, organisation_id, role, is_primary, notes, created_by)
     SELECT $1, organisation_id, role, is_primary, notes, created_by
       FROM job_organisations WHERE job_id = $2
     ON CONFLICT DO NOTHING`,
    [job.id, source.id],
  );
  // Per-job contacts, primary flag included (jobs.email_routing was copied above).
  await client.query(
    `INSERT INTO job_contacts (job_id, person_id, role_override, is_primary, notes, created_by)
     SELECT $1, person_id, role_override, is_primary, notes, created_by
       FROM job_contacts WHERE job_id = $2
     ON CONFLICT DO NOTHING`,
    [job.id, source.id],
  );
  return job;
}

/** A system note on a job's timeline (the group's own audit trail). */
export async function noteOnTimeline(
  client: PoolClient | null,
  jobId: string,
  content: string,
  actorId: string,
  pipelineStatus: string | null,
): Promise<void> {
  const q = client ? client.query.bind(client) : query;
  await q(
    `INSERT INTO interactions (type, content, job_id, created_by, pipeline_status_at_creation, source)
     VALUES ('note', $1, $2, $3, $4, 'system')`,
    [content, jobId, actorId, pipelineStatus || 'quoting'],
  );
}

/** "#16412" when linked to HireHop, else a short OP id — for timeline notes. */
export function jobRef(job: { hh_job_number: number | null; id: string }): string {
  return job.hh_job_number ? `#${job.hh_job_number}` : job.id.slice(0, 8);
}
