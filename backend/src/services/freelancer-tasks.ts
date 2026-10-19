/**
 * Freelancer tasks — "prep this van" (or anything else) for a freelancer in for
 * the day, or a studio sitter on shift. docs/STAFF-CALENDAR-SPEC.md §21.
 *
 * THE place that answers "whose task is this, and for which day?". A task has
 * no person and no date of its own (migration 276): both are read through its
 * owner — a day booking or a sitter shift. A sitter reassigned on the day hands
 * the shift's tasks to whoever is now on; an amended booking date moves its
 * tasks with it. Nothing else should re-derive either.
 *
 * NOT the To Do module (staff-only) and NOT for freelancers on driving jobs —
 * those never see these, by design.
 */

import { query } from '../config/database';
import emailService from './email-service';
import { greetingName, fullDisplayName, DISPLAY_NAME_SQL } from './display-name';
import { todayLondon } from './staff-tasks';
import { formatBookingDate } from './freelancer-day-offer';

export type TaskOwner = { kind: 'booking'; id: string } | { kind: 'shift'; id: string };
export type FreelancerTaskType = 'van_prep' | 'other';
export type FreelancerTaskStatus = 'open' | 'done' | 'cancelled';

export interface FreelancerTask {
  id: string;
  dayBookingId: string | null;
  shiftId: string | null;
  taskType: FreelancerTaskType;
  vehicleId: string | null;
  vehicleReg: string | null;
  vehicleType: string | null;
  jobId: string | null;
  hhJobNumber: number | null;
  jobName: string | null;
  description: string | null;
  sortOrder: number;
  status: FreelancerTaskStatus;
  doneAt: string | null;
  doneByName: string | null;
  doneByPersonId: string | null;
  doneVia: 'prep_saved' | 'portal' | 'staff' | null;
  createdAt: string;
  updatedAt: string;
  /** One line a freelancer can read: "Prep RX21 ABC (Premium) for #16791". */
  title: string;
}

/** Booking statuses whose tasks are still somebody's to do. */
const LIVE_BOOKING = ['offered', 'accepted'];

const SELECT = `
  SELECT t.*, fv.reg AS vehicle_reg, fv.simple_type AS vehicle_type,
         j.hh_job_number, j.job_name,
         NULLIF(${DISPLAY_NAME_SQL}, ' ') AS done_by_name
    FROM freelancer_tasks t
    LEFT JOIN fleet_vehicles fv ON fv.id = t.vehicle_id
    LEFT JOIN jobs j ON j.id = t.job_id
    LEFT JOIN people p ON p.id = t.done_by_person`;

/** The one wording for a task, shared by the portal and the email. */
export function taskTitle(t: Pick<FreelancerTask, 'taskType' | 'vehicleReg' | 'vehicleType' | 'hhJobNumber' | 'description'>): string {
  const job = t.hhJobNumber ? ` for #${t.hhJobNumber}` : '';
  if (t.taskType === 'van_prep') {
    return `Prep ${t.vehicleReg ?? 'a van'}${t.vehicleType ? ` (${t.vehicleType})` : ''}${job}`;
  }
  return `${t.description ?? ''}${job}`.trim();
}

function mapRow(r: Record<string, any>): FreelancerTask {
  const t = {
    id: r.id,
    dayBookingId: r.day_booking_id ?? null,
    shiftId: r.shift_id ?? null,
    taskType: r.task_type,
    vehicleId: r.vehicle_id ?? null,
    vehicleReg: r.vehicle_reg ?? null,
    vehicleType: r.vehicle_type ?? null,
    jobId: r.job_id ?? null,
    hhJobNumber: r.hh_job_number ?? null,
    jobName: r.job_name ?? null,
    description: r.description ?? null,
    sortOrder: Number(r.sort_order ?? 0),
    status: r.status,
    doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
    doneByName: r.done_by_name ?? null,
    doneByPersonId: r.done_by_person ?? null,
    doneVia: r.done_via ?? null,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  } as Omit<FreelancerTask, 'title'>;
  return { ...t, title: taskTitle(t) };
}

function ownerColumn(owner: TaskOwner): 'day_booking_id' | 'shift_id' {
  return owner.kind === 'booking' ? 'day_booking_id' : 'shift_id';
}

// ── The owner: its day, whether it is live, and who is doing it ─────────────

export interface OwnerContext {
  date: string;
  /** Can tasks still be added / is anybody still expected to do them? */
  live: boolean;
  lastNotifiedAt: string | null;
  person: { id: string; email: string | null; first_name: string | null; last_name: string | null; preferred_name: string | null } | null;
}

export async function getOwnerContext(owner: TaskOwner): Promise<OwnerContext | null> {
  if (owner.kind === 'booking') {
    const r = await query(
      `SELECT b.booking_date::text AS d, b.status, b.last_tasks_notified_at,
              p.id AS person_id, p.email, p.first_name, p.last_name, p.preferred_name
         FROM freelancer_day_bookings b JOIN people p ON p.id = b.person_id
        WHERE b.id = $1`,
      [owner.id]
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      date: String(row.d).slice(0, 10),
      live: LIVE_BOOKING.includes(row.status),
      lastNotifiedAt: row.last_tasks_notified_at ? new Date(row.last_tasks_notified_at).toISOString() : null,
      person: { id: row.person_id, email: row.email, first_name: row.first_name, last_name: row.last_name, preferred_name: row.preferred_name },
    };
  }
  // A shift's person is its LIVE assignment — whoever is on tonight.
  const r = await query(
    `SELECT s.shift_date::text AS d, s.status, s.last_tasks_notified_at,
            p.id AS person_id, p.email, p.first_name, p.last_name, p.preferred_name
       FROM studio_sitter_shifts s
       LEFT JOIN studio_sitter_shift_assignments a
         ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
       LEFT JOIN people p ON p.id = a.person_id
      WHERE s.id = $1`,
    [owner.id]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    date: String(row.d).slice(0, 10),
    live: row.status !== 'cancelled',
    lastNotifiedAt: row.last_tasks_notified_at ? new Date(row.last_tasks_notified_at).toISOString() : null,
    person: row.person_id
      ? { id: row.person_id, email: row.email, first_name: row.first_name, last_name: row.last_name, preferred_name: row.preferred_name }
      : null,
  };
}

/** Which owner a task belongs to. */
export function ownerOf(task: Pick<FreelancerTask, 'dayBookingId' | 'shiftId'>): TaskOwner {
  return task.dayBookingId ? { kind: 'booking', id: task.dayBookingId } : { kind: 'shift', id: task.shiftId! };
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listTasks(owner: TaskOwner, opts: { includeCancelled?: boolean } = {}): Promise<FreelancerTask[]> {
  const r = await query(
    `${SELECT} WHERE t.${ownerColumn(owner)} = $1
       ${opts.includeCancelled ? '' : `AND t.status <> 'cancelled'`}
     ORDER BY t.sort_order, t.created_at`,
    [owner.id]
  );
  return r.rows.map(mapRow);
}

export async function getTask(id: string): Promise<FreelancerTask | null> {
  const r = await query(`${SELECT} WHERE t.id = $1`, [id]);
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

/** How many tasks changed since the freelancer was last told (drives "Send update"). */
export async function changesSinceNotified(owner: TaskOwner, lastNotifiedAt: string | null): Promise<number> {
  const r = await query(
    `SELECT COUNT(*)::int AS n FROM freelancer_tasks
      WHERE ${ownerColumn(owner)} = $1
        AND ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
        AND NOT ($2::timestamptz IS NULL AND status = 'cancelled')`,
    [owner.id, lastNotifiedAt]
  );
  return r.rows[0]?.n ?? 0;
}

// ── Writing (staff) ─────────────────────────────────────────────────────────

export interface TaskInput {
  taskType: FreelancerTaskType;
  vehicleId?: string | null;
  /** The job, by OP id (the staff picker sends this)… */
  jobId?: string | null;
  /** …or by HireHop number. jobId wins when both are given. */
  hhJobNumber?: number | null;
  description?: string | null;
}

async function resolveJobId(hhJobNumber: number | null | undefined): Promise<string | null> {
  if (hhJobNumber == null) return null;
  const r = await query(
    `SELECT id FROM jobs WHERE hh_job_number = $1 AND is_deleted = false LIMIT 1`,
    [hhJobNumber]
  );
  if (!r.rows[0]) throw new Error(`No job #${hhJobNumber} in OP`);
  return r.rows[0].id;
}

/** The job a task input names: undefined = not mentioned, null = cleared. */
async function resolveJob(input: Partial<TaskInput>): Promise<string | null | undefined> {
  if (input.jobId !== undefined) {
    if (input.jobId === null) return null;
    const r = await query(`SELECT id FROM jobs WHERE id = $1 AND is_deleted = false`, [input.jobId]);
    if (!r.rows[0]) throw new Error('That job is not in OP');
    return r.rows[0].id;
  }
  if (input.hhJobNumber !== undefined) return resolveJobId(input.hhJobNumber);
  return undefined;
}

async function assertVehicle(vehicleId: string | null | undefined): Promise<void> {
  if (!vehicleId) return;
  const r = await query(`SELECT 1 FROM fleet_vehicles WHERE id = $1`, [vehicleId]);
  if (!r.rows[0]) throw new Error('That van is not in the fleet');
}

function cleanDescription(s: string | null | undefined): string | null {
  const v = (s ?? '').trim().slice(0, 500);
  return v || null;
}

function validateShape(taskType: FreelancerTaskType, vehicleId: string | null, description: string | null) {
  if (taskType === 'van_prep' && !vehicleId) throw new Error('Pick the van to prep');
  if (taskType === 'other' && !description) throw new Error('Say what the task is');
}

export async function createTask(owner: TaskOwner, input: TaskInput, userId: string): Promise<FreelancerTask> {
  const ctx = await getOwnerContext(owner);
  if (!ctx) throw new Error(owner.kind === 'booking' ? 'That booking no longer exists' : 'That evening no longer exists');
  if (!ctx.live) throw new Error(owner.kind === 'booking' ? 'That booking is not live any more' : 'That evening was cancelled');

  const vehicleId = input.vehicleId ?? null;
  const description = cleanDescription(input.description);
  validateShape(input.taskType, vehicleId, description);
  await assertVehicle(vehicleId);
  const jobId = (await resolveJob(input)) ?? null;

  const col = ownerColumn(owner);
  // The same van twice on one person's list is a mis-click, not two jobs.
  if (input.taskType === 'van_prep') {
    const dup = await query(
      `SELECT 1 FROM freelancer_tasks
        WHERE ${col} = $1 AND task_type = 'van_prep' AND vehicle_id = $2 AND status = 'open' LIMIT 1`,
      [owner.id, vehicleId]
    );
    if (dup.rows[0]) throw new Error('That van is already on their list');
  }
  const r = await query(
    `INSERT INTO freelancer_tasks (${col}, task_type, vehicle_id, job_id, description, sort_order, created_by)
     VALUES ($1, $2, $3, $4, $5,
             COALESCE((SELECT MAX(sort_order) + 1 FROM freelancer_tasks WHERE ${col} = $1), 0), $6)
     RETURNING id`,
    [owner.id, input.taskType, vehicleId, jobId, description, userId]
  );
  return (await getTask(r.rows[0].id))!;
}

/** Edit an OPEN task. A done or cancelled one is history — reopen it first. */
export async function updateTask(id: string, input: Partial<TaskInput>): Promise<FreelancerTask> {
  const task = await getTask(id);
  if (!task) throw new Error('That task no longer exists');
  if (task.status !== 'open') throw new Error('Only an open task can be changed');

  const vehicleId = input.vehicleId !== undefined ? (input.vehicleId ?? null) : task.vehicleId;
  const description = input.description !== undefined ? cleanDescription(input.description) : task.description;
  validateShape(task.taskType, vehicleId, description);
  await assertVehicle(vehicleId);
  const named = await resolveJob(input);
  const jobId = named === undefined ? task.jobId : named;

  await query(
    `UPDATE freelancer_tasks SET vehicle_id = $2, job_id = $3, description = $4, updated_at = NOW() WHERE id = $1`,
    [id, vehicleId, jobId, description]
  );
  return (await getTask(id))!;
}

/** Soft-cancel. Never a DELETE: the row says what was asked of somebody. */
export async function cancelTask(id: string): Promise<FreelancerTask> {
  const r = await query(
    `UPDATE freelancer_tasks SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'open' RETURNING id`,
    [id]
  );
  if (!r.rows[0]) throw new Error('Only an open task can be removed');
  return (await getTask(id))!;
}

/** Staff tick / un-tick. Un-ticking clears who did it — it was not done after all. */
export async function setDoneByStaff(id: string, done: boolean, userId: string): Promise<FreelancerTask> {
  const r = done
    ? await query(
        `UPDATE freelancer_tasks
            SET status = 'done', done_at = NOW(), done_via = 'staff',
                done_by_person = (SELECT person_id FROM users WHERE id = $2), updated_at = NOW()
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [id, userId]
      )
    : await query(
        `UPDATE freelancer_tasks
            SET status = 'open', done_at = NULL, done_via = NULL, done_by_person = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'done' RETURNING id`,
        [id]
      );
  if (!r.rows[0]) throw new Error(done ? 'Only an open task can be ticked' : 'Only a done task can be re-opened');
  if (done) await noteJobOnDone(id, userId);
  return (await getTask(id))!;
}

// ── The job's timeline ──────────────────────────────────────────────────────

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * A task that names a job was done: say so on that job's timeline (jon, Oct
 * 2026). ONLY on completion and ONLY for tasks with a job — not when a task is
 * set (they change freely), and not for preps that were never a task.
 * Best-effort: never throws, a timeline note must not undo a tick.
 */
async function noteJobOnDone(taskId: string, actorUserId: string | null): Promise<void> {
  try {
    const task = await getTask(taskId);
    if (!task?.jobId || task.status !== 'done') return;
    const ctx = await getOwnerContext(ownerOf(task));
    // The job is the page it lands on, so the title drops "for #16791".
    const what = taskTitle({ ...task, hhJobNumber: null });
    const who = ctx?.person ? fullDisplayName(ctx.person) : null;
    const role = task.shiftId ? 'studio sitter' : 'freelancer in for the day';
    const how = task.doneVia === 'prep_saved' ? 'prep sheet saved'
      : task.doneVia === 'portal' ? 'ticked on the portal'
      : `ticked off${task.doneByName ? ` by ${task.doneByName}` : ''}`;
    const content = `✅ Freelancer task done: ${what}${who ? ` — ${who} (${role})` : ''}. ${how[0].toUpperCase()}${how.slice(1)}.`;
    await query(
      `INSERT INTO interactions (type, content, job_id, created_by, source)
       VALUES ('note', $1, $2, $3, 'system')`,
      [content, task.jobId, actorUserId ?? SYSTEM_USER_ID]
    );
  } catch (err) {
    console.error('[freelancer-tasks] job timeline note failed (non-fatal):', err);
  }
}

// ── The freelancer's side ───────────────────────────────────────────────────

/**
 * Tick from the portal. Ownership first, and the same answer for "not yours"
 * and "does not exist", so the endpoint cannot probe ids. A van prep is NOT
 * ticked here — saving the prep ticks it (§21.2 decision 5).
 */
export async function markDoneFromPortal(id: string, personId: string): Promise<FreelancerTask> {
  const task = await getTask(id);
  const ctx = task ? await getOwnerContext(ownerOf(task)) : null;
  if (!task || !ctx || ctx.person?.id !== personId || task.status === 'cancelled') {
    throw Object.assign(new Error('We cannot find that task'), { status: 404 });
  }
  if (task.taskType === 'van_prep') {
    throw Object.assign(new Error('Saving the prep sheet ticks this one off'), { status: 409 });
  }
  if (task.status === 'done') return task;
  const u = await query(
    `UPDATE freelancer_tasks
        SET status = 'done', done_at = NOW(), done_via = 'portal', done_by_person = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'open'`,
    [id, personId]
  );
  if (u.rowCount) await noteJobOnDone(id, null);
  return (await getTask(id))!;
}

/**
 * Un-tick from the portal — for a mis-tap. Only a task THIS person ticked on
 * the portal: one staff ticked, or a prep sheet closed, is not theirs to undo.
 */
export async function reopenFromPortal(id: string, personId: string): Promise<FreelancerTask> {
  const task = await getTask(id);
  const ctx = task ? await getOwnerContext(ownerOf(task)) : null;
  if (!task || !ctx || ctx.person?.id !== personId || task.status === 'cancelled') {
    throw Object.assign(new Error('We cannot find that task'), { status: 404 });
  }
  if (task.status === 'open') return task;
  const r = await query(
    `UPDATE freelancer_tasks
        SET status = 'open', done_at = NULL, done_via = NULL, done_by_person = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'done' AND done_via = 'portal' AND done_by_person = $2
      RETURNING id`,
    [id, personId]
  );
  if (!r.rows[0]) throw Object.assign(new Error('That one was ticked off by the office'), { status: 409 });
  return (await getTask(id))!;
}

/**
 * A prep was saved for this van: close its open van-prep tasks on any live
 * owner dated yesterday, today or tomorrow — whoever did the prep, staff
 * included. Never throws; a failure here must not fail the prep save.
 */
export async function autoTickPrep(reg: string, personId: string | null): Promise<number> {
  try {
    const r = await query(
      `UPDATE freelancer_tasks t
          SET status = 'done', done_at = NOW(), done_via = 'prep_saved',
              done_by_person = $2, updated_at = NOW()
         FROM fleet_vehicles fv
        WHERE t.vehicle_id = fv.id
          AND UPPER(REPLACE(fv.reg, ' ', '')) = UPPER(REPLACE($1, ' ', ''))
          AND t.status = 'open' AND t.task_type = 'van_prep'
          AND (
            EXISTS (SELECT 1 FROM freelancer_day_bookings b
                     WHERE b.id = t.day_booking_id
                       AND b.status IN ('offered','accepted','completed')
                       AND b.booking_date BETWEEN $3::date - 1 AND $3::date + 1)
            OR EXISTS (SELECT 1 FROM studio_sitter_shifts s
                        WHERE s.id = t.shift_id AND s.status <> 'cancelled'
                          AND s.shift_date BETWEEN $3::date - 1 AND $3::date + 1)
          )
        RETURNING t.id`,
      [reg, personId, todayLondon()]
    );
    for (const row of r.rows) await noteJobOnDone(row.id, null);
    return r.rowCount ?? 0;
  } catch (err) {
    console.error('[freelancer-tasks] autoTickPrep failed (non-fatal):', err);
    return 0;
  }
}

// ── Who could I give this to? (phase 3, §21.4) ──────────────────────────────

export interface BookedFreelancer {
  owner: TaskOwner;
  date: string;
  personName: string;
  /** 'yard_day' (a day booking) or 'sitter' (a studio-sitter evening). */
  kind: 'yard_day' | 'sitter';
  /** Offered and not yet answered — they may not be coming. */
  unconfirmed: boolean;
  /** Vans already on their list as an open prep — so a card can say "Given to Tom". */
  vanIds: string[];
}

/**
 * Everybody booked in today or tomorrow who could be given a task: live day
 * bookings (offered or accepted) and studio-sitter evenings with a live
 * sitter. The "Give to a freelancer" button shows only when this is non-empty
 * (jon, Oct 2026) — no booked freelancer, no button. Freelancers out on
 * driving jobs are never here, by design.
 */
export async function bookedFreelancersFor(): Promise<BookedFreelancer[]> {
  const today = todayLondon();
  const r = await query(
    `SELECT 'booking' AS kind, b.id, b.booking_date::text AS d, b.status,
            NULLIF(${DISPLAY_NAME_SQL}, ' ') AS name,
            ARRAY(SELECT t.vehicle_id::text FROM freelancer_tasks t
                   WHERE t.day_booking_id = b.id AND t.status = 'open'
                     AND t.task_type = 'van_prep') AS van_ids
       FROM freelancer_day_bookings b
       JOIN people p ON p.id = b.person_id
      WHERE b.status IN ('offered','accepted')
        AND b.booking_date BETWEEN $1::date AND $1::date + 1
     UNION ALL
     SELECT 'shift' AS kind, s.id, s.shift_date::text AS d, a.status,
            NULLIF(${DISPLAY_NAME_SQL}, ' ') AS name,
            ARRAY(SELECT t.vehicle_id::text FROM freelancer_tasks t
                   WHERE t.shift_id = s.id AND t.status = 'open'
                     AND t.task_type = 'van_prep') AS van_ids
       FROM studio_sitter_shifts s
       JOIN studio_sitter_shift_assignments a
         ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
       JOIN people p ON p.id = a.person_id
      WHERE s.status <> 'cancelled'
        AND s.shift_date BETWEEN $1::date AND $1::date + 1
      ORDER BY d, name`,
    [today]
  );
  return r.rows.map((row: any) => ({
    owner: row.kind === 'booking' ? { kind: 'booking', id: row.id } : { kind: 'shift', id: row.id },
    date: String(row.d).slice(0, 10),
    personName: row.name ?? 'Freelancer',
    kind: row.kind === 'booking' ? 'yard_day' : 'sitter',
    unconfirmed: row.kind === 'booking' && row.status === 'offered',
    vanIds: Array.isArray(row.van_ids) ? row.van_ids : [],
  }));
}

// ── The prep link (§21.6) ───────────────────────────────────────────────────

export interface PrepEligible {
  task: FreelancerTask;
  personName: string;
  vehicleReg: string;
  date: string;
}

/**
 * May this person open the prep sheet for this task, right now? THE rule for
 * both minting the link and redeeming it, so the two cannot disagree: the
 * task is an open van prep, it is theirs (via its owner), the owner is live,
 * and its day is yesterday, today or tomorrow. Throws a 404 for "not yours"
 * and "does not exist" alike, a 409 for "yours, but not now".
 */
export async function assertPrepEligible(taskId: string, personId: string): Promise<PrepEligible> {
  const task = await getTask(taskId);
  const ctx = task ? await getOwnerContext(ownerOf(task)) : null;
  if (!task || !ctx || ctx.person?.id !== personId || task.status === 'cancelled') {
    throw Object.assign(new Error('We cannot find that task'), { status: 404 });
  }
  if (task.taskType !== 'van_prep' || !task.vehicleId || !task.vehicleReg) {
    throw Object.assign(new Error('That task has no prep sheet'), { status: 409 });
  }
  if (task.status === 'done') {
    throw Object.assign(new Error('That van has already been prepped'), { status: 409 });
  }
  if (!ctx.live) {
    throw Object.assign(new Error('That day is no longer going ahead'), { status: 409 });
  }
  const today = todayLondon();
  const d = new Date(`${today}T12:00:00Z`);
  const shift = (n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  if (ctx.date < shift(-1) || ctx.date > shift(1)) {
    throw Object.assign(new Error('The prep sheet opens the day before'), { status: 409 });
  }
  return {
    task,
    personName: fullDisplayName(ctx.person) || 'Freelancer',
    vehicleReg: task.vehicleReg,
    date: ctx.date,
  };
}

// ── Telling them ────────────────────────────────────────────────────────────

const esc = (s: string) => s
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function portalBase(): string {
  return (process.env.FRONTEND_PORTAL_URL || 'https://freelancer.oooshtours.co.uk').replace(/\/$/, '');
}

export type SendResult =
  | { sent: true }
  | { sent: false; why: 'gone' | 'not_live' | 'past' | 'nobody' | 'no_email' | 'failed'; detail?: string };

/**
 * Email the freelancer their current list. Staff press "Send update" when they
 * think it is needed (never an email per change); the 16:00 sitter summary
 * calls this too. Stamps last_tasks_notified_at so neither repeats itself.
 */
export async function sendTasksUpdate(owner: TaskOwner, opts: { digest?: boolean } = {}): Promise<SendResult> {
  const ctx = await getOwnerContext(owner);
  if (!ctx) return { sent: false, why: 'gone' };
  if (!ctx.live) return { sent: false, why: 'not_live' };
  if (ctx.date < todayLondon()) return { sent: false, why: 'past' };
  if (!ctx.person) return { sent: false, why: 'nobody' };
  if (!ctx.person.email) return { sent: false, why: 'no_email' };

  const tasks = (await listTasks(owner)).filter((t) => t.status === 'open');
  const dateLabel = formatBookingDate(ctx.date);
  const isTonight = owner.kind === 'shift';
  const link = owner.kind === 'shift' ? `${portalBase()}/shift/${ctx.date}` : `${portalBase()}/dashboard`;

  const items = tasks.map((t) => {
    const detail = t.taskType === 'van_prep' && t.description ? t.description : '';
    return `<li style="margin:0 0 8px;font-size:14px;color:#1e293b;line-height:1.5;">
        <strong>${esc(t.title)}</strong>${detail ? `<br><span style="color:#475569;">${esc(detail)}</span>` : ''}
      </li>`;
  }).join('');

  const intro = tasks.length === 0
    ? `There is nothing on your list for ${esc(dateLabel)} at the moment.`
    : isTonight
      ? `Here is what we would like a hand with on your shift (${esc(dateLabel)}), as well as the usual:`
      : `Here is what we would like a hand with on ${esc(dateLabel)}:`;

  const body = `
    <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Your list for ${esc(dateLabel)}</h2>
    <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">Hi ${esc(greetingName(ctx.person))},</p>
    <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">${intro}</p>
    ${items ? `<ul style="margin:0 0 16px;padding-left:20px;">${items}</ul>` : ''}
    <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
      The portal always has the latest version${opts.digest ? ' — anything we add after this will show up there' : ''}.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
      <tr><td style="background-color:#7c3aed;border-radius:6px;">
        <a href="${esc(link)}" style="display:inline-block;padding:12px 24px;font-size:15px;color:#ffffff;text-decoration:none;font-weight:600;">Open the portal</a>
      </td></tr>
    </table>`;

  let result;
  try {
    result = await emailService.send('freelancer_tasks_updated', {
      to: ctx.person.email,
      subjectOverride: `Your list for ${dateLabel}`,
      bodyHtmlOverride: body,
    });
  } catch (err) {
    console.error('[freelancer-tasks] send threw:', err);
    return { sent: false, why: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!result.success) return { sent: false, why: 'failed', detail: result.error };

  await query(
    owner.kind === 'booking'
      ? `UPDATE freelancer_day_bookings SET last_tasks_notified_at = NOW() WHERE id = $1`
      : `UPDATE studio_sitter_shifts SET last_tasks_notified_at = NOW() WHERE id = $1`,
    [owner.id]
  );
  return { sent: true };
}

/**
 * 16:00 — tonight's sitter gets ONE summary, only if there are open tasks and
 * something changed since they were last told (jon, Oct 2026). No tasks, no
 * email. Changes after 16:00 are not chased: they will be on the portal.
 */
export async function runSitterTaskDigest(): Promise<number> {
  const r = await query(
    `SELECT s.id
       FROM studio_sitter_shifts s
       JOIN studio_sitter_shift_assignments a
         ON a.shift_id = s.id AND a.status IN ('assigned','confirmed')
      WHERE s.shift_date = $1::date AND s.status <> 'cancelled'
        AND EXISTS (SELECT 1 FROM freelancer_tasks t WHERE t.shift_id = s.id AND t.status = 'open')
        AND (s.last_tasks_notified_at IS NULL
             OR EXISTS (SELECT 1 FROM freelancer_tasks t
                         WHERE t.shift_id = s.id AND t.updated_at > s.last_tasks_notified_at))`,
    [todayLondon()]
  );
  let sent = 0;
  for (const row of r.rows) {
    const res = await sendTasksUpdate({ kind: 'shift', id: row.id }, { digest: true });
    if (res.sent) sent++;
    else console.warn(`[freelancer-tasks] sitter digest not sent for shift ${row.id}: ${res.why}`);
  }
  return sent;
}
