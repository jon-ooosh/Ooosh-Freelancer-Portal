/**
 * Job projects — "all of these jobs belong to the same overall thing"
 * (docs/JOB-PROJECTS-SPEC.md). A festival: the core backline, an outlier
 * stage, a small PA and a dozen band spot-hires, each an ordinary job.
 *
 * A thin label with roll-ups, nothing more. A project owns no money, status,
 * requirements or HireHop data; every member keeps being an ordinary job.
 *
 * NOT job_groups. Those are alternatives (the client picks ONE) and every read
 * path on them assumes it — the portal refusal, the headline dedup, the
 * confirm bells (QUOTE-VERSIONS-SPEC §14). Its own table and column keeps the
 * two apart, and lets one job be an option AND part of a project.
 *
 * The project's dates are DEFAULTS for a new job only. They are never pushed
 * into the existing jobs — Start/End are what HireHop charges for, so moving
 * them on a dozen jobs at once would silently move money (spec §3).
 */
import { query } from '../config/database';
import { PRE_CONFIRMED_STATUSES } from './pipeline-stage';
import { resolveLeadJob, noteOnTimeline } from './job-groups';

/** Statuses whose value counts as confirmed business in the roll-up. */
const CONFIRMED_STATUSES = [
  'confirmed', 'prepping', 'prepped', 'dispatched', 'returned_incomplete', 'returned', 'completed',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A refusal worded for a person — the route answers it as-is (404 or 400). */
export class ProjectError extends Error {
  constructor(message: string, public status: 400 | 404 = 400) { super(message); }
}

export interface ProjectInput {
  name?: string;
  client_id?: string | null;
  lead_user_id?: string | null;
  out_date?: string | null;
  job_date?: string | null;
  job_end?: string | null;
  return_date?: string | null;
}

export interface ProjectMember {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: string | null;
  status: number | null;
  job_date: string | null;
  job_end: string | null;
  out_date: string | null;
  return_date: string | null;
  job_value: string | null;
  client_name: string | null;
  dismissed_at: string | null;
  group_id: string | null;
  option_no: number | null;
  group_lead_id: string | null;
  /** Counted in the roll-up? False for a dismissed enquiry or a non-lead option. */
  counted: boolean;
}

/** Dates arrive as YYYY-MM-DD or null; anything else is refused. */
function cleanDates(input: ProjectInput): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of ['out_date', 'job_date', 'job_end', 'return_date'] as const) {
    if (input[k] === undefined) continue;
    const v = input[k] || null;
    if (v && !DATE_RE.test(v)) throw new ProjectError(`${k} must be YYYY-MM-DD`);
    out[k] = v;
  }
  const d = { ...out };
  // Out ≤ Start ≤ End ≤ Return, where set — the same order the job editor keeps.
  const order = [d.out_date, d.job_date, d.job_end, d.return_date].filter((x): x is string => !!x);
  for (let i = 1; i < order.length; i++) {
    if (order[i] < order[i - 1]) throw new ProjectError('The dates are out of order (Out, Start, End, Return)');
  }
  return out;
}

/** The project, its members and the roll-ups the panel shows. */
export async function getProject(projectId: string) {
  const p = await query(
    `SELECT jp.id, jp.name, jp.client_id, o.name AS client_name,
            jp.lead_user_id,
            NULLIF(TRIM(COALESCE(lp.preferred_name, lp.first_name, '') || ' ' || COALESCE(lp.last_name, '')), '') AS lead_name,
            jp.out_date::text AS out_date, jp.job_date::text AS job_date,
            jp.job_end::text AS job_end, jp.return_date::text AS return_date,
            jp.created_at
       FROM job_projects jp
       LEFT JOIN organisations o ON o.id = jp.client_id
       LEFT JOIN users lu ON lu.id = jp.lead_user_id
       LEFT JOIN people lp ON lp.id = lu.person_id
      WHERE jp.id = $1`,
    [projectId],
  );
  const project = p.rows[0];
  if (!project) return null;

  const m = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.pipeline_status, j.status,
            j.job_date, j.job_end, j.out_date, j.return_date, j.job_value,
            COALESCE(co.name, j.client_name, j.company_name) AS client_name,
            j.dismissed_at, j.group_id, j.option_no,
            g.lead_job_id AS group_lead_id
       FROM jobs j
       LEFT JOIN organisations co ON co.id = j.client_id
       LEFT JOIN job_groups g ON g.id = j.group_id
      WHERE j.job_project_id = $1 AND j.is_deleted = false
      ORDER BY j.job_date NULLS LAST, j.hh_job_number NULLS LAST, j.created_at`,
    [projectId],
  );
  const members = m.rows as ProjectMember[];

  // Quote options inside the project count once: only the lead option of each
  // options group (the same rule as the pipeline's headline counts).
  const nonLead = new Set<string>();
  const byGroup = new Map<string, ProjectMember[]>();
  for (const row of members) {
    if (!row.group_id) continue;
    const list = byGroup.get(row.group_id) ?? [];
    list.push(row);
    byGroup.set(row.group_id, list);
  }
  for (const list of byGroup.values()) {
    const lead = resolveLeadJob(list, list[0]?.group_lead_id ?? null);
    for (const row of list) if (!lead || row.id !== lead.id) nonLead.add(row.id);
  }

  let confirmedValue = 0;
  let quotedValue = 0;
  let confirmedCount = 0;
  let quotedCount = 0;
  for (const row of members) {
    const status = row.pipeline_status || '';
    const value = Number(row.job_value) || 0;
    const counted = !row.dismissed_at && !nonLead.has(row.id);
    row.counted = counted;
    if (!counted) continue;
    if (CONFIRMED_STATUSES.includes(status)) { confirmedValue += value; confirmedCount++; }
    else if (PRE_CONFIRMED_STATUSES.includes(status)) { quotedValue += value; quotedCount++; }
  }

  return {
    ...project,
    members,
    rollup: {
      job_count: members.length,
      confirmed_count: confirmedCount,
      confirmed_value: Math.round(confirmedValue * 100) / 100,
      quoted_count: quotedCount,
      quoted_value: Math.round(quotedValue * 100) / 100,
    },
  };
}

/** Projects for the "add to a project" picker — by name, newest first. */
export async function listProjects(search: string | null, limit = 20) {
  const params: unknown[] = [];
  let where = '';
  if (search && search.trim()) {
    params.push(`%${search.trim()}%`);
    where = `WHERE jp.name ILIKE $1 OR o.name ILIKE $1`;
  }
  params.push(limit);
  const r = await query(
    `SELECT jp.id, jp.name, o.name AS client_name,
            jp.job_date::text AS job_date, jp.job_end::text AS job_end,
            (SELECT COUNT(*)::int FROM jobs j WHERE j.job_project_id = jp.id AND j.is_deleted = false) AS job_count
       FROM job_projects jp
       LEFT JOIN organisations o ON o.id = jp.client_id
       ${where}
      ORDER BY jp.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/**
 * A new project, starting from a job: its name, client and dates default to
 * that job's, and the job joins it.
 */
export async function createProjectFromJob(jobId: string, input: ProjectInput, actorId: string) {
  const job = await loadJob(jobId);
  const name = (input.name ?? '').trim();
  if (!name) throw new ProjectError('A project needs a name');
  const dates = cleanDates(input);
  const r = await query(
    `INSERT INTO job_projects (name, client_id, lead_user_id, out_date, job_date, job_end, return_date, created_by)
     VALUES ($1, $2, $3,
             COALESCE($4::date, ($8::timestamptz AT TIME ZONE 'Europe/London')::date),
             COALESCE($5::date, ($9::timestamptz AT TIME ZONE 'Europe/London')::date),
             COALESCE($6::date, ($10::timestamptz AT TIME ZONE 'Europe/London')::date),
             COALESCE($7::date, ($11::timestamptz AT TIME ZONE 'Europe/London')::date),
             $12)
     RETURNING id`,
    [
      name.slice(0, 200),
      input.client_id !== undefined ? input.client_id : job.client_id,
      input.lead_user_id !== undefined ? input.lead_user_id : actorId,
      dates.out_date ?? null, dates.job_date ?? null, dates.job_end ?? null, dates.return_date ?? null,
      job.out_date, job.job_date, job.job_end, job.return_date,
      actorId,
    ],
  );
  const projectId = r.rows[0].id as string;
  await addJobToProject(projectId, jobId, actorId);
  return projectId;
}

/** Rename, change client / lead / default dates. Never touches the member jobs. */
export async function updateProject(projectId: string, input: ProjectInput): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [projectId];
  if (input.name !== undefined) {
    const name = (input.name ?? '').trim();
    if (!name) throw new ProjectError('A project needs a name');
    params.push(name.slice(0, 200));
    sets.push(`name = $${params.length}`);
  }
  if (input.client_id !== undefined) { params.push(input.client_id || null); sets.push(`client_id = $${params.length}`); }
  if (input.lead_user_id !== undefined) { params.push(input.lead_user_id || null); sets.push(`lead_user_id = $${params.length}`); }

  // The order check needs the stored dates for any that weren't sent.
  const dates = cleanDates(input);
  if (Object.keys(dates).length > 0) {
    const cur = await query(
      `SELECT out_date::text AS out_date, job_date::text AS job_date, job_end::text AS job_end, return_date::text AS return_date
         FROM job_projects WHERE id = $1`,
      [projectId],
    );
    if (!cur.rows[0]) throw new ProjectError('Project not found', 404);
    cleanDates({ ...cur.rows[0], ...dates });
    for (const [k, v] of Object.entries(dates)) { params.push(v); sets.push(`${k} = $${params.length}::date`); }
  }
  if (sets.length === 0) return;
  const r = await query(`UPDATE job_projects SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`, params);
  if (!r.rowCount) throw new ProjectError('Project not found', 404);
}

/**
 * Put a job in a project. A job is in one project at most, so this MOVES it if
 * it was in another (the picker shows which). A note on the job's timeline
 * says so either way.
 */
export async function addJobToProject(projectId: string, jobId: string, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  const proj = await query(`SELECT name FROM job_projects WHERE id = $1`, [projectId]);
  if (!proj.rows[0]) throw new ProjectError('Project not found', 404);
  if (job.job_project_id === projectId) return;
  await query(`UPDATE jobs SET job_project_id = $1, updated_at = NOW() WHERE id = $2`, [projectId, jobId]);
  const moved = job.job_project_name ? ` (moved from "${job.job_project_name}")` : '';
  await noteOnTimeline(null, jobId, `Added to project "${proj.rows[0].name}"${moved}`, actorId, job.pipeline_status)
    .catch((e) => console.error('[projects] timeline note failed:', e));
}

/** Take a job out of its project. The project stays, even if now empty. */
export async function removeJobFromProject(jobId: string, actorId: string): Promise<void> {
  const job = await loadJob(jobId);
  if (!job.job_project_id) return;
  await query(`UPDATE jobs SET job_project_id = NULL, updated_at = NOW() WHERE id = $1`, [jobId]);
  await noteOnTimeline(null, jobId, `Removed from project "${job.job_project_name}"`, actorId, job.pipeline_status)
    .catch((e) => console.error('[projects] timeline note failed:', e));
}

/**
 * Jobs that could be added to a project: by job number or name when searched,
 * otherwise the project client's jobs and anything overlapping the project's
 * dates. Each carries the project it is in now, if any.
 */
export async function projectJobCandidates(projectId: string, search: string | null) {
  const proj = await query(
    `SELECT client_id, COALESCE(out_date, job_date) AS from_date, COALESCE(return_date, job_end) AS to_date
       FROM job_projects WHERE id = $1`,
    [projectId],
  );
  const p = proj.rows[0];
  if (!p) throw new ProjectError('Project not found', 404);

  const params: unknown[] = [projectId];
  let filter: string;
  const term = (search ?? '').trim();
  if (term) {
    params.push(`%${term}%`);
    const textMatch = `(j.job_name ILIKE $2 OR j.client_name ILIKE $2 OR j.company_name ILIKE $2)`;
    if (/^\d+$/.test(term)) {
      params.push(`${term}%`);
      filter = `(${textMatch} OR CAST(j.hh_job_number AS TEXT) LIKE $3)`;
    } else {
      filter = textMatch;
    }
  } else {
    params.push(p.client_id, p.from_date, p.to_date);
    filter = `(
      ($2::uuid IS NOT NULL AND j.client_id = $2::uuid)
      OR ($3::date IS NOT NULL AND $4::date IS NOT NULL
          AND (j.job_date AT TIME ZONE 'Europe/London')::date <= $4::date
          AND (COALESCE(j.job_end, j.job_date) AT TIME ZONE 'Europe/London')::date >= $3::date)
    ) AND j.pipeline_status NOT IN ('lost', 'cancelled') AND j.dismissed_at IS NULL`;
  }
  const r = await query(
    `SELECT j.id, j.hh_job_number, j.job_name, j.pipeline_status, j.job_date, j.job_end,
            COALESCE(co.name, j.client_name, j.company_name) AS client_name,
            j.job_project_id, jp.name AS job_project_name
       FROM jobs j
       LEFT JOIN organisations co ON co.id = j.client_id
       LEFT JOIN job_projects jp ON jp.id = j.job_project_id
      WHERE j.is_deleted = false
        AND j.job_project_id IS DISTINCT FROM $1::uuid
        AND ${filter}
      ORDER BY j.job_date DESC NULLS LAST
      LIMIT 25`,
    params,
  );
  return r.rows;
}

async function loadJob(jobId: string) {
  const r = await query(
    `SELECT j.id, j.client_id, j.pipeline_status, j.job_project_id, jp.name AS job_project_name,
            j.out_date, j.job_date, j.job_end, j.return_date
       FROM jobs j LEFT JOIN job_projects jp ON jp.id = j.job_project_id
      WHERE j.id = $1 AND j.is_deleted = false`,
    [jobId],
  );
  if (!r.rows[0]) throw new ProjectError('Job not found', 404);
  return r.rows[0];
}
