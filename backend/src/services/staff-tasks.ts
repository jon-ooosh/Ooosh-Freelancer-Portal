/**
 * staff_tasks — "things that need doing", owned by a person.
 *
 * docs/STAFF-RECORDS-SPEC.md §6. Built general (source_type / source_id) and
 * wired to one consumer: Phase 3 ships the manual source and the My To Do tab,
 * Phase 4 will create tasks with source_type 'staff_review' when a review
 * agrees an action.
 *
 * WHO SEES WHAT — the one rule this file exists to keep in one place:
 *   * Everybody sees and manages THEIR OWN tasks. This is not an admin module;
 *     a to-do list nobody but an admin can tick is not a to-do list.
 *   * Admins can additionally create tasks for other people, and read anyone's.
 *   * Nobody else can see anyone else's. `assertCanTouch` is the chokepoint.
 *
 * Review actions land here rather than in a review-shaped table so that an
 * action the COMPANY owes appears on the responsible person's own list beside
 * everything else — spec §6.2. That is the mechanism that stops it lapsing.
 */

import { query } from '../config/database';
import { STAFF_ADMIN_ROLES } from './staff-employment';

export const TASK_STATUSES = ['open', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskInput {
  title: string;
  detail?: string | null;
  dueDate?: string | null;
  personId?: string;
  sourceType?: string;
  sourceId?: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const SELECT_TASKS = `
  SELECT t.id, t.person_id, t.title, t.detail,
         t.due_date::text AS due_date, t.status,
         t.source_type, t.source_id,
         t.created_at, t.completed_at,
         NULLIF(TRIM(COALESCE(op.preferred_name, op.first_name, '') || ' ' ||
                     COALESCE(op.last_name, '')), '') AS owner_name
    FROM staff_tasks t
    JOIN people op ON op.id = t.person_id`;

export async function personIdForUser(userId: string): Promise<string | null> {
  const r = await query('SELECT person_id FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.person_id ?? null;
}

function isAdmin(role: string | undefined): boolean {
  return (STAFF_ADMIN_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * Throws unless this user owns the task or is an admin. Every read and write
 * of somebody else's row goes through here — it is the only thing standing
 * between "my list" and "everyone's list".
 */
async function assertCanTouch(taskId: string, userId: string, role: string | undefined) {
  const r = await query('SELECT person_id FROM staff_tasks WHERE id = $1', [taskId]);
  if (!r.rows.length) throw new Error('Task not found');
  if (isAdmin(role)) return r.rows[0].person_id as string;
  const mine = await personIdForUser(userId);
  if (!mine || r.rows[0].person_id !== mine) throw new Error('Task not found');
  return r.rows[0].person_id as string;
}

/** Tasks on one person's list. `includeDone` adds recently-finished ones. */
export async function listTasks(personId: string, includeDone = false) {
  const r = await query(
    `${SELECT_TASKS}
      WHERE t.person_id = $1
        AND (t.status = 'open' OR ($2::boolean AND t.status <> 'cancelled'
             AND t.completed_at > NOW() - INTERVAL '30 days'))
      ORDER BY t.status = 'open' DESC,
               t.due_date IS NULL, t.due_date, t.created_at DESC`,
    [personId, includeDone]
  );
  return r.rows;
}

export async function createTask(input: TaskInput, userId: string, role: string | undefined) {
  const title = input.title?.trim();
  if (!title) throw new Error('A task needs a title');
  if (input.dueDate && !DATE_RE.test(input.dueDate)) throw new Error('dueDate must be YYYY-MM-DD');

  // Default to the caller. Assigning to somebody ELSE is an admin act — a
  // to-do list you can push work onto anybody's is a different product.
  let personId = input.personId;
  if (!personId) {
    const mine = await personIdForUser(userId);
    if (!mine) throw new Error('Your login is not linked to a person record');
    personId = mine;
  } else if (!isAdmin(role)) {
    const mine = await personIdForUser(userId);
    if (personId !== mine) throw new Error('Only an admin can add a task to somebody else’s list');
  }

  const r = await query(
    `INSERT INTO staff_tasks (person_id, title, detail, due_date, source_type, source_id, created_by)
     VALUES ($1, $2, $3, $4::date, COALESCE($5,'manual'), $6, $7)
     RETURNING id`,
    [personId, title, input.detail?.trim() || null, input.dueDate || null,
     input.sourceType ?? null, input.sourceId ?? null, userId]
  );
  const row = await query(`${SELECT_TASKS} WHERE t.id = $1`, [r.rows[0].id]);
  return row.rows[0];
}

export async function updateTask(
  taskId: string,
  patch: { title?: string; detail?: string | null; dueDate?: string | null; status?: TaskStatus },
  userId: string,
  role: string | undefined
) {
  await assertCanTouch(taskId, userId, role);

  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new Error('A task needs a title');
    params.push(t); sets.push(`title = $${params.length}`);
  }
  if (patch.detail !== undefined) {
    params.push(patch.detail?.trim() || null); sets.push(`detail = $${params.length}`);
  }
  if (patch.dueDate !== undefined) {
    if (patch.dueDate && !DATE_RE.test(patch.dueDate)) throw new Error('dueDate must be YYYY-MM-DD');
    params.push(patch.dueDate || null); sets.push(`due_date = $${params.length}::date`);
    // A re-dated task is a fresh promise, so it earns a fresh chase.
    sets.push('chased_at = NULL');
  }
  if (patch.status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(patch.status)) throw new Error('Unknown status');
    params.push(patch.status); sets.push(`status = $${params.length}`);
    // Stamped on the way in and cleared on the way back out, so re-opening a
    // task ticked by mistake leaves no phantom completion date behind it.
    sets.push(patch.status === 'done' ? 'completed_at = NOW()' : 'completed_at = NULL');
  }
  if (!sets.length) throw new Error('No fields to update');

  params.push(taskId);
  await query(
    `UPDATE staff_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
    params
  );
  const row = await query(`${SELECT_TASKS} WHERE t.id = $1`, [taskId]);
  return row.rows[0];
}

/** Cancel, never delete — CLAUDE.md. A dropped review action is a fact. */
export async function cancelTask(taskId: string, userId: string, role: string | undefined) {
  await assertCanTouch(taskId, userId, role);
  await query(
    `UPDATE staff_tasks SET status = 'cancelled', completed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [taskId]
  );
  return { id: taskId };
}

/** Everything a given source produced — "what did this review actually lead to". */
export async function listTasksForSource(sourceType: string, sourceId: string) {
  const r = await query(
    `${SELECT_TASKS} WHERE t.source_type = $1 AND t.source_id = $2
      ORDER BY t.due_date IS NULL, t.due_date, t.created_at`,
    [sourceType, sourceId]
  );
  return r.rows;
}

/** Open counts for a person — drives the tab badge. */
export async function openTaskCount(personId: string): Promise<{ open: number; overdue: number }> {
  const r = await query(
    `SELECT COUNT(*)::int AS open,
            COUNT(*) FILTER (WHERE due_date IS NOT NULL AND due_date < CURRENT_DATE)::int AS overdue
       FROM staff_tasks WHERE person_id = $1 AND status = 'open'`,
    [personId]
  );
  return { open: r.rows[0]?.open ?? 0, overdue: r.rows[0]?.overdue ?? 0 };
}
