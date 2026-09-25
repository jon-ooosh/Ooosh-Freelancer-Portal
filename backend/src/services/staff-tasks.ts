/**
 * staff_tasks — "things that need doing", owned by a person.
 *
 * docs/STAFF-RECORDS-SPEC.md §6. Built general (source_type / source_id) and
 * wired to one consumer: Phase 3 ships the manual source and the My To Do tab,
 * Phase 4 will create tasks with source_type 'staff_review' when a review
 * agrees an action.
 *
 * WHO SEES WHAT — the one rule this file exists to keep in one place:
 *   * Everybody manages THEIR OWN tasks. This is not an admin module; a to-do
 *     list nobody but an admin can tick is not a to-do list.
 *   * Since To Do phase 1 (docs/TASKS-SPEC.md §5) ANYONE can put a task on
 *     anyone's list, and whoever SET a task (`created_by`) can edit, reassign
 *     or drop it too. Admins can touch anything. `assertCanTouch` is the
 *     chokepoint for all of that.
 *   * Everybody can SEE everybody's open tasks (the Everyone view), except
 *     private ones — those only the owner, the setter and admins see
 *     (`listEveryone`). Review actions are private by default.
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
  /** When to nudge. Omitted → derived (see resolveChaseDate); '' → never. */
  nextChaseDate?: string | null;
  personId?: string;
  sourceType?: string;
  sourceId?: string | null;
  isPrivate?: boolean;
  /** The setter's follow-up. Omitted → derived when assigning to someone else. */
  followUpOn?: string | null;
}

/**
 * When should this task next poke somebody?
 *
 * Two genuinely different cases, and the second is the one that matters:
 *   - it HAS a due date → nudge on the day it's due, then every interval
 *     after while it stays open
 *   - it has NO due date ("sort the shelving, sometime") → nothing would ever
 *     resurface it, so default to the interval from today. This is the
 *     pipeline-chaser case (jobs.next_chase_date, mig 004) and the reason a
 *     chase date is a separate field from a due date at all.
 *
 * An explicit '' or null from the caller means "never nudge me", which is what
 * a someday-maybe item wants and must not be overwritten by a default.
 */
async function resolveChaseDate(
  explicit: string | null | undefined,
  dueDate: string | null,
): Promise<string | null> {
  if (explicit !== undefined) return explicit || null;
  if (dueDate) return dueDate;
  const { getTaskChaseDays } = await import('./staff-settings');
  const days = await getTaskChaseDays();
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today in the UK, as YYYY-MM-DD — the day staff are actually living in. */
export function todayLondon(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/**
 * Dates on a to-do look FORWARD (jon, Sep 2026): a due date or reminder in
 * the past is always a slip. But only a date being SET is checked — an
 * overdue task keeps its old due date through an unrelated edit, or fixing a
 * typo in its title would be refused. `current` is the stored value; passing
 * the same date back is not setting it.
 */
function assertForward(value: string | null | undefined, label: string, current?: string | null) {
  if (!value) return;
  if (current && value === current) return;
  if (value < todayLondon()) throw new Error(`${label} can’t be in the past`);
}

const SELECT_TASKS = `
  SELECT t.id, t.person_id, t.title, t.detail,
         t.due_date::text AS due_date, t.status,
         t.next_chase_date::text AS next_chase_date,
         t.source_type, t.source_id,
         t.created_at, t.completed_at,
         t.created_by, t.is_private,
         t.follow_up_on::text AS follow_up_on,
         t.handed_back_by, t.handed_back_reason, t.handed_back_at,
         cu.person_id AS set_by_person_id,
         NULLIF(TRIM(COALESCE(op.preferred_name, op.first_name, '') || ' ' ||
                     COALESCE(op.last_name, '')), '') AS owner_name,
         NULLIF(TRIM(COALESCE(cp.preferred_name, cp.first_name, '') || ' ' ||
                     COALESCE(cp.last_name, '')), '') AS set_by_name,
         NULLIF(TRIM(COALESCE(hb.preferred_name, hb.first_name, '') || ' ' ||
                     COALESCE(hb.last_name, '')), '') AS handed_back_by_name
    FROM staff_tasks t
    JOIN people op ON op.id = t.person_id
    LEFT JOIN users cu  ON cu.id = t.created_by
    LEFT JOIN people cp ON cp.id = cu.person_id
    LEFT JOIN people hb ON hb.id = t.handed_back_by`;

/** What the notifications need about one task, after a write. */
async function taskFacts(taskId: string) {
  const r = await query(`${SELECT_TASKS} WHERE t.id = $1`, [taskId]);
  return r.rows[0];
}

/** Display name for the person behind a login — for "Sam gave you…". */
async function nameForUser(userId: string): Promise<string | null> {
  const r = await query(
    `SELECT NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS name
       FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
    [userId]
  );
  return r.rows[0]?.name ?? null;
}

export async function personIdForUser(userId: string): Promise<string | null> {
  const r = await query('SELECT person_id FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.person_id ?? null;
}

function isAdmin(role: string | undefined): boolean {
  return (STAFF_ADMIN_ROLES as readonly string[]).includes(role ?? '');
}

interface TouchInfo {
  personId: string;
  createdBy: string | null;
  /** Stored dates, so an untouched past date isn't refused (assertForward). */
  dueDate: string | null;
  nextChaseDate: string | null;
  followUpOn: string | null;
  sourceType: string | null;
  /** Why this caller may touch it — decides what they may change. */
  as: 'admin' | 'setter' | 'owner';
}

/**
 * Throws unless this user owns the task, SET it, or is an admin. Every write
 * to somebody else's row goes through here — it is the only thing standing
 * between "my list" and "everyone's list".
 *
 * Seeing a task on the Everyone view is NOT touching it: anyone can read an
 * open, non-private task there, but only these three can change it.
 */
async function assertCanTouch(taskId: string, userId: string, role: string | undefined): Promise<TouchInfo> {
  const r = await query(
    `SELECT person_id, created_by, due_date::text AS due_date,
            next_chase_date::text AS next_chase_date, follow_up_on::text AS follow_up_on,
            source_type
       FROM staff_tasks WHERE id = $1`,
    [taskId]
  );
  if (!r.rows.length) throw new Error('Task not found');
  const row = r.rows[0];
  const base = {
    personId: row.person_id as string,
    createdBy: (row.created_by as string | null) ?? null,
    dueDate: row.due_date ?? null,
    nextChaseDate: row.next_chase_date ?? null,
    followUpOn: row.follow_up_on ?? null,
    sourceType: row.source_type ?? null,
  };
  if (isAdmin(role)) return { ...base, as: 'admin' };
  const mine = await personIdForUser(userId);
  if (mine && base.personId === mine) return { ...base, as: 'owner' };
  if (base.createdBy && base.createdBy === userId) return { ...base, as: 'setter' };
  throw new Error('Task not found');
}

/** Tasks on one person's list. `includeDone` adds recently-finished ones. */
export async function listTasks(personId: string, includeDone = false) {
  const r = await query(
    `${SELECT_TASKS}
      WHERE (
              t.person_id = $1
          AND (t.status = 'open' OR ($2::boolean AND t.status <> 'cancelled'
               AND t.completed_at > NOW() - INTERVAL '30 days'))
        )
        -- Handed back BY me: gone from my list, but kept in my recently
        -- finished for 30 days so it doesn't just vanish (jon, Sep 2026).
        -- The page greys it; it is someone else's task now.
         OR ($2::boolean AND t.handed_back_by = $1 AND t.person_id <> $1
             AND t.handed_back_at > NOW() - INTERVAL '30 days')
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

  // Default to the caller. Since To Do phase 1 anyone may put a task on
  // anyone's list (docs/TASKS-SPEC.md §5.1) — it lands with a bell, and the
  // owner can hand it back.
  const mine = await personIdForUser(userId);
  const personId = input.personId || mine;
  if (!personId) throw new Error('Your login is not linked to a person record');
  const forSomebodyElse = personId !== mine;

  // A review action is linked to its review, which is what puts it in the
  // follow-up email, the "From your review" badge and the check-in list.
  // Reviews are admin-only, so only an admin can file against one, and the
  // review must exist — the id comes from the client.
  if (input.sourceType === 'staff_review') {
    if (!isAdmin(role)) throw new Error('Only an admin can add a review action');
    const review = await query('SELECT id FROM staff_reviews WHERE id = $1', [input.sourceId]);
    if (!review.rows.length) throw new Error('Review not found');
  }

  const dueDate = input.dueDate || null;
  assertForward(dueDate, 'The due date');
  const nextChase = await resolveChaseDate(input.nextChaseDate, dueDate);
  if (nextChase && !DATE_RE.test(nextChase)) throw new Error('nextChaseDate must be YYYY-MM-DD');
  if (input.nextChaseDate !== undefined) assertForward(input.nextChaseDate, 'The reminder');

  const isReview = input.sourceType === 'staff_review';
  // The setter's follow-up only exists for a task given to somebody else — on
  // your own list, your own nudge is the whole story. Not defaulted for review
  // actions: the review's check-in (staff records §22.3) already follows those
  // up, and a bell per action on top would be noise.
  let followUp: string | null = null;
  if (input.followUpOn !== undefined) followUp = input.followUpOn || null;
  else if (forSomebodyElse && !isReview) followUp = await resolveChaseDate(undefined, dueDate);
  if (followUp && !DATE_RE.test(followUp)) throw new Error('followUpOn must be YYYY-MM-DD');
  if (input.followUpOn !== undefined) assertForward(followUp, 'The follow-up');
  // Review actions are private unless said otherwise (spec §8).
  const isPrivate = input.isPrivate ?? isReview;

  const r = await query(
    `INSERT INTO staff_tasks (person_id, title, detail, due_date, next_chase_date, source_type, source_id, created_by,
                              follow_up_on, is_private)
     VALUES ($1, $2, $3, $4::date, $5::date, COALESCE($6,'manual'), $7, $8, $9::date, $10)
     RETURNING id`,
    [personId, title, input.detail?.trim() || null, dueDate, nextChase,
     input.sourceType ?? null, input.sourceId ?? null, userId, followUp, isPrivate]
  );
  const row = await taskFacts(r.rows[0].id);

  if (forSomebodyElse) {
    const { notifyTaskAssigned } = await import('./staff-notifications');
    await notifyTaskAssigned(personId, row.id, title, await nameForUser(userId), dueDate)
      .catch(e => console.error('[staff-tasks] assigned bell failed:', e));
  }
  return row;
}

export async function updateTask(
  taskId: string,
  patch: {
    title?: string; detail?: string | null; dueDate?: string | null;
    nextChaseDate?: string | null; status?: TaskStatus;
    /** Reassign — setter or admin only. */
    personId?: string;
    /** The setter's follow-up — setter or admin only. */
    followUpOn?: string | null;
    isPrivate?: boolean;
  },
  userId: string,
  role: string | undefined
) {
  const who = await assertCanTouch(taskId, userId, role);

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
  // The chase date is decided ONCE and assigned once. Postgres rejects an
  // UPDATE that sets the same column twice ("multiple assignments to same
  // column"), so the earlier version — which appended next_chase_date for the
  // due date and again for an explicit chase date or a status change — failed
  // whenever two of those arrived together, e.g. an edit form re-dating both.
  // Precedence, lowest to highest: follows the new due date → an explicit
  // chase date → finished/dropped (never chase).
  let chase: string | null | undefined;
  if (patch.dueDate !== undefined) {
    if (patch.dueDate && !DATE_RE.test(patch.dueDate)) throw new Error('dueDate must be YYYY-MM-DD');
    assertForward(patch.dueDate, 'The due date', who.dueDate);
    params.push(patch.dueDate || null); sets.push(`due_date = $${params.length}::date`);
    // A re-dated task is a fresh promise, so it earns a fresh chase that
    // follows the new due date — unless the caller also set one explicitly.
    chase = patch.dueDate || null;
  }
  if (patch.nextChaseDate !== undefined) {
    if (patch.nextChaseDate && !DATE_RE.test(patch.nextChaseDate)) {
      throw new Error('nextChaseDate must be YYYY-MM-DD');
    }
    assertForward(patch.nextChaseDate, 'The reminder', who.nextChaseDate);
    chase = patch.nextChaseDate || null;
  }
  if (patch.status !== undefined) {
    if (!(TASK_STATUSES as readonly string[]).includes(patch.status)) throw new Error('Unknown status');
    params.push(patch.status); sets.push(`status = $${params.length}`);
    // A finished or dropped task must stop chasing. Re-opening one leaves the
    // chase date alone — whatever it was is still the right answer.
    if (patch.status !== 'open') chase = null;
    // Stamped on the way in and cleared on the way back out, so re-opening a
    // task ticked by mistake leaves no phantom completion date behind it.
    sets.push(patch.status === 'done' ? 'completed_at = NOW()' : 'completed_at = NULL');
  }
  if (chase !== undefined) {
    params.push(chase); sets.push(`next_chase_date = $${params.length}::date`);
    // A new chase date earns a fresh nudge. Not on finishing — the stamp is
    // then the record of the last nudge, and nothing will chase again anyway.
    if (!(patch.status !== undefined && patch.status !== 'open')) sets.push('chased_at = NULL');
  }

  // The setter's side. The owner can't move the setter's clock or give the
  // task to somebody else — that would let the person being chased switch
  // the chasing off. They can hand it back instead (handBackTask).
  const setterOrAdmin = who.as !== 'owner' || (!!who.createdBy && who.createdBy === userId);
  let reassignedTo: string | null = null;
  if (patch.personId !== undefined && patch.personId !== who.personId) {
    if (!setterOrAdmin) throw new Error('Only whoever set this can give it to somebody else — hand it back instead');
    // One occurrence of a repeating to-do can't wander off on its own.
    if (who.sourceType === 'staff_task_series') throw new Error('This repeats — change who it’s for on the repeating to-do');
    params.push(patch.personId); sets.push(`person_id = $${params.length}`);
    // A fresh owner, a fresh start: nothing about the last one's nudges applies.
    sets.push('handed_back_by = NULL', 'handed_back_reason = NULL', 'handed_back_at = NULL');
    reassignedTo = patch.personId;
  }
  let followUpDone = false;
  if (patch.followUpOn !== undefined) {
    if (!setterOrAdmin) throw new Error('Only whoever set this can change its follow-up');
    if (patch.followUpOn && !DATE_RE.test(patch.followUpOn)) throw new Error('followUpOn must be YYYY-MM-DD');
    assertForward(patch.followUpOn, 'The follow-up', who.followUpOn);
    params.push(patch.followUpOn || null); sets.push(`follow_up_on = $${params.length}::date`);
    sets.push('follow_up_chased_at = NULL');
    followUpDone = true;
  }
  // Finished: the setter's follow-up has nothing left to ask.
  if (!followUpDone && patch.status !== undefined && patch.status !== 'open') {
    sets.push('follow_up_on = NULL');
  }
  if (patch.isPrivate !== undefined) {
    params.push(patch.isPrivate); sets.push(`is_private = $${params.length}`);
  }
  if (!sets.length) throw new Error('No fields to update');

  params.push(taskId);
  await query(
    `UPDATE staff_tasks SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`,
    params
  );
  const row = await taskFacts(taskId);

  // Close the loop, by bell. Failures are logged, never fatal — the write
  // above is what matters.
  try {
    const n = await import('./staff-notifications');
    if (reassignedTo) {
      await n.notifyTaskAssigned(reassignedTo, taskId, row.title, await nameForUser(userId), row.due_date);
    }
    // Done by somebody other than whoever set it → tell the setter. Not for
    // each occurrence of a repeating one: a bell every Thursday that the
    // meters were read is noise; Assigned by me shows "last done" instead.
    if (patch.status === 'done' && row.created_by && row.created_by !== userId
        && row.set_by_person_id !== row.person_id && row.source_type !== 'staff_task_series') {
      await n.notifyTaskDone(row.created_by, taskId, row.title, row.owner_name);
    }
  } catch (e) {
    console.error('[staff-tasks] notify after update failed:', e);
  }

  // A repeating to-do's occurrence closed → make the next (spec §6.3).
  if (patch.status && patch.status !== 'open' && row.source_type === 'staff_task_series') {
    const { onOccurrenceClosed } = await import('./staff-task-series');
    await onOccurrenceClosed(taskId).catch(e => console.error('[staff-tasks] next occurrence failed:', e));
  }
  return row;
}

/**
 * Hand a task back to whoever set it (spec §5.1), with a reason. Owner only —
 * it's how the person being asked says "not me", so nothing assigned ever
 * silently disappears. It moves onto the setter's own list and bells them.
 */
export async function handBackTask(taskId: string, reason: string, userId: string) {
  const why = reason?.trim();
  if (!why) throw new Error('Say why you’re handing it back');
  const r = await query(
    `SELECT t.person_id, t.due_date::text AS due_date, t.status, t.created_by, t.source_type,
            cu.person_id AS setter_person
       FROM staff_tasks t LEFT JOIN users cu ON cu.id = t.created_by
      WHERE t.id = $1`,
    [taskId]
  );
  if (!r.rows.length) throw new Error('Task not found');
  const t = r.rows[0];
  const mine = await personIdForUser(userId);
  // Same "not found" rule as assertCanTouch: only the owner hands back.
  if (!mine || t.person_id !== mine) throw new Error('Task not found');
  if (t.status !== 'open') throw new Error('Only an open task can be handed back');
  if (t.source_type === 'staff_task_series') {
    throw new Error('This repeats — stop the repeating to-do instead, with a reason');
  }
  if (!t.setter_person || t.setter_person === mine) throw new Error('Nobody to hand this back to');

  // On the setter's list now, so it chases THEM like any other task of theirs.
  const chase = await resolveChaseDate(undefined, t.due_date);
  await query(
    `UPDATE staff_tasks
        SET person_id = $2, handed_back_by = $3, handed_back_reason = $4, handed_back_at = NOW(),
            follow_up_on = NULL, follow_up_chased_at = NULL,
            next_chase_date = $5::date, chased_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [taskId, t.setter_person, mine, why, chase]
  );
  const row = await taskFacts(taskId);
  try {
    const { notifyTaskHandedBack } = await import('./staff-notifications');
    await notifyTaskHandedBack(t.created_by, taskId, row.title, row.handed_back_by_name, why);
  } catch (e) {
    console.error('[staff-tasks] handed-back bell failed:', e);
  }
  return row;
}

/**
 * "Assigned by me" (spec §5.2): what I put on OTHER people's lists, open or
 * finished in the last 30 days. Things handed back to me are on my own list,
 * not here.
 */
export async function listAssignedByMe(userId: string) {
  const r = await query(
    `${SELECT_TASKS}
      WHERE t.created_by = $1
        AND cu.person_id IS DISTINCT FROM t.person_id
        AND (t.status = 'open' OR (t.status = 'done' AND t.completed_at > NOW() - INTERVAL '30 days'))
      ORDER BY t.status = 'open' DESC, t.follow_up_on NULLS LAST, t.due_date NULLS LAST, t.created_at DESC`,
    [userId]
  );
  return r.rows;
}

/**
 * Everyone's open tasks (spec §4 — jon: "everyone should see everyone").
 * Private ones only for their owner, their setter and admins. This is a READ:
 * touching any of them still goes through assertCanTouch.
 */
export async function listEveryone(userId: string, role: string | undefined) {
  const mine = await personIdForUser(userId);
  const r = await query(
    `${SELECT_TASKS}
      WHERE t.status = 'open'
        AND (NOT t.is_private OR $3::boolean OR t.person_id = $2 OR t.created_by = $1)
      ORDER BY owner_name, t.due_date NULLS LAST, t.created_at`,
    [userId, mine, isAdmin(role)]
  );
  return r.rows;
}

/**
 * Who a task can be given to: every active non-freelancer login with a person
 * behind it. A person with no login would get no bell and could never see it.
 */
export async function listAssignablePeople() {
  const { STAFF_ROLES } = await import('../middleware/auth');
  const r = await query(
    `SELECT DISTINCT p.id AS person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS name
       FROM users u JOIN people p ON p.id = u.person_id
      WHERE u.is_active = true AND u.role = ANY($1::text[])
        -- The platform's own service account (same id as in
        -- carnet-auto-email.ts / gmail-ingestion.ts) is an admin with a
        -- person row, and would otherwise be offered as somebody to ask.
        AND u.id <> '00000000-0000-0000-0000-000000000000'
      ORDER BY name`,
    [STAFF_ROLES as readonly string[]]
  );
  return r.rows as { person_id: string; name: string | null }[];
}

/** Cancel, never delete — CLAUDE.md. A dropped review action is a fact. */
export async function cancelTask(taskId: string, userId: string, role: string | undefined) {
  const who = await assertCanTouch(taskId, userId, role);
  await query(
    `UPDATE staff_tasks SET status = 'cancelled', completed_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [taskId]
  );
  // Dropping one occurrence of a repeating to-do skips it; the next is made.
  if (who.sourceType === 'staff_task_series') {
    const { onOccurrenceClosed } = await import('./staff-task-series');
    await onOccurrenceClosed(taskId).catch(e => console.error('[staff-tasks] next occurrence failed:', e));
  }
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
