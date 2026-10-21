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

/**
 * The lost reason for an option the client didn't pick (migration 191 renamed it so
 * "Competitor" keeps meaning the alternative came from someone else). NOT lost
 * revenue — win/loss stats and Fill-a-Gap exclude it (spec §8).
 */
export const ALTERNATIVE_QUOTE_LOST_REASON = 'Confirmed Alternative Quote (from us)';

/** SQL: this job's loss is a real loss, not an option the client didn't pick. */
export function notAltQuoteLossSql(alias = 'j'): string {
  return `(${alias}.lost_reason IS DISTINCT FROM '${ALTERNATIVE_QUOTE_LOST_REASON}')`;
}

/**
 * SQL: how many options this job's group holds (lost ones included — they were
 * quoted), or NULL when the job is in no group. Read next to `option_no` for the
 * "Option 2 of 3" tag on global search and Hire History (spec §6.5). `alias` must
 * expose `group_id`.
 */
export function optionCountSql(alias = 'j'): string {
  return `(CASE WHEN ${alias}.group_id IS NOT NULL THEN
             (SELECT COUNT(*)::int FROM jobs og WHERE og.group_id = ${alias}.group_id AND og.is_deleted = false)
           END)`;
}

/**
 * SQL for a job_name write from an INBOUND HireHop name that keeps the "(Option N)"
 * suffix when HireHop dropped it (staff renamed the job in HH). `param` is the
 * placeholder holding the inbound name, e.g. '$1' — cast to text on every use so
 * the varchar column assignment and the regex don't fight over its type (42P08).
 */
export function jobNameKeepingOptionSuffixSql(param: string): string {
  const p = `${param}::text`;
  return `CASE WHEN option_no IS NOT NULL AND ${p} !~* '\\(Option\\s+\\d+\\)\\s*$'
               THEN ${p} || ' (Option ' || option_no || ')'
          ELSE ${p} END`;
}

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

// new_enquiry and quoting share a rank: they are the same Kanban column, and a
// fresh copy must not out-rank its source just because it was born `quoting`
// (seen live, 13 Oct 2026 — Option 2 took the star off Option 1).
const PROGRESSION_ORDER: string[][] = [
  ['paused'], ['new_enquiry', 'quoting'], ['provisional'], ['confirmed'], ['prepping'], ['prepped'],
  ['dispatched'], ['returned_incomplete'], ['returned'], ['completed'],
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
    const i = PROGRESSION_ORDER.findIndex((tier) => tier.includes(s));
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
  start_time: string | null;
  end_time: string | null;
  /** "Self-drive ×1 · + rehearsal" from hh_derived_flags; null until synced. */
  config: string | null;
  /** Physical kind=2 lines on the HireHop job — the Twin counts, so does a cable. */
  items_count: number;
  item_names: string[];
  is_lead: boolean;
}

/** Spec §6.2 "Config" column, from the HireHop-derived flags. */
function describeConfig(flags: Record<string, unknown> | null | undefined, isVanAndDriver: boolean | null): string | null {
  if (!flags) return isVanAndDriver ? 'Van + driver' : null;
  const parts: string[] = [];
  const sd = Number(flags.self_drive_count ?? 0);
  const vd = Number(flags.van_and_driver_count ?? 0);
  if (sd > 0) parts.push(`Self-drive${sd > 1 ? ` ×${sd}` : ''}`);
  if (vd > 0) parts.push(`Van + driver${vd > 1 ? ` ×${vd}` : ''}`);
  if (parts.length === 0 && isVanAndDriver) parts.push('Van + driver');
  if (flags.has_rehearsal) parts.push('+ rehearsal');
  if (Number(flags.crew_item_count ?? 0) > 0) parts.push('+ crew');
  if (Number(flags.backline_item_count ?? 0) > 0) parts.push('+ backline');
  return parts.length ? parts.join(' · ') : null;
}

function physicalItems(lineItems: unknown): { count: number; names: string[] } {
  if (!Array.isArray(lineItems)) return { count: 0, names: [] };
  const rows = lineItems.filter((li) => li && Number((li as any).kind ?? 2) === 2 && !(li as any).VIRTUAL);
  const names = rows.map((li) => {
    const q = Number((li as any).QUANTITY ?? 1);
    return `${q > 1 ? `${q}× ` : ''}${String((li as any).ITEM_NAME ?? '')}`.trim();
  }).filter(Boolean);
  return { count: rows.length, names };
}

const MEMBER_SELECT = `
  SELECT j.id, j.hh_job_number, j.job_name, j.option_no, j.option_label,
         j.pipeline_status, j.status,
         j.out_date, j.job_date, j.job_end, j.return_date,
         j.job_value, j.next_chase_date,
         (j.next_chase_date IS NOT NULL AND j.next_chase_date <= CURRENT_DATE
          AND j.pipeline_status = ANY($2::text[])) AS is_chasing,
         j.lost_reason, j.dismissed_at, j.is_van_and_driver,
         j.start_time, j.end_time, j.hh_derived_flags, j.line_items
    FROM jobs j
   WHERE j.group_id = $1 AND j.is_deleted = false
   ORDER BY j.option_no ASC NULLS LAST, j.created_at ASC`;

export async function getGroupById(groupId: string): Promise<{ group: JobGroupRow; members: JobGroupMemberRow[] } | null> {
  const g = await query(`SELECT * FROM job_groups WHERE id = $1`, [groupId]);
  if (g.rows.length === 0) return null;
  const group = g.rows[0] as JobGroupRow;
  const m = await query(MEMBER_SELECT, [groupId, PRE_CONFIRMED_STATUSES]);
  const lead = resolveLeadJob(m.rows as Array<{ id: string; option_no: number | null; pipeline_status: string | null }>, group.lead_job_id);
  const members: JobGroupMemberRow[] = m.rows.map((r) => {
    const { hh_derived_flags, line_items, ...rest } = r;
    const items = physicalItems(line_items);
    return {
      ...(rest as Omit<JobGroupMemberRow, 'is_lead' | 'config' | 'items_count' | 'item_names'>),
      config: describeConfig(hh_derived_flags, r.is_van_and_driver),
      items_count: items.count,
      item_names: items.names,
      is_lead: !!lead && lead.id === r.id,
    };
  });
  return { group, members };
}

/**
 * "Count a group once": the ids of grouped jobs that are NOT their group's lead.
 * Headline counts and pipeline values exclude them (`NOT (id = ANY($n::uuid[]))`),
 * so a client asking for four options is one enquiry, not four. Per-job lists
 * stay per-job (spec §6.4). Cheap: only jobs with a group_id are read.
 */
export async function nonLeadMemberIds(): Promise<string[]> {
  const r = await query(
    `SELECT id, group_id, option_no, pipeline_status,
            (SELECT lead_job_id FROM job_groups g WHERE g.id = jobs.group_id) AS pinned
       FROM jobs WHERE group_id IS NOT NULL AND is_deleted = false`,
  );
  const byGroup = new Map<string, typeof r.rows>();
  for (const row of r.rows) {
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row);
    byGroup.set(row.group_id, list);
  }
  const out: string[] = [];
  for (const members of byGroup.values()) {
    const lead = resolveLeadJob(members, members[0]?.pinned ?? null);
    for (const m of members) if (!lead || m.id !== lead.id) out.push(m.id);
  }
  return out;
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
       $34::int, COALESCE($35::date, (CURRENT_DATE + (COALESCE($34::int, 5) || ' days')::interval)::date),
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

/**
 * The new job number out of a HireHop job_duplicate.php reply. HireHop answers
 * with the NEW job's data — `{ ID: '16843', JOB_NAME, JOB_DATE, … }` (proven
 * live, 13 Oct 2026). Re-open had assumed `{ job: N }` and never got a number
 * back. Accepts the other shapes it could plausibly use.
 */
export function readDuplicatedJobNumber(data: unknown): number | null {
  if (data == null) return null;
  if (typeof data === 'number' || typeof data === 'string') {
    const n = parseInt(String(data), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  for (const key of ['ID', 'id', 'job', 'JOB', 'NUMBER', 'number', 'job_id', 'JOB_ID', 'new_job', 'new_id']) {
    const v = d[key];
    if (v == null || v === '') continue;
    const n = parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** The still-open (pre-confirmation, not dismissed) options of this job's group, other than itself. */
export async function liveSiblingOptions(jobId: string): Promise<Array<{ id: string; option_no: number | null; option_label: string | null; hh_job_number: number | null }>> {
  const r = await query(
    `SELECT s.id, s.option_no, s.option_label, s.hh_job_number
       FROM jobs j
       JOIN jobs s ON s.group_id = j.group_id AND s.id <> j.id AND s.is_deleted = false
      WHERE j.id = $1 AND j.group_id IS NOT NULL
        AND s.dismissed_at IS NULL
        AND s.pipeline_status = ANY($2::text[])
      ORDER BY s.option_no`,
    [jobId, PRE_CONFIRMED_STATUSES],
  );
  return r.rows;
}

/**
 * One phone call covers the whole enquiry (spec §8): a contact logged on ANY
 * option pushes every live sibling's chase date too — under the sacred-future
 * rule, so a sibling's deliberately later date is never shortened. `chosen` is
 * the date staff picked on a logged chase, else the sibling's own interval.
 */
export async function bumpSiblingChaseDates(jobId: string, chosen: string | null): Promise<number> {
  const r = await query(
    `UPDATE jobs s SET
       next_chase_date = CASE
         WHEN s.next_chase_date IS NULL OR s.next_chase_date <= CURRENT_DATE
           THEN COALESCE($2::date, (CURRENT_DATE + (COALESCE(s.chase_interval_days, 5) || ' days')::interval)::date)
         ELSE s.next_chase_date END,
       last_chased_at = NOW(),
       updated_at = NOW()
      FROM jobs j
     WHERE j.id = $1 AND j.group_id IS NOT NULL
       AND s.group_id = j.group_id AND s.id <> j.id AND s.is_deleted = false
       AND s.dismissed_at IS NULL
       AND s.pipeline_status = ANY($3::text[])`,
    [jobId, chosen, PRE_CONFIRMED_STATUSES],
  );
  return r.rowCount ?? 0;
}

// ── The payment portal (spec §9) ────────────────────────────────────────────
// Paying a link IS choosing an option, so the portal needs to know two things
// about the job behind a link: may it still be paid, and what are its siblings.
// `payable` is false for a lost / cancelled job and for a live option whose
// sibling has already confirmed — the client has chosen; this link is stale.
// Completed jobs stay payable (post-completion charges are paid through the
// portal too), which differs from the spec's first draft on purpose.

export interface PortalOptionsInfo {
  payable: boolean;
  not_payable_reason: 'lost' | 'cancelled' | 'confirmed_sibling' | null;
  confirmed_sibling: { hh_job_number: number | null; option_no: number | null; option_label: string | null } | null;
  version_group: {
    label: string | null;
    this: { option_no: number | null; option_label: string | null };
    siblings: Array<{ hh_job_number: number | null; option_no: number | null; option_label: string | null; pipeline_status: string | null }>;
  } | null;
}

export async function portalOptionsFor(jobId: string): Promise<PortalOptionsInfo> {
  const r = await query(
    `SELECT j.pipeline_status, j.option_no, j.option_label, j.group_id, g.label AS group_label
       FROM jobs j LEFT JOIN job_groups g ON g.id = j.group_id
      WHERE j.id = $1`,
    [jobId],
  );
  const job = r.rows[0];
  const dead = job?.pipeline_status === 'lost' ? 'lost' : job?.pipeline_status === 'cancelled' ? 'cancelled' : null;
  if (!job?.group_id) {
    return { payable: !dead, not_payable_reason: dead, confirmed_sibling: null, version_group: null };
  }
  const sib = await query(
    `SELECT hh_job_number, option_no, option_label, pipeline_status
       FROM jobs WHERE group_id = $1 AND id <> $2 AND is_deleted = false AND dismissed_at IS NULL
      ORDER BY option_no`,
    [job.group_id, jobId],
  );
  const siblings = sib.rows;
  const confirmedSib = siblings.find((s) =>
    !PRE_CONFIRMED_STATUSES.includes(s.pipeline_status || '') && s.pipeline_status !== 'lost' && s.pipeline_status !== 'cancelled');
  const thisOpen = PRE_CONFIRMED_STATUSES.includes(job.pipeline_status || '');
  const reason: PortalOptionsInfo['not_payable_reason'] = dead ?? (confirmedSib && thisOpen ? 'confirmed_sibling' : null);
  return {
    payable: !reason,
    not_payable_reason: reason,
    confirmed_sibling: confirmedSib
      ? { hh_job_number: confirmedSib.hh_job_number, option_no: confirmedSib.option_no, option_label: confirmedSib.option_label }
      : null,
    version_group: {
      label: job.group_label,
      this: { option_no: job.option_no, option_label: job.option_label },
      siblings,
    },
  };
}

/** A system note on a job's timeline (the group's own audit trail). */
export async function noteOnTimeline(
  client: PoolClient | null,
  jobId: string,
  content: string,
  actorId: string | null,
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
