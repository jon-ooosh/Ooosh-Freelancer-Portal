/**
 * Studio Sitter service (Rehearsals module, Phase B).
 *
 * The assignment unit is a SITE-EVENING (one premises, one sitter per night —
 * see docs/REHEARSALS-SPEC.md). Which evenings need cover is derived at read-time
 * from each job's hh_derived_flags.rehearsal_detail (Phase A); this service holds
 * the roster (union of derived needed dates + any manual-override shifts), the
 * per-job coverage read, and the assign / reassign / bulk / manual-override writes.
 *
 * Two rehearsal jobs running the same night share ONE shift (shift_date is
 * unique), so assigning a sitter on one job's card reflects on the other.
 */

import { query, getClient } from '../config/database';
import type { RehearsalDetail } from './rehearsal-plan';
import { getPresignedDownloadUrl } from '../config/r2';

const STUDIO_SITTER_TAG = 'studio sitter'; // matched case-insensitively
export const STUDIO_SITTER_DEFAULT_FEE_KEY = 'studio_sitter_default_fee';

/** Default per-night sitter fee (stored in system_settings). Applied to new
 *  assignments so it can surface in the freelancer portal. Read directly (no
 *  cache) so a fee change takes effect immediately. Null if unset/invalid. */
export async function getDefaultSitterFee(): Promise<number | null> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [STUDIO_SITTER_DEFAULT_FEE_KEY]);
  const v = r.rows[0]?.value;
  const n = v != null && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Set (or clear) the default sitter fee. */
export async function setDefaultSitterFee(fee: number | null): Promise<void> {
  await query(
    `INSERT INTO system_settings (key, value, category, updated_at)
     VALUES ($1, $2, 'studio_sitter', NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [STUDIO_SITTER_DEFAULT_FEE_KEY, fee != null ? String(fee) : '']
  );
}

export interface RosterJobEntry {
  job_id: string;
  hh_job_number: number | null;
  label: string;          // band / client / job name
  rooms: string[];        // sitter-needed room labels, e.g. ["Room 1 · Lockout"]
}

export interface RosterAssignee {
  id: string;
  name: string;
  is_studio_sitter: boolean;
  status: string;         // assignment status (assigned/confirmed)
}

export interface RosterRow {
  date: string;                       // YYYY-MM-DD
  needs_sitter: boolean;              // derived from jobs, or a manual-override shift exists
  jobs: RosterJobEntry[];            // who's in that night
  shift: {
    id: string;
    status: string;
    manual_override: boolean;
    override_reason: string | null;
    planned_start: string | null;
    planned_end: string | null;
  } | null;
  assignee: RosterAssignee | null;
}

const FLAVOUR_LABEL: Record<string, string> = {
  daytime: 'Daytime', evening: 'Evening', lockout: 'Lockout', base: 'Room', unknown: 'Room',
};

function roomLabels(detail: RehearsalDetail): string[] {
  return detail.rooms
    .filter((r) => r.sitter_needed)
    .map((r) => `${r.room}${r.flavour !== 'base' ? ` · ${FLAVOUR_LABEL[r.flavour] ?? r.flavour}` : ''}`);
}

function personName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(' ').trim() || 'Unknown';
}

function isStudioSitterTag(tags: unknown): boolean {
  return Array.isArray(tags) && tags.some((t) => typeof t === 'string' && t.toLowerCase() === STUDIO_SITTER_TAG);
}

/** Load rehearsal jobs whose sitter-needed evenings intersect [from,to]. */
async function loadRehearsalJobs(from: string, to: string): Promise<Array<{
  id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null; detail: RehearsalDetail;
}>> {
  const res = await query(
    `SELECT id, hh_job_number, job_name, client_name,
            hh_derived_flags->'rehearsal_detail' AS rehearsal_detail
     FROM jobs
     WHERE is_deleted = false
       AND pipeline_status NOT IN ('lost','cancelled')
       AND COALESCE(is_internal, false) = false
       AND hh_derived_flags->'rehearsal_detail'->>'sitter_needed' = 'true'
       AND (hh_derived_flags->'rehearsal_detail'->>'last_session_date') >= $1
       AND (hh_derived_flags->'rehearsal_detail'->>'first_session_date') <= $2`,
    [from, to]
  );
  return res.rows
    .map((r: any) => ({
      id: r.id,
      hh_job_number: r.hh_job_number ?? null,
      job_name: r.job_name ?? null,
      client_name: r.client_name ?? null,
      detail: r.rehearsal_detail as RehearsalDetail,
    }))
    .filter((r: any) => r.detail && Array.isArray(r.detail.evenings));
}

/** Fetch shifts + their live assignment (with person) in a date range. */
async function loadShifts(from: string, to: string): Promise<Map<string, any>> {
  const res = await query(
    `SELECT s.id, s.shift_date::text AS shift_date, s.status, s.manual_override, s.override_reason,
            s.planned_start, s.planned_end,
            a.status AS assignment_status, a.person_id,
            p.first_name, p.last_name, p.tags
     FROM studio_sitter_shifts s
     LEFT JOIN studio_sitter_shift_assignments a
       ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
     LEFT JOIN people p ON p.id = a.person_id
     WHERE s.shift_date BETWEEN $1 AND $2 AND s.status <> 'cancelled'`,
    [from, to]
  );
  const map = new Map<string, any>();
  for (const row of res.rows) {
    // shift_date comes back as a Date/string — normalise to YYYY-MM-DD
    const date = typeof row.shift_date === 'string' ? row.shift_date.slice(0, 10) : new Date(row.shift_date).toISOString().slice(0, 10);
    map.set(date, { ...row, date });
  }
  return map;
}

/** The roster: one row per evening (derived needed nights ∪ manual shifts). */
export async function getRoster(from: string, to: string): Promise<RosterRow[]> {
  const [jobs, shifts] = await Promise.all([loadRehearsalJobs(from, to), loadShifts(from, to)]);

  const dateJobs = new Map<string, RosterJobEntry[]>();
  for (const job of jobs) {
    const rooms = roomLabels(job.detail);
    const label = job.job_name || job.client_name || (job.hh_job_number ? `#${job.hh_job_number}` : 'Rehearsal');
    for (const eve of job.detail.evenings) {
      if (!eve.sitter_needed) continue;
      if (eve.date < from || eve.date > to) continue;
      const arr = dateJobs.get(eve.date) ?? [];
      arr.push({ job_id: job.id, hh_job_number: job.hh_job_number, label, rooms });
      dateJobs.set(eve.date, arr);
    }
  }

  const allDates = new Set<string>([...dateJobs.keys(), ...shifts.keys()]);
  const rows: RosterRow[] = [];
  for (const date of allDates) {
    const shiftRow = shifts.get(date);
    const jobsForDate = dateJobs.get(date) ?? [];
    rows.push({
      date,
      needs_sitter: jobsForDate.length > 0 || (shiftRow?.manual_override ?? false),
      jobs: jobsForDate,
      shift: shiftRow
        ? {
            id: shiftRow.id,
            status: shiftRow.status,
            manual_override: shiftRow.manual_override,
            override_reason: shiftRow.override_reason,
            planned_start: shiftRow.planned_start,
            planned_end: shiftRow.planned_end,
          }
        : null,
      assignee: shiftRow?.person_id
        ? {
            id: shiftRow.person_id,
            name: personName(shiftRow.first_name, shiftRow.last_name),
            is_studio_sitter: isStudioSitterTag(shiftRow.tags),
            status: shiftRow.assignment_status,
          }
        : null,
    });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

export interface JobCoverageEvening {
  date: string;
  shift_id: string | null;
  status: string;                    // shift status, or 'needed' if no shift
  assignee: { id: string; name: string } | null;
}

/** Per-job coverage for the job's sitter-needed evenings (drives the card chips). */
export async function getJobCoverage(jobId: string): Promise<JobCoverageEvening[]> {
  const jobRes = await query(
    `SELECT hh_derived_flags->'rehearsal_detail' AS rehearsal_detail
     FROM jobs WHERE id = $1 AND is_deleted = false`,
    [jobId]
  );
  const detail: RehearsalDetail | null = jobRes.rows[0]?.rehearsal_detail ?? null;
  if (!detail || !Array.isArray(detail.evenings)) return [];
  const dates = detail.evenings.filter((e) => e.sitter_needed).map((e) => e.date);
  if (dates.length === 0) return [];

  const shiftRes = await query(
    `SELECT s.id, s.shift_date::text AS shift_date, s.status, a.person_id, p.first_name, p.last_name
     FROM studio_sitter_shifts s
     LEFT JOIN studio_sitter_shift_assignments a
       ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
     LEFT JOIN people p ON p.id = a.person_id
     WHERE s.shift_date = ANY($1::date[]) AND s.status <> 'cancelled'`,
    [dates]
  );
  const byDate = new Map<string, any>();
  for (const row of shiftRes.rows) {
    const d = typeof row.shift_date === 'string' ? row.shift_date.slice(0, 10) : new Date(row.shift_date).toISOString().slice(0, 10);
    byDate.set(d, row);
  }

  return dates.map((date) => {
    const s = byDate.get(date);
    return {
      date,
      shift_id: s?.id ?? null,
      status: s?.status ?? 'needed',
      assignee: s?.person_id ? { id: s.person_id, name: personName(s.first_name, s.last_name) } : null,
    };
  });
}

/** Ensure a shift row exists for a date; never downgrades an existing manual_override. */
async function ensureShift(
  client: any,
  date: string,
  opts: { manual?: boolean; reason?: string | null; createdBy?: string | null } = {},
): Promise<string> {
  const res = await client.query(
    `INSERT INTO studio_sitter_shifts (shift_date, manual_override, override_reason, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (shift_date) DO UPDATE SET
       manual_override = studio_sitter_shifts.manual_override OR EXCLUDED.manual_override,
       override_reason = COALESCE(EXCLUDED.override_reason, studio_sitter_shifts.override_reason),
       status = CASE WHEN studio_sitter_shifts.status = 'cancelled' THEN 'needed' ELSE studio_sitter_shifts.status END,
       updated_at = NOW()
     RETURNING id`,
    [date, opts.manual ?? false, opts.reason ?? null, opts.createdBy ?? null]
  );
  return res.rows[0].id;
}

/** Assign (or reassign) a sitter to an evening. Cancels any existing live row.
 *  Fee defaults to the configured default sitter fee (for portal display). */
export async function assignSitter(date: string, personId: string, assignedBy: string | null, fee?: number | null): Promise<string> {
  const resolvedFee = fee != null ? fee : await getDefaultSitterFee();
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const shiftId = await ensureShift(client, date, { createdBy: assignedBy });
    await client.query(
      `UPDATE studio_sitter_shift_assignments SET status='cancelled', updated_at=NOW()
       WHERE shift_id=$1 AND status IN ('assigned','confirmed')`,
      [shiftId]
    );
    await client.query(
      `INSERT INTO studio_sitter_shift_assignments (shift_id, person_id, status, assigned_by, fee)
       VALUES ($1, $2, 'assigned', $3, $4)`,
      [shiftId, personId, assignedBy, resolvedFee]
    );
    await client.query(`UPDATE studio_sitter_shifts SET status='assigned', updated_at=NOW() WHERE id=$1`, [shiftId]);
    await client.query('COMMIT');
    await syncRehearsalStatusForDate(date);
    return shiftId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Remove the sitter from an evening (shift stays, back to 'needed'). */
export async function unassignSitter(date: string): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const shiftRes = await client.query(`SELECT id FROM studio_sitter_shifts WHERE shift_date=$1`, [date]);
    if (shiftRes.rows.length === 0) { await client.query('COMMIT'); return; }
    const shiftId = shiftRes.rows[0].id;
    await client.query(
      `UPDATE studio_sitter_shift_assignments SET status='cancelled', updated_at=NOW()
       WHERE shift_id=$1 AND status IN ('assigned','confirmed')`,
      [shiftId]
    );
    await client.query(`UPDATE studio_sitter_shifts SET status='needed', updated_at=NOW() WHERE id=$1`, [shiftId]);
    await client.query('COMMIT');
    await syncRehearsalStatusForDate(date);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Remove a manual-override cover shift (the only shift kind staff can delete —
 *  derived needed nights can't be deleted, they're needed). Returns false if
 *  the date has no cancellable manual shift. */
export async function removeManualCover(date: string): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const r = await client.query(
      `SELECT id, manual_override FROM studio_sitter_shifts WHERE shift_date=$1 AND status <> 'cancelled'`,
      [date]
    );
    if (r.rows.length === 0 || !r.rows[0].manual_override) { await client.query('ROLLBACK'); return false; }
    const shiftId = r.rows[0].id;
    await client.query(
      `UPDATE studio_sitter_shift_assignments SET status='cancelled', updated_at=NOW()
       WHERE shift_id=$1 AND status IN ('assigned','confirmed')`,
      [shiftId]
    );
    await client.query(`UPDATE studio_sitter_shifts SET status='cancelled', updated_at=NOW() WHERE id=$1`, [shiftId]);
    await client.query('COMMIT');
    await syncRehearsalStatusForDate(date);
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Create a manual-override shift (daytime cover on a short-staffed day). */
export async function createManualShift(date: string, reason: string | null, createdBy: string | null): Promise<string> {
  const client = await getClient();
  try {
    return await ensureShift(client, date, { manual: true, reason, createdBy });
  } finally {
    client.release();
  }
}

/** Assign one person to a specific set of evenings (staff-selected). */
export async function assignMany(dates: string[], personId: string, assignedBy: string | null): Promise<number> {
  const unique = Array.from(new Set(dates));
  for (const date of unique) {
    await assignSitter(date, personId, assignedBy);
  }
  return unique.length;
}

// ── Coverage-driven requirement status ─────────────────────────────────────
// The rehearsal requirement's status is authoritative from coverage between
// not_started / in_progress / done (like excess_resolve). 'blocked' (Problem) is
// staff-set and left alone. Winds forward as sitters are assigned and BACK when a
// date is added or a sitter drops out.

/** Recompute + set the rehearsal requirement status for one job from coverage. */
export async function syncRehearsalRequirementStatus(jobId: string): Promise<void> {
  const coverage = await getJobCoverage(jobId);
  // No sitter-needed evenings (daytime-only / needs_review) — leave status manual
  // (that card is about room prep, not sitter cover).
  if (coverage.length === 0) return;
  const needed = coverage.length;
  const assigned = coverage.filter((c) => c.assignee).length;
  const status = assigned === 0 ? 'not_started' : assigned >= needed ? 'done' : 'in_progress';
  await query(
    `UPDATE job_requirements SET status=$1, updated_at=NOW()
     WHERE job_id=$2 AND requirement_type='rehearsal' AND phase='pre_hire' AND status <> 'blocked'`,
    [status, jobId]
  );
}

/** Resync every active rehearsal job whose sitter-needed evenings include a date. */
export async function syncRehearsalStatusForDate(date: string): Promise<void> {
  const res = await query(
    `SELECT id FROM jobs
     WHERE is_deleted = false
       AND pipeline_status NOT IN ('lost','cancelled')
       AND COALESCE(is_internal, false) = false
       AND hh_derived_flags->'rehearsal_detail'->'evenings' @> $1::jsonb`,
    [JSON.stringify([{ date, sitter_needed: true }])]
  );
  for (const row of res.rows) {
    await syncRehearsalRequirementStatus(row.id);
  }
}

// ── Freelancer portal surface (Phase D) ────────────────────────────────────

export interface SitterSharedFile { name: string; url: string; fileType: string | null; }
export interface SitterShiftJob extends RosterJobEntry { files?: SitterSharedFile[]; }
export interface SitterShift {
  date: string;
  planned_start: string | null;
  planned_end: string | null;
  status: string;                 // shift status
  assignment_status: string;      // assigned / confirmed
  fee: number | null;
  jobs: SitterShiftJob[];         // who's in that night
}

/** Group a job set into per-date "who's in" entries (sitter-needed evenings only). */
function jobsByDate(jobs: Array<{ id: string; hh_job_number: number | null; job_name: string | null; client_name: string | null; detail: RehearsalDetail }>): Map<string, RosterJobEntry[]> {
  const map = new Map<string, RosterJobEntry[]>();
  for (const job of jobs) {
    const rooms = roomLabels(job.detail);
    const label = job.job_name || job.client_name || (job.hh_job_number ? `#${job.hh_job_number}` : 'Rehearsal');
    for (const eve of job.detail.evenings) {
      if (!eve.sitter_needed) continue;
      const arr = map.get(eve.date) ?? [];
      arr.push({ job_id: job.id, hh_job_number: job.hh_job_number, label, rooms });
      map.set(eve.date, arr);
    }
  }
  return map;
}

/** A sitter's own live-assigned shifts in [from,to], with who's in each night. */
export async function getSitterShifts(personId: string, from: string, to: string): Promise<SitterShift[]> {
  const res = await query(
    `SELECT s.shift_date::text AS shift_date, s.status, s.planned_start, s.planned_end,
            a.status AS assignment_status, a.fee
     FROM studio_sitter_shift_assignments a
     JOIN studio_sitter_shifts s ON s.id = a.shift_id
     WHERE a.person_id = $1 AND a.status IN ('assigned','confirmed')
       AND s.status <> 'cancelled' AND s.shift_date BETWEEN $2 AND $3
     ORDER BY s.shift_date`,
    [personId, from, to]
  );
  const dateJobs = jobsByDate(await loadRehearsalJobs(from, to));
  return res.rows.map((r: any) => ({
    date: r.shift_date,
    planned_start: r.planned_start,
    planned_end: r.planned_end,
    status: r.status,
    assignment_status: r.assignment_status,
    fee: r.fee != null ? Number(r.fee) : null,
    jobs: dateJobs.get(r.shift_date) ?? [],
  }));
}

/** True if a person is live-assigned to the shift on `date` (portal access check). */
export async function isSitterAssignedTo(personId: string, date: string): Promise<boolean> {
  const r = await query(
    `SELECT 1 FROM studio_sitter_shift_assignments a
     JOIN studio_sitter_shifts s ON s.id = a.shift_id
     WHERE a.person_id = $1 AND a.status IN ('assigned','confirmed')
       AND s.status <> 'cancelled' AND s.shift_date = $2 LIMIT 1`,
    [personId, date]
  );
  return r.rows.length > 0;
}

/** Detail for one evening: who's in each room + that job's shared specs/files. */
export async function getSitterShiftDetail(date: string): Promise<{ date: string; jobs: SitterShiftJob[] }> {
  const jobs = await loadRehearsalJobs(date, date);
  const out: SitterShiftJob[] = [];
  for (const job of jobs) {
    if (!job.detail.evenings.some((e) => e.sitter_needed && e.date === date)) continue;
    const fRes = await query(`SELECT files FROM jobs WHERE id = $1`, [job.id]);
    const raw: any[] = Array.isArray(fRes.rows[0]?.files) ? fRes.rows[0].files : [];
    const files: SitterSharedFile[] = [];
    for (const x of raw) {
      if (!x?.share_with_freelancer) continue;
      let url: string = x.url || '';
      if (url && typeof url === 'string' && url.startsWith('files/')) {
        try { url = await getPresignedDownloadUrl(url); } catch { /* keep raw */ }
      }
      files.push({ name: x.name || 'File', url, fileType: x.type || x.fileType || null });
    }
    out.push({
      job_id: job.id,
      hh_job_number: job.hh_job_number,
      label: job.job_name || job.client_name || (job.hh_job_number ? `#${job.hh_job_number}` : 'Rehearsal'),
      rooms: roomLabels(job.detail),
      files,
    });
  }
  return { date, jobs: out };
}

export interface SitterOption {
  id: string;
  name: string;
  is_studio_sitter: boolean;
  skills: string[];
}

/** Approved freelancers for the assign picker — Studio-Sitter-tagged first. */
export async function listSitters(): Promise<SitterOption[]> {
  const res = await query(
    `SELECT id, first_name, last_name, tags, skills
     FROM people
     WHERE is_freelancer = true AND is_approved = true AND is_deleted = false`,
    []
  );
  const sitters: SitterOption[] = res.rows.map((r: any) => ({
    id: r.id,
    name: personName(r.first_name, r.last_name),
    is_studio_sitter: isStudioSitterTag(r.tags),
    skills: Array.isArray(r.skills) ? r.skills : [],
  }));
  sitters.sort((a, b) => {
    if (a.is_studio_sitter !== b.is_studio_sitter) return a.is_studio_sitter ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return sitters;
}
