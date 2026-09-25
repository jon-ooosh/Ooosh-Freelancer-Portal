/**
 * Repeating to-dos — docs/TASKS-SPEC.md §6, To Do phase 2.
 *
 * A SERIES (staff_task_series, mig 257) holds the rule. Each time one is due
 * it makes an ordinary staff_tasks row — an OCCURRENCE — linked back through
 * the existing source hook (`source_type = 'staff_task_series'`). Because an
 * occurrence is just a task, ticking, nudging, the Everyone view and privacy
 * need nothing new.
 *
 * THE RULES THIS FILE KEEPS:
 *   * At most ONE open occurrence per series. The next is made when the open
 *     one is ticked or dropped (`onOccurrenceClosed`), never in advance — so a
 *     holiday can't leave three overdue meter readings behind it. The INSERT
 *     is guarded, so a double tick can't make two.
 *   * WHEN the next one falls is decided in task-recurrence.ts, never here.
 *   * Set for somebody else, a series starts PROPOSED and makes nothing until
 *     they accept (§6.4). Set for yourself, it starts at once.
 *   * Who may change a series: its owner, whoever set it, an admin — the same
 *     three as a task. The owner of somebody else's series can accept,
 *     decline or stop it, but not rewrite it: the person being asked mustn't
 *     be able to quietly change what they were asked.
 */

import { query } from '../config/database';
import { STAFF_ADMIN_ROLES } from './staff-employment';
import { personIdForUser, todayLondon } from './staff-tasks';
import {
  validateRule, firstOnOrAfter, nextAfterClose, describe, preview,
  RecurrenceRule, Mode,
} from './task-recurrence';

export const SERIES_SOURCE = 'staff_task_series';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MODES: Mode[] = ['schedule', 'after_done'];

function isAdmin(role: string | undefined): boolean {
  return (STAFF_ADMIN_ROLES as readonly string[]).includes(role ?? '');
}

interface SeriesRow {
  id: string;
  title: string;
  detail: string | null;
  person_id: string;
  mode: Mode;
  rule: RecurrenceRule;
  starts_on: string;
  ends_on: string | null;
  ends_after: number | null;
  occurrences_made: number;
  status: 'proposed' | 'active' | 'declined' | 'ended';
  is_private: boolean;
  created_by: string | null;
}

const SERIES_COLS = `
  s.id, s.title, s.detail, s.person_id, s.mode, s.rule,
  s.starts_on::text AS starts_on, s.ends_on::text AS ends_on, s.ends_after,
  s.occurrences_made, s.status, s.decline_reason, s.ended_reason, s.is_private,
  s.created_by, s.created_at`;

async function loadSeries(id: string): Promise<SeriesRow> {
  const r = await query(`SELECT ${SERIES_COLS} FROM staff_task_series s WHERE s.id = $1`, [id]);
  if (!r.rows.length) throw new Error('Not found');
  return r.rows[0] as SeriesRow;
}

async function nameForUser(userId: string): Promise<string | null> {
  const r = await query(
    `SELECT NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS name
       FROM users u LEFT JOIN people p ON p.id = u.person_id WHERE u.id = $1`,
    [userId]
  );
  return r.rows[0]?.name ?? null;
}

/** Owner, setter or admin — the same three as a task; "Not found" otherwise. */
async function whoFor(s: SeriesRow, userId: string, role: string | undefined) {
  if (isAdmin(role)) return 'admin' as const;
  if (s.created_by && s.created_by === userId) return 'setter' as const;
  const mine = await personIdForUser(userId);
  if (mine && s.person_id === mine) return 'owner' as const;
  throw new Error('Not found');
}

/** Words for a series — the one place a rule is turned into a sentence for people. */
export function seriesText(s: Pick<SeriesRow, 'mode' | 'rule' | 'starts_on'>): string {
  return describe(s.mode, s.rule, s.starts_on);
}

/**
 * Make an occurrence due on `due`, unless the series already has an open one.
 * The guard is in the INSERT itself, so two closes racing can't make two.
 * Returns the new task id, or null when one was already open.
 */
async function spawn(s: SeriesRow, due: string): Promise<string | null> {
  const r = await query(
    `INSERT INTO staff_tasks
       (person_id, title, detail, due_date, next_chase_date, source_type, source_id, created_by, is_private)
     -- Every parameter typed: in INSERT … SELECT Postgres does NOT infer
     -- types from the target columns, so a bare $1 arrives as text and a uuid
     -- column refuses it. $5 is text in both places (CLAUDE.md, 42P08).
     SELECT $1::uuid, $2::text, $3::text, $4::date, $4::date, $5::text, $6::uuid, $7::uuid, $8::boolean
      WHERE NOT EXISTS (
        SELECT 1 FROM staff_tasks
         WHERE source_type = $5::text AND source_id = $6::uuid AND status = 'open'
      )
     RETURNING id`,
    [s.person_id, s.title, s.detail, due, SERIES_SOURCE, s.id, s.created_by, s.is_private]
  );
  if (!r.rows.length) return null;
  await query(
    `UPDATE staff_task_series SET occurrences_made = occurrences_made + 1, updated_at = NOW() WHERE id = $1`,
    [s.id]
  );
  return r.rows[0].id as string;
}

/** The first date to make, on or after `from` (a proposed series accepted late moves forward). */
function firstDue(s: Pick<SeriesRow, 'mode' | 'rule' | 'starts_on'>, from: string): string | null {
  const start = s.starts_on > from ? s.starts_on : from;
  return s.mode === 'schedule' ? firstOnOrAfter(s.rule, s.starts_on, start) : start;
}

/** True when `due` would be past the series' end, by date or by count. */
function beyondEnd(s: SeriesRow, due: string | null, alreadyMade: number): boolean {
  if (!due) return true;
  if (s.ends_on && due > s.ends_on) return true;
  if (s.ends_after && alreadyMade >= s.ends_after) return true;
  return false;
}

async function endQuietly(id: string, reason: string) {
  await query(
    `UPDATE staff_task_series SET status = 'ended', ended_reason = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'active'`,
    [id, reason]
  );
}

// ── Create ──────────────────────────────────────────────────────────────────

export interface SeriesInput {
  title: string;
  detail?: string | null;
  personId?: string;
  mode: Mode;
  rule: unknown;
  startsOn: string;
  endsOn?: string | null;
  endsAfter?: number | null;
  isPrivate?: boolean;
}

function checkInput(input: Pick<SeriesInput, 'mode' | 'rule' | 'startsOn' | 'endsOn' | 'endsAfter'>) {
  if (!MODES.includes(input.mode)) throw new Error('Unknown repeat mode');
  if (!DATE_RE.test(input.startsOn)) throw new Error('Pick a start date');
  const rule = validateRule(input.rule, input.startsOn);
  if (input.endsOn && (!DATE_RE.test(input.endsOn) || input.endsOn < input.startsOn)) {
    throw new Error('The end date must be after the start');
  }
  if (input.endsAfter != null && (!Number.isInteger(input.endsAfter) || input.endsAfter < 1)) {
    throw new Error('Ends after at least 1 time');
  }
  return rule;
}

export async function createSeries(input: SeriesInput, userId: string) {
  const title = input.title?.trim();
  if (!title) throw new Error('A to-do needs a title');
  if (input.startsOn < todayLondon()) throw new Error('A repeating to-do can’t start in the past');
  const rule = checkInput(input);

  const mine = await personIdForUser(userId);
  const personId = input.personId || mine;
  if (!personId) throw new Error('Your login is not linked to a person record');
  const forSomebodyElse = personId !== mine;

  const r = await query(
    `INSERT INTO staff_task_series
       (title, detail, person_id, mode, rule, starts_on, ends_on, ends_after, status, is_private, created_by)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::date, $7::date, $8, $9, $10, $11)
     RETURNING id`,
    [title, input.detail?.trim() || null, personId, input.mode, JSON.stringify(rule),
     input.startsOn, input.endsOn || null, input.endsAfter ?? null,
     forSomebodyElse ? 'proposed' : 'active', !!input.isPrivate, userId]
  );
  const s = await loadSeries(r.rows[0].id);

  if (forSomebodyElse) {
    // Nothing is made until they say yes (§6.4).
    try {
      const { notifySeriesProposed } = await import('./staff-notifications');
      await notifySeriesProposed(personId, s.id, title, await nameForUser(userId), seriesText(s));
    } catch (e) { console.error('[task-series] proposed bell failed:', e); }
  } else {
    const due = firstDue(s, todayLondon());
    if (due) await spawn(s, due);
  }
  return getSeries(s.id);
}

// ── Respond / end / edit ────────────────────────────────────────────────────

/** Accept or decline a proposed series — its owner only (§6.4). */
export async function respondToSeries(id: string, accept: boolean, reason: string | null, userId: string) {
  const s = await loadSeries(id);
  const mine = await personIdForUser(userId);
  if (!mine || s.person_id !== mine) throw new Error('Not found');
  if (s.status !== 'proposed') throw new Error('This isn’t waiting on you any more');
  if (!accept && !reason?.trim()) throw new Error('Say why you’re declining');

  if (accept) {
    await query(`UPDATE staff_task_series SET status = 'active', updated_at = NOW() WHERE id = $1`, [id]);
    const due = firstDue(s, todayLondon());
    if (due) await spawn({ ...s, status: 'active' }, due);
  } else {
    await query(
      `UPDATE staff_task_series SET status = 'declined', decline_reason = $2, updated_at = NOW() WHERE id = $1`,
      [id, reason!.trim()]
    );
  }
  if (s.created_by) {
    try {
      const { notifySeriesResponse } = await import('./staff-notifications');
      const owner = await nameForUser(userId);
      await notifySeriesResponse(s.created_by, id, s.title, owner, accept, reason?.trim() || null);
    } catch (e) { console.error('[task-series] response bell failed:', e); }
  }
  return getSeries(id);
}

/**
 * Stop a series: nothing more is made. The one already open stays — it's a
 * real thing somebody may be halfway through; drop it separately if not.
 */
export async function endSeries(id: string, reason: string | null, userId: string, role: string | undefined) {
  const s = await loadSeries(id);
  const who = await whoFor(s, userId, role);
  if (s.status === 'ended') return getSeries(id);
  await query(
    `UPDATE staff_task_series SET status = 'ended', ended_reason = $2, updated_at = NOW() WHERE id = $1`,
    [id, reason?.trim() || null]
  );
  // Tell the other party, when there is one.
  try {
    const n = await import('./staff-notifications');
    const byName = await nameForUser(userId);
    if (who === 'owner' && s.created_by && s.created_by !== userId) {
      await n.notifySeriesEnded(s.created_by, null, id, s.title, byName, reason?.trim() || null);
    } else if (who !== 'owner') {
      const mine = await personIdForUser(userId);
      if (mine !== s.person_id) await n.notifySeriesEnded(null, s.person_id, id, s.title, byName, reason?.trim() || null);
    }
  } catch (e) { console.error('[task-series] ended bell failed:', e); }
  return getSeries(id);
}

export interface SeriesPatch {
  title?: string;
  detail?: string | null;
  mode?: Mode;
  rule?: unknown;
  endsOn?: string | null;
  endsAfter?: number | null;
  isPrivate?: boolean;
  personId?: string;
}

/**
 * Edit a series — whoever set it, or an admin (§6.4: the person asked can
 * accept, decline or stop, not rewrite). Changes apply from the NEXT one; the
 * open occurrence keeps its date (move that on the task itself) but takes a
 * new title. Giving it to somebody else makes it a new proposal to them.
 */
export async function updateSeries(id: string, patch: SeriesPatch, userId: string, role: string | undefined) {
  const s = await loadSeries(id);
  const who = await whoFor(s, userId, role);
  const mine = await personIdForUser(userId);
  const selfSet = s.created_by === userId && s.person_id === mine;
  if (who === 'owner' && !selfSet) {
    throw new Error('Only whoever set this can change it — you can stop it, or decline it');
  }

  const mode = patch.mode ?? s.mode;
  const rule = patch.rule !== undefined
    ? checkInput({ mode, rule: patch.rule, startsOn: s.starts_on, endsOn: patch.endsOn, endsAfter: patch.endsAfter })
    : s.rule;
  if (patch.mode && !MODES.includes(patch.mode)) throw new Error('Unknown repeat mode');

  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => { params.push(v); sets.push(sql.replace('?', `$${params.length}`)); };
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new Error('A to-do needs a title');
    add('title = ?', t);
  }
  if (patch.detail !== undefined) add('detail = ?', patch.detail?.trim() || null);
  if (patch.mode !== undefined) add('mode = ?', mode);
  if (patch.rule !== undefined) add('rule = ?::jsonb', JSON.stringify(rule));
  if (patch.endsOn !== undefined) {
    if (patch.endsOn && !DATE_RE.test(patch.endsOn)) throw new Error('Pick an end date');
    add('ends_on = ?::date', patch.endsOn || null);
  }
  if (patch.endsAfter !== undefined) add('ends_after = ?', patch.endsAfter ?? null);
  if (patch.isPrivate !== undefined) add('is_private = ?', patch.isPrivate);

  let newOwner: string | null = null;
  if (patch.personId && patch.personId !== s.person_id) {
    newOwner = patch.personId;
    add('person_id = ?', newOwner);
    // Somebody new is being asked, so they're asked (§6.4) — unless it's
    // coming back to whoever set it.
    const backToSetter = newOwner === mine && s.created_by === userId;
    sets.push(`status = '${backToSetter ? 'active' : 'proposed'}'`, 'decline_reason = NULL');
  }
  if (!sets.length) throw new Error('Nothing to change');

  params.push(id);
  await query(`UPDATE staff_task_series SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length}`, params);

  // The open occurrence follows the words; its date stays where it is.
  if (patch.title !== undefined || patch.detail !== undefined || patch.isPrivate !== undefined) {
    await query(
      `UPDATE staff_tasks SET title = COALESCE($2, title), detail = CASE WHEN $3::boolean THEN $4 ELSE detail END,
              is_private = COALESCE($5, is_private), updated_at = NOW()
        WHERE source_type = $6::text AND source_id = $1 AND status = 'open'`,
      [id, patch.title?.trim() ?? null, patch.detail !== undefined, patch.detail?.trim() || null,
       patch.isPrivate ?? null, SERIES_SOURCE]
    );
  }
  if (newOwner) {
    // A new owner starts clean: the old owner's open one is dropped, and the
    // new owner's first is made when they accept (or now, if it's the setter).
    await query(
      `UPDATE staff_tasks SET status = 'cancelled', next_chase_date = NULL, updated_at = NOW()
        WHERE source_type = $1 AND source_id = $2 AND status = 'open'`,
      [SERIES_SOURCE, id]
    );
    const fresh = await loadSeries(id);
    if (fresh.status === 'active') {
      const due = firstDue(fresh, todayLondon());
      if (due) await spawn(fresh, due);
    } else {
      try {
        const { notifySeriesProposed } = await import('./staff-notifications');
        await notifySeriesProposed(newOwner, id, fresh.title, await nameForUser(userId), seriesText(fresh));
      } catch (e) { console.error('[task-series] proposed bell failed:', e); }
    }
  }
  return getSeries(id);
}

// ── The next one ────────────────────────────────────────────────────────────

/**
 * Called when an occurrence is ticked or dropped (staff-tasks.ts). Makes the
 * next one, or ends the series when it has run its course. A closed
 * occurrence of a series that isn't active makes nothing.
 */
export async function onOccurrenceClosed(taskId: string): Promise<void> {
  const t = await query(
    `SELECT source_id, due_date::text AS due_date FROM staff_tasks
      WHERE id = $1 AND source_type = $2`,
    [taskId, SERIES_SOURCE]
  );
  if (!t.rows.length || !t.rows[0].source_id) return;
  const s = await loadSeries(t.rows[0].source_id).catch(() => null);
  if (!s || s.status !== 'active') return;

  const next = nextAfterClose(s.mode, s.rule, s.starts_on, { today: todayLondon(), closedDue: t.rows[0].due_date });
  if (beyondEnd(s, next, s.occurrences_made)) {
    await endQuietly(s.id, 'Ran its course');
    return;
  }
  await spawn(s, next!);
}

/**
 * The daily safety net (09:45): an ACTIVE series with no open occurrence gets
 * one. That only happens if the make-the-next step failed — a crash between
 * ticking and spawning — so this is a repair, not the mechanism.
 */
export async function ensureSeriesOccurrences(): Promise<{ made: number }> {
  const r = await query(
    `SELECT ${SERIES_COLS} FROM staff_task_series s
      WHERE s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM staff_tasks t
                         WHERE t.source_type = $1 AND t.source_id = s.id AND t.status = 'open')`,
    [SERIES_SOURCE]
  );
  let made = 0;
  const today = todayLondon();
  for (const s of r.rows as SeriesRow[]) {
    // Count on from the LAST occurrence, not from the start — otherwise the
    // repair re-makes a date that was already done (caught in testing: it
    // re-created a done 1 Oct). A series that never made one starts fresh.
    const last = await query(
      `SELECT MAX(due_date)::text AS due FROM staff_tasks WHERE source_type = $1 AND source_id = $2`,
      [SERIES_SOURCE, s.id]
    );
    const lastDue: string | null = last.rows[0]?.due ?? null;
    const due = !lastDue
      ? firstDue(s, today)
      // after_done: the step that should have made it failed, so it's due now.
      : s.mode === 'after_done' ? today
      : nextAfterClose(s.mode, s.rule, s.starts_on, { today, closedDue: lastDue });
    if (beyondEnd(s, due, s.occurrences_made)) { await endQuietly(s.id, 'Ran its course'); continue; }
    if (await spawn(s, due!)) made++;
  }
  if (made) console.log(`[task-series] safety net made ${made} missing occurrence(s)`);
  return { made };
}

// ── Reading ─────────────────────────────────────────────────────────────────

const SERIES_SELECT = `
  SELECT ${SERIES_COLS},
         cu.person_id AS set_by_person_id,
         NULLIF(TRIM(COALESCE(op.preferred_name, op.first_name, '') || ' ' ||
                     COALESCE(op.last_name, '')), '') AS owner_name,
         NULLIF(TRIM(COALESCE(cp.preferred_name, cp.first_name, '') || ' ' ||
                     COALESCE(cp.last_name, '')), '') AS set_by_name,
         nx.id AS open_task_id, nx.due_date::text AS next_on,
         (SELECT MAX(d.completed_at) FROM staff_tasks d
           WHERE d.source_type = '${SERIES_SOURCE}' AND d.source_id = s.id AND d.status = 'done') AS last_done_at
    FROM staff_task_series s
    JOIN people op ON op.id = s.person_id
    LEFT JOIN users cu  ON cu.id = s.created_by
    LEFT JOIN people cp ON cp.id = cu.person_id
    LEFT JOIN LATERAL (
      SELECT t.id, t.due_date FROM staff_tasks t
       WHERE t.source_type = '${SERIES_SOURCE}' AND t.source_id = s.id AND t.status = 'open'
       ORDER BY t.due_date LIMIT 1
    ) nx ON true`;

function withText<T extends { mode: Mode; rule: RecurrenceRule; starts_on: string }>(rows: T[]) {
  return rows.map(r => ({ ...r, rule_text: seriesText(r) }));
}

export async function getSeries(id: string) {
  const r = await query(`${SERIES_SELECT} WHERE s.id = $1`, [id]);
  return withText(r.rows)[0];
}

/** Mine: series on my list — waiting on me, running, or declined/ended recently. */
export async function listMySeries(personId: string) {
  const r = await query(
    `${SERIES_SELECT}
      WHERE s.person_id = $1
        AND (s.status IN ('proposed', 'active') OR s.updated_at > NOW() - INTERVAL '30 days')
      ORDER BY s.status = 'proposed' DESC, s.status = 'active' DESC, s.title`,
    [personId]
  );
  return withText(r.rows);
}

/** Assigned by me: series I set for OTHER people, with how they're going. */
export async function listSeriesSetByMe(userId: string) {
  const r = await query(
    `${SERIES_SELECT}
      WHERE s.created_by = $1
        AND cu.person_id IS DISTINCT FROM s.person_id
        AND (s.status IN ('proposed', 'active') OR s.updated_at > NOW() - INTERVAL '30 days')
      ORDER BY s.status = 'active' DESC, s.title`,
    [userId]
  );
  return withText(r.rows);
}

/**
 * Everyone: every running or proposed series, minus private ones unless you
 * own, set or administer them — the same privacy rule as tasks (§8). How an
 * admin finds a leaver's series to re-assign (§6.5).
 */
export async function listAllSeries(userId: string, role: string | undefined) {
  const mine = await personIdForUser(userId);
  const r = await query(
    `${SERIES_SELECT}
      WHERE s.status IN ('proposed', 'active')
        AND (NOT s.is_private OR $3::boolean OR s.person_id = $2 OR s.created_by = $1)
      ORDER BY owner_name, s.title`,
    [userId, mine, isAdmin(role)]
  );
  return withText(r.rows);
}

/** For the form: what a rule means and when it would fall. No writes. */
export function previewSeries(input: { mode: Mode; rule: unknown; startsOn: string }) {
  if (!MODES.includes(input.mode)) throw new Error('Unknown repeat mode');
  const rule = validateRule(input.rule, input.startsOn);
  return {
    rule,
    text: describe(input.mode, rule, input.startsOn),
    dates: preview(input.mode, rule, input.startsOn, 3),
  };
}

/** Needs attention (§6.5): repeating to-dos still on somebody who has left. */
export async function listLeaverSeries() {
  const r = await query(
    `SELECT s.person_id, COUNT(*)::int AS n,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_task_series s
       JOIN staff_employment se ON se.person_id = s.person_id AND se.employment_status = 'left'
       JOIN people p ON p.id = s.person_id
      WHERE s.status IN ('proposed', 'active')
      GROUP BY s.person_id, person_name`
  );
  return r.rows as { person_id: string; n: number; person_name: string | null }[];
}
