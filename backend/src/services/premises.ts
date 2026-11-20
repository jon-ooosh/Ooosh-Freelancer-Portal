/**
 * Premises & compliance — docs/PREMISES-COMPLIANCE-SPEC.md (phase 1).
 *
 * Operations › Premises & compliance: the checks that keep the buildings, the
 * yard and the company legal, insured and serviced; a record (with its
 * certificates) every time one is done; and the owner's reminder as a To Do.
 *
 * THE RULES THIS FILE KEEPS:
 *   * A check you can't see does not exist for you (spec §1.5) — every read
 *     filters by visibility, and a hidden check answers 404, not 403.
 *   * Nobody sets a check to a visibility they couldn't see themselves, and a
 *     check's owner must be able to see it (or their reminder would point at
 *     a page they can't open).
 *   * ONE open reminder To Do per check (`source_type = 'premises_check'`),
 *     kept right by syncCheckReminder() after every write and each morning.
 *     A To Do ticked by hand without recording isn't made again for the same
 *     due date (`reminded_for_due`) — the register still shows it red.
 *   * When it is next due comes from premises-rules.ts on top of
 *     task-recurrence.ts — never date arithmetic here.
 *   * Only a record at least as recent as the latest one moves the due date:
 *     typing in last year's certificate must not wind the clock back.
 *   * Nothing is deleted except a check added by mistake with no records.
 */
import { query, getClient } from '../config/database';
import { ukToday, ukDatePlus } from './uk-date';
import { validateRule, firstOnOrAfter, describe, RecurrenceRule, Mode } from './task-recurrence';
import {
  CHECK_KINDS, VISIBILITIES, OUTCOMES, CheckKind, Visibility,
  canSee, canSetVisibility, visibleLevels, roleRank, checkStatus, daysBetween,
  reminderWanted, reminderTitle, nextDueAfterRecord, dateLabel,
  nextPoint, cleanPoints, usageSeries, assessReading, Reading, effectiveVisibility, bookingTitle,
} from './premises-rules';
import { createTask, cancelTask, updateTask, listTasksForSource } from './staff-tasks';
import { PremisesError } from './premises-errors';
import { listAssignableStaff } from './assignable-staff';

export const PREMISES_PREFIX = 'premises/';
export const REMINDER_SOURCE = 'premises_check';
export const FIX_SOURCE = 'premises_fix';
/** A To Do made from an advisory on a record. */
export const ADVISORY_SOURCE = 'premises_advisory';

/** The platform's own service account — same id as marketing-content.ts / carnet-auto-email.ts. */
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
const MODES: Mode[] = ['schedule', 'after_done'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export { PremisesError };

export interface Caller { userId: string; role: string | undefined }

function isManager(role: string | undefined): boolean { return roleRank(role) >= 1; }
function isAdmin(role: string | undefined): boolean { return roleRank(role) >= 2; }

// ── Reading ─────────────────────────────────────────────────────────────────

const OWNER_NAME = `NULLIF(TRIM(COALESCE(NULLIF(op.preferred_name, ''), op.first_name, '') || ' ' || COALESCE(op.last_name, '')), '')`;

/** Every column as the screens want it. Dates as text: node-postgres turns a DATE into local midnight. */
const CHECK_SELECT = `
  SELECT c.id, c.title, c.kind, c.heading_id, c.place_id, c.visibility,
         c.owner_person_id, c.contractor_org_id, c.responsibility,
         c.repeat_mode, c.repeat_rule, c.repeat_anchor::text AS repeat_anchor,
         c.next_due::text AS next_due, c.next_due_source, c.remind_days_before,
         c.location_note, c.why_note, c.notes, c.unit, c.meter_serial, c.points,
         c.retired_at, c.retired_reason, c.created_at, c.updated_at,
         h.name AS heading_name, h.sort_order AS heading_sort,
         p.name AS place_name, p.sort_order AS place_sort,
         ${OWNER_NAME} AS owner_name,
         o.name AS contractor_name,
         lr.done_on AS last_done_on, lr.outcome AS last_outcome,
         lf.id AS current_file_id, lf.r2_key AS current_file_key, lf.filename AS current_file_name,
         c.staff_document_id, sd.title AS staff_document_title,
         bk.id AS booking_id, bk.visit_on AS booking_on, bk.visit_time AS booking_time, bk.note AS booking_note,
         bk.letting_in_person_id AS booking_letting_in_person_id, bk.letting_in_name AS booking_letting_in_name
    FROM premises_checks c
    JOIN premises_headings h ON h.id = c.heading_id
    JOIN premises_places p ON p.id = c.place_id
    LEFT JOIN people op ON op.id = c.owner_person_id
    LEFT JOIN organisations o ON o.id = c.contractor_org_id
    LEFT JOIN LATERAL (
      SELECT r.done_on::text AS done_on, r.outcome
        FROM premises_records r
       WHERE r.check_id = c.id AND r.removed_at IS NULL
       ORDER BY r.done_on DESC, r.created_at DESC LIMIT 1
    ) lr ON true
    LEFT JOIN LATERAL (
      SELECT f.id, f.r2_key, f.filename
        FROM premises_files f
        JOIN premises_records r2 ON r2.id = f.record_id
       WHERE r2.check_id = c.id AND r2.removed_at IS NULL AND f.archived_at IS NULL
       ORDER BY r2.done_on DESC, f.created_at DESC LIMIT 1
    ) lf ON true
    LEFT JOIN staff_documents sd ON sd.id = c.staff_document_id
    LEFT JOIN LATERAL (
      SELECT b.id, b.visit_on::text AS visit_on, b.visit_time, b.note, b.letting_in_person_id,
             NULLIF(TRIM(COALESCE(NULLIF(bp.preferred_name, ''), bp.first_name, '') || ' ' || COALESCE(bp.last_name, '')), '') AS letting_in_name
        FROM premises_bookings b
        LEFT JOIN people bp ON bp.id = b.letting_in_person_id
       WHERE b.check_id = c.id AND b.status = 'booked'
       LIMIT 1
    ) bk ON true`;

interface CheckRow {
  id: string; title: string; kind: CheckKind; heading_id: string; place_id: string; visibility: Visibility;
  owner_person_id: string | null; contractor_org_id: string | null; responsibility: 'ours' | 'landlord';
  repeat_mode: Mode | null; repeat_rule: RecurrenceRule | null; repeat_anchor: string | null;
  next_due: string | null; next_due_source: string | null; remind_days_before: number;
  location_note: string | null; why_note: string | null; notes: string | null;
  unit: string | null; meter_serial: string | null; points: string[];
  retired_at: string | null; retired_reason: string | null;
  owner_name: string | null; [k: string]: unknown;
}

/** The words for how often it comes round — the engine's own, never a second copy. */
function repeatText(row: Pick<CheckRow, 'repeat_mode' | 'repeat_rule' | 'repeat_anchor'>, today: string): string {
  if (!row.repeat_mode || !row.repeat_rule) return 'One-off';
  try { return describe(row.repeat_mode, row.repeat_rule, row.repeat_anchor || today); } catch { return 'Repeats'; }
}

function decorate(row: CheckRow, today: string) {
  return {
    ...row,
    status: checkStatus(row.next_due, row.remind_days_before, today),
    days_to_due: row.next_due ? daysBetween(today, row.next_due) : null,
    repeat_text: repeatText(row, today),
  };
}

async function loadCheckRow(id: string): Promise<CheckRow | null> {
  const r = await query(`${CHECK_SELECT} WHERE c.id = $1`, [id]);
  return (r.rows[0] as CheckRow | undefined) ?? null;
}

/** A check the caller may see, or 404 — a hidden check doesn't exist for them. */
async function visibleCheck(id: string, role: string | undefined): Promise<CheckRow> {
  const row = await loadCheckRow(id);
  if (!row || !canSee(role, row.visibility)) throw new PremisesError('Check not found', 404);
  return row;
}

export async function listChecks(role: string | undefined, includeRetired: boolean) {
  const today = ukToday();
  const r = await query(
    `${CHECK_SELECT}
      WHERE c.visibility = ANY($1::text[])
        ${includeRetired ? '' : 'AND c.retired_at IS NULL'}
      ORDER BY h.sort_order, h.name, c.next_due NULLS LAST, c.title`,
    [visibleLevels(role)],
  );
  return (r.rows as CheckRow[]).map(row => decorate(row, today));
}

export async function getCheck(id: string, role: string | undefined) {
  const today = ukToday();
  const row = await visibleCheck(id, role);
  const records = await query(
    `SELECT r.id, r.done_on::text AS done_on, r.outcome, r.reading_value::float8 AS reading_value, r.meter_replaced, r.notes,
            r.point, r.backfilled, r.cost_id,
            CASE WHEN co.id IS NULL THEN NULL ELSE json_build_object(
              'id', co.id, 'supplier_name', co.supplier_name, 'invoice_number', co.invoice_number,
              'cost_date', to_char(co.cost_date, 'YYYY-MM-DD'),
              'amount_net', co.amount_net::float8, 'amount_gross', co.amount_gross::float8) END AS cost,
            COALESCE((
              SELECT json_agg(json_build_object('id', a.id, 'text', a.text, 'done_at', a.done_at,
                                                'task_id', a.task_id, 'task_status', t.status,
                                                'task_owner', NULLIF(TRIM(COALESCE(NULLIF(tp.preferred_name, ''), tp.first_name, '') || ' ' || COALESCE(tp.last_name, '')), ''))
                              ORDER BY a.created_at)
                FROM premises_advisories a
                LEFT JOIN staff_tasks t ON t.id = a.task_id
                LEFT JOIN people tp ON tp.id = t.person_id
               WHERE a.record_id = r.id
            ), '[]'::json) AS advisories,
            r.next_due_set::text AS next_due_set, r.next_due_source, r.created_at,
            r.done_by_org_id, o.name AS done_by_org_name,
            NULLIF(TRIM(COALESCE(NULLIF(rp.preferred_name, ''), rp.first_name, '') || ' ' || COALESCE(rp.last_name, '')), '') AS recorded_by_name,
            COALESCE((
              SELECT json_agg(json_build_object('id', f.id, 'r2_key', f.r2_key, 'filename', f.filename,
                                                'content_type', f.content_type, 'size_bytes', f.size_bytes,
                                                'uploaded_by', f.uploaded_by)
                              ORDER BY f.created_at)
                FROM premises_files f WHERE f.record_id = r.id AND f.archived_at IS NULL
            ), '[]'::json) AS files
       FROM premises_records r
       LEFT JOIN organisations o ON o.id = r.done_by_org_id
       LEFT JOIN costs co ON co.id = r.cost_id
       LEFT JOIN users ru ON ru.id = r.recorded_by
       LEFT JOIN people rp ON rp.id = ru.person_id
      WHERE r.check_id = $1 AND r.removed_at IS NULL
      ORDER BY r.done_on DESC, r.created_at DESC`,
    [id],
  );
  const open = (await listTasksForSource(REMINDER_SOURCE, id) as Array<{ id: string; status: string; owner_name: string | null; due_date: string | null }>)
    .filter(t => t.status === 'open')
    .map(t => ({ id: t.id, owner_name: t.owner_name, due_date: t.due_date }));
  const recs = records.rows as Array<{ done_on: string; reading_value: number | null; meter_replaced: boolean; point: string | null }>;
  // Meter readings: use between readings, oldest first (the chart).
  const usage = row.kind === 'reading' ? usageSeries(readingsOf(recs)) : [];
  // The call point the next test should try (rotation, premises-rules.ts).
  const next_point = nextPoint(row.points, recs.find(r => r.point)?.point ?? null);
  // What it has cost, by the year it was done (ex VAT, from the bills linked in Costs).
  const byYear = await query(
    `SELECT EXTRACT(YEAR FROM r.done_on)::int AS year, SUM(co.amount_net)::float8 AS net, COUNT(*)::int AS bills
       FROM premises_records r JOIN costs co ON co.id = r.cost_id
      WHERE r.check_id = $1 AND r.removed_at IS NULL
      GROUP BY 1 ORDER BY 1 DESC`, [id]);
  return {
    ...decorate(row, today), records: records.rows, open_reminder: open[0] ?? null, usage, next_point,
    cost_by_year: byYear.rows,
  };
}

/** A meter's readings from its records (records with no value are skipped). */
function readingsOf(recs: Array<{ done_on: string; reading_value: number | null; meter_replaced: boolean }>): Reading[] {
  return recs
    .filter(r => r.reading_value !== null && r.reading_value !== undefined)
    .map(r => ({ done_on: r.done_on, value: Number(r.reading_value), meter_replaced: !!r.meter_replaced }));
}

/** The best role any of a person's active logins has — what they could see. */
async function personRank(personId: string): Promise<number> {
  const r = await query(`SELECT role FROM users WHERE person_id = $1 AND is_active = true`, [personId]);
  return r.rows.reduce((best: number, u: { role: string }) => Math.max(best, roleRank(u.role)), -1);
}

/** The page's lists: places, headings, who can own a check (and how far they can see). */
export async function getMeta(role: string | undefined, userId: string) {
  const [places, headings, staff, me] = await Promise.all([
    query(`SELECT id, name, sort_order, retired_at FROM premises_places ORDER BY sort_order, name`),
    query(`SELECT id, name, sort_order, retired_at FROM premises_headings ORDER BY sort_order, name`),
    listAssignableStaff(),
    query(`SELECT person_id FROM users WHERE id = $1`, [userId]),
  ]);
  const people = new Map<string, { person_id: string; name: string | null; rank: number }>();
  for (const u of staff) {
    if (!u.person_id) continue;
    const name = `${(u.preferred_name || u.first_name || '').trim()} ${(u.last_name || '').trim()}`.trim() || null;
    const prev = people.get(u.person_id);
    people.set(u.person_id, { person_id: u.person_id, name: prev?.name ?? name, rank: Math.max(prev?.rank ?? -1, roleRank(u.role)) });
  }
  return {
    places: places.rows,
    headings: headings.rows,
    people: [...people.values()],
    /** For the register's "Mine" filter. */
    my_person_id: (me.rows[0]?.person_id as string | null) ?? null,
    can: { manage: isManager(role), admin: isAdmin(role) },
  };
}

// ── Saving a check ──────────────────────────────────────────────────────────

export interface RepeatInput { mode: string; rule: unknown }

export interface CheckInput {
  title: string;
  kind: string;
  heading_id: string;
  place_id: string;
  visibility: string;
  owner_person_id: string | null;
  contractor_org_id: string | null;
  responsibility: string;
  repeat: RepeatInput | null;
  next_due: string | null;
  remind_days_before: number;
  location_note: string | null;
  why_note: string | null;
  notes: string | null;
  /** Meter readings: the unit ("kWh", "m³") and the meter's serial. */
  unit?: string | null;
  meter_serial?: string | null;
  /** A rotating test's call points, in order (premises-rules.ts nextPoint). */
  points?: string[] | null;
  /** A Staff Document this check is linked to (re-issued after a new visit). */
  staff_document_id?: string | null;
}

/** Point a check at a Staff Document (or none). Linked, never copied. */
async function setStaffDocument(id: string, docId: string | null | undefined) {
  if (docId === undefined) return;
  if (docId) {
    const r = await query(`SELECT 1 FROM staff_documents WHERE id = $1`, [docId]);
    if (!r.rows.length) throw new PremisesError('That staff document isn’t there any more');
  }
  await query(`UPDATE premises_checks SET staff_document_id = $2 WHERE id = $1`, [id, docId]);
}

/** The meter and call-point fields — written after the main insert / update. */
async function saveExtras(id: string, unit: string | null | undefined, serial: string | null | undefined, points: unknown) {
  await query(
    `UPDATE premises_checks SET unit = $2, meter_serial = $3, points = $4 WHERE id = $1`,
    [id, trimOrNull(unit ?? null)?.slice(0, 20) ?? null, trimOrNull(serial ?? null)?.slice(0, 60) ?? null, cleanPoints(points ?? [])],
  );
}

/**
 * The repeat setting and the next due date, as stored. A 'schedule' rule
 * counts from its anchor — the next due date typed on the form ("every year on
 * 1 Jan" anchors on a 1 Jan), else today — and next_due is the first scheduled
 * date from there. An 'after_done' rule keeps whatever next due date was typed
 * (or none, until it is first done).
 */
function settleRepeat(repeat: RepeatInput | null, nextDue: string | null, today: string): {
  mode: Mode | null; rule: RecurrenceRule | null; anchor: string | null; nextDue: string | null;
} {
  if (nextDue !== null && !DATE_RE.test(nextDue)) throw new PremisesError('The next due date must be a date');
  if (!repeat) return { mode: null, rule: null, anchor: null, nextDue };
  if (!MODES.includes(repeat.mode as Mode)) throw new PremisesError('Say whether it repeats on a schedule or after the last one');
  const mode = repeat.mode as Mode;
  const anchor = nextDue || today;
  let rule: RecurrenceRule;
  try { rule = validateRule(repeat.rule, anchor); } catch (e) { throw new PremisesError(e instanceof Error ? e.message : 'That repeat doesn’t work'); }
  if (mode === 'after_done') return { mode, rule, anchor: null, nextDue };
  const first = firstOnOrAfter(rule, anchor, anchor);
  if (!first) throw new PremisesError('That schedule never falls due');
  return { mode, rule, anchor, nextDue: first };
}

async function assertTaxonomy(table: 'premises_headings' | 'premises_places', id: string, label: string) {
  const r = await query(`SELECT retired_at FROM ${table} WHERE id = $1`, [id]);
  if (!r.rows.length) throw new PremisesError(`Pick a ${label}`);
  if (r.rows[0].retired_at) throw new PremisesError(`That ${label} has been retired — pick another`);
}

async function assertOwnerCanSee(ownerPersonId: string | null, visibility: Visibility) {
  if (!ownerPersonId) return;
  const rank = await personRank(ownerPersonId);
  const need = visibility === 'admins' ? 2 : visibility === 'managers' ? 1 : 0;
  if (rank < need) {
    throw new PremisesError(
      visibility === 'admins'
        ? 'Only an admin can look after an admin-only check — pick someone else, or let more people see it'
        : 'Only a manager can look after a managers-only check — pick someone else, or let more people see it',
    );
  }
}

function assertBasics(input: Pick<CheckInput, 'title' | 'kind' | 'visibility' | 'responsibility' | 'remind_days_before'>, role: string | undefined) {
  if (!input.title?.trim()) throw new PremisesError('Give the check a name');
  if (!(CHECK_KINDS as readonly string[]).includes(input.kind)) throw new PremisesError('Pick what kind of check it is');
  if (!(VISIBILITIES as readonly string[]).includes(input.visibility)) throw new PremisesError('Say who can see it');
  if (!canSetVisibility(role, input.visibility)) throw new PremisesError('You can’t make a check only people above you can see');
  if (!['ours', 'landlord'].includes(input.responsibility)) throw new PremisesError('Say whether it is ours or the landlord’s');
  if (!Number.isInteger(input.remind_days_before) || input.remind_days_before < 0 || input.remind_days_before > 365) {
    throw new PremisesError('The reminder must be 0–365 days before');
  }
}

const trimOrNull = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export async function createCheck(input: CheckInput, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can add a check', 403);
  assertBasics(input, caller.role);
  await assertTaxonomy('premises_headings', input.heading_id, 'heading');
  await assertTaxonomy('premises_places', input.place_id, 'place');
  await assertOwnerCanSee(input.owner_person_id, input.visibility as Visibility);
  const today = ukToday();
  const rep = settleRepeat(input.repeat, input.next_due, today);
  const source = rep.nextDue ? (input.next_due ? 'typed' : 'computed') : null;
  const r = await query(
    `INSERT INTO premises_checks
       (title, kind, heading_id, place_id, visibility, owner_person_id, contractor_org_id, responsibility,
        repeat_mode, repeat_rule, repeat_anchor, next_due, next_due_source, remind_days_before,
        location_note, why_note, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::date, $12::date, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [input.title.trim(), input.kind, input.heading_id, input.place_id, input.visibility,
     input.owner_person_id, input.contractor_org_id, input.responsibility,
     rep.mode, rep.rule ? JSON.stringify(rep.rule) : null, rep.anchor, rep.nextDue, source,
     input.remind_days_before, trimOrNull(input.location_note), trimOrNull(input.why_note), trimOrNull(input.notes),
     caller.userId],
  );
  const id = r.rows[0].id as string;
  await saveExtras(id, input.unit, input.meter_serial, input.points);
  await setStaffDocument(id, input.staff_document_id ?? null);
  await syncCheckReminder(id);
  return getCheck(id, caller.role);
}

/** Change a check — only the fields sent. */
export async function updateCheck(id: string, patch: Partial<CheckInput>, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can change a check', 403);
  const cur = await visibleCheck(id, caller.role);
  const next: CheckInput = {
    title: patch.title ?? cur.title,
    kind: patch.kind ?? cur.kind,
    heading_id: patch.heading_id ?? cur.heading_id,
    place_id: patch.place_id ?? cur.place_id,
    visibility: patch.visibility ?? cur.visibility,
    owner_person_id: patch.owner_person_id !== undefined ? patch.owner_person_id : cur.owner_person_id,
    contractor_org_id: patch.contractor_org_id !== undefined ? patch.contractor_org_id : cur.contractor_org_id,
    responsibility: patch.responsibility ?? cur.responsibility,
    repeat: patch.repeat !== undefined ? patch.repeat
      : (cur.repeat_mode && cur.repeat_rule ? { mode: cur.repeat_mode, rule: cur.repeat_rule } : null),
    next_due: patch.next_due !== undefined ? patch.next_due : cur.next_due,
    remind_days_before: patch.remind_days_before ?? cur.remind_days_before,
    location_note: patch.location_note !== undefined ? patch.location_note : cur.location_note,
    why_note: patch.why_note !== undefined ? patch.why_note : cur.why_note,
    notes: patch.notes !== undefined ? patch.notes : cur.notes,
  };
  assertBasics(next, caller.role);
  if (patch.heading_id && patch.heading_id !== cur.heading_id) await assertTaxonomy('premises_headings', next.heading_id, 'heading');
  if (patch.place_id && patch.place_id !== cur.place_id) await assertTaxonomy('premises_places', next.place_id, 'place');
  await assertOwnerCanSee(next.owner_person_id, next.visibility as Visibility);

  // The repeat and the date are only re-worked when either was sent, so
  // renaming a check never moves its due date.
  let mode = cur.repeat_mode, rule = cur.repeat_rule, anchor = cur.repeat_anchor;
  let nextDue = cur.next_due, source = cur.next_due_source;
  if (patch.repeat !== undefined || patch.next_due !== undefined) {
    const rep = settleRepeat(next.repeat, next.next_due, ukToday());
    mode = rep.mode; rule = rep.rule; anchor = rep.anchor;
    if (rep.nextDue !== cur.next_due) source = rep.nextDue ? (patch.next_due !== undefined && patch.next_due ? 'typed' : 'computed') : null;
    nextDue = rep.nextDue;
  }

  await query(
    `UPDATE premises_checks
        SET title = $2, kind = $3, heading_id = $4, place_id = $5, visibility = $6, owner_person_id = $7,
            contractor_org_id = $8, responsibility = $9, repeat_mode = $10, repeat_rule = $11::jsonb,
            repeat_anchor = $12::date, next_due = $13::date, next_due_source = $14, remind_days_before = $15,
            location_note = $16, why_note = $17, notes = $18, updated_at = NOW()
      WHERE id = $1`,
    [id, next.title.trim(), next.kind, next.heading_id, next.place_id, next.visibility, next.owner_person_id,
     next.contractor_org_id, next.responsibility, mode, rule ? JSON.stringify(rule) : null, anchor, nextDue, source,
     next.remind_days_before, trimOrNull(next.location_note), trimOrNull(next.why_note), trimOrNull(next.notes)],
  );
  await saveExtras(id,
    patch.unit !== undefined ? patch.unit : cur.unit,
    patch.meter_serial !== undefined ? patch.meter_serial : cur.meter_serial,
    patch.points !== undefined ? patch.points : cur.points);
  await setStaffDocument(id, patch.staff_document_id);
  await syncCheckReminder(id);
  return getCheck(id, caller.role);
}

/** Off the register and no more reminders; its records and files stay (spec §1.10). */
export async function retireCheck(id: string, reason: string | null, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can retire a check', 403);
  await visibleCheck(id, caller.role);
  await query(
    `UPDATE premises_checks SET retired_at = NOW(), retired_reason = $2, retired_by = $3, updated_at = NOW()
      WHERE id = $1 AND retired_at IS NULL`,
    [id, trimOrNull(reason), caller.userId],
  );
  await syncCheckReminder(id);
  return getCheck(id, caller.role);
}

export async function unretireCheck(id: string, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can bring a check back', 403);
  await visibleCheck(id, caller.role);
  await query(
    `UPDATE premises_checks SET retired_at = NULL, retired_reason = NULL, retired_by = NULL, updated_at = NOW() WHERE id = $1`,
    [id],
  );
  await syncCheckReminder(id);
  return getCheck(id, caller.role);
}

/** The one hard delete: a check added by mistake, with nothing ever recorded on it. */
export async function deleteCheck(id: string, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can delete a check', 403);
  await visibleCheck(id, caller.role);
  const used = await query(`SELECT 1 FROM premises_records WHERE check_id = $1 LIMIT 1`, [id]);
  if (used.rows.length) throw new PremisesError('Something has been recorded on this check — retire it instead, so its history is kept', 409);
  for (const t of await listTasksForSource(REMINDER_SOURCE, id) as Array<{ id: string; status: string }>) {
    if (t.status === 'open') await cancelTask(t.id, SYSTEM_USER_ID, 'admin');
  }
  await query(`DELETE FROM premises_checks WHERE id = $1`, [id]);
}

// ── Recording that it was done ──────────────────────────────────────────────

export interface RecordInput {
  done_on: string;
  outcome: string | null;
  done_by_org_id: string | null;
  notes: string | null;
  /** A next due date given on the certificate — wins over the rule. */
  next_due: string | null;
  reading_value: number | null;
  meter_replaced: boolean;
  /** The call point tested (a rotating test). */
  point?: string | null;
  /** The engineer's advisories, one each — each can become a To Do. */
  advisories?: string[] | null;
}

/** What next due date recording on `doneOn` would set — the record form's preview. */
export async function previewNextDue(id: string, doneOn: string, role: string | undefined) {
  if (!DATE_RE.test(doneOn)) throw new PremisesError('done_on must be a date');
  const c = await visibleCheck(id, role);
  const latest = await latestDoneOn(id);
  const moves = !latest || doneOn >= latest;
  const r = nextDueAfterRecord({ mode: c.repeat_mode, rule: c.repeat_rule, anchor: c.repeat_anchor }, doneOn, c.next_due, null);
  return { next_due: moves ? r.date : c.next_due, moves, repeat_text: repeatText(c, ukToday()) };
}

async function latestDoneOn(checkId: string): Promise<string | null> {
  const r = await query(
    `SELECT MAX(done_on)::text AS d FROM premises_records WHERE check_id = $1 AND removed_at IS NULL`, [checkId]);
  return r.rows[0]?.d ?? null;
}

export async function recordCheck(id: string, input: RecordInput, caller: Caller) {
  const { ids } = await saveRecords(id, [input], false, caller);
  return { id: ids[0] };
}

/**
 * Past records (spec §14): several old certificates filed at once. They never
 * make a "Get it fixed" To Do, an outcome is optional, and the due date moves
 * once — from the newest of them, and only if it is newer than anything
 * already recorded. Ids come back in the order sent, for the files.
 */
export async function addPastRecords(id: string, inputs: RecordInput[], caller: Caller) {
  if (!inputs.length) throw new PremisesError('Add at least one record');
  if (inputs.length > 50) throw new PremisesError('Fifty at a time, please');
  return saveRecords(id, inputs, true, caller);
}

/**
 * The one way records are written. In ONE transaction (the check locked, so
 * two people recording at once can't both move the date): every record goes
 * in, and the due date moves once, worked out from the newest of them —
 * unless something newer is already recorded (an old certificate never winds
 * the clock back).
 */
async function saveRecords(id: string, inputs: RecordInput[], backfilled: boolean, caller: Caller) {
  const today = ukToday();
  const c = await visibleCheck(id, caller.role);
  if (c.retired_at) throw new PremisesError('This check has been retired — bring it back first');
  for (const input of inputs) {
    if (!DATE_RE.test(input.done_on)) throw new PremisesError('Say when it was done');
    if (input.done_on > today) throw new PremisesError('It can’t have been done in the future');
    if (input.outcome && !(OUTCOMES as readonly string[]).includes(input.outcome)) throw new PremisesError('Pick how it went');
    if (!backfilled && (c.kind === 'visit' || c.kind === 'test') && !input.outcome) throw new PremisesError('Say how it went');
    if (c.kind === 'reading' && (input.reading_value === null || !Number.isFinite(input.reading_value))) {
      throw new PremisesError('Type the reading');
    }
    if (input.next_due !== null) {
      if (!DATE_RE.test(input.next_due)) throw new PremisesError('The next due date must be a date');
      if (input.next_due <= input.done_on) throw new PremisesError('The next due date must be after the day it was done');
    }
  }
  // The newest of the batch decides the date (the last one sent, if two share a day).
  let newestIdx = 0;
  inputs.forEach((r, i) => { if (r.done_on >= inputs[newestIdx].done_on) newestIdx = i; });
  const newest = inputs[newestIdx];

  const ids: string[] = [];
  let moved = false;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT next_due::text AS next_due, repeat_mode, repeat_rule, repeat_anchor::text AS repeat_anchor
         FROM premises_checks WHERE id = $1 FOR UPDATE`, [id]);
    const row = cur.rows[0] as { next_due: string | null; repeat_mode: Mode | null; repeat_rule: RecurrenceRule | null; repeat_anchor: string | null };
    const latest = await client.query(
      `SELECT MAX(done_on)::text AS d FROM premises_records WHERE check_id = $1 AND removed_at IS NULL`, [id]);
    const latestDone = latest.rows[0]?.d as string | null;
    moved = !latestDone || newest.done_on >= latestDone;
    const next = moved
      ? nextDueAfterRecord({ mode: row.repeat_mode, rule: row.repeat_rule, anchor: row.repeat_anchor }, newest.done_on, row.next_due, newest.next_due)
      : { date: null, source: null };

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const setsDate = moved && i === newestIdx;
      const ins = await client.query(
        `INSERT INTO premises_records
           (check_id, done_on, done_by_org_id, outcome, reading_value, meter_replaced, notes, point,
            next_due_set, next_due_source, recorded_by, backfilled)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::date, $10, $11, $12)
         RETURNING id`,
        [id, input.done_on, input.done_by_org_id, input.outcome, input.reading_value, input.meter_replaced,
         trimOrNull(input.notes), trimOrNull(input.point ?? null)?.slice(0, 80) ?? null,
         setsDate ? next.date : null, setsDate ? next.source : null, caller.userId, backfilled],
      );
      ids.push(ins.rows[0].id as string);
      for (const text of cleanAdvisories(input.advisories)) {
        await client.query(
          // clock_timestamp, not NOW(): one transaction's NOW() is the same for every row, which would lose their order.
          `INSERT INTO premises_advisories (record_id, text, created_by, created_at) VALUES ($1, $2, $3, clock_timestamp())`,
          [ins.rows[0].id, text, caller.userId]);
      }
    }
    if (moved) {
      await client.query(
        `UPDATE premises_checks SET next_due = $2::date, next_due_source = $3, updated_at = NOW() WHERE id = $1`,
        [id, next.date, next.source],
      );
    }
    // The visit happened, so its booking is done. Never from a filed-later
    // record: last year's certificate doesn't answer next week's booking.
    if (moved && !backfilled) {
      await client.query(
        `UPDATE premises_bookings SET status = 'done', updated_at = NOW() WHERE check_id = $1 AND status = 'booked'`, [id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // It's done, so the reminder that asked for it is done too. Only when the
  // date moved: typing in last year's visit answers nothing.
  const bookingLive = backfilled
    && (await query(`SELECT 1 FROM premises_bookings WHERE check_id = $1 AND status = 'booked'`, [id])).rows.length > 0;
  if (moved && !bookingLive) {
    for (const t of await listTasksForSource(REMINDER_SOURCE, id) as Array<{ id: string; status: string }>) {
      if (t.status !== 'open') continue;
      await updateTask(t.id, { status: 'done' }, SYSTEM_USER_ID, 'admin')
        .catch(e => console.error(`[premises] closing reminder ${t.id} failed (non-fatal):`, e));
    }
  }
  await syncCheckReminder(id);
  // A failed check needs fixing — today's, never a filed-later one (history).
  if (!backfilled && inputs[0].outcome === 'fail') await makeFixTask(c, ids[0], inputs[0], caller);
  return { ids };
}

/** A new reading against the meter's history — the form's live warning (never a refusal). */
export async function checkReading(id: string, value: number, doneOn: string, replaced: boolean, role: string | undefined) {
  if (!DATE_RE.test(doneOn)) throw new PremisesError('done_on must be a date');
  if (!Number.isFinite(value)) throw new PremisesError('Type the reading');
  const c = await visibleCheck(id, role);
  if (c.kind !== 'reading') throw new PremisesError('That check isn’t a meter');
  return assessReading(await meterReadings(id), value, doneOn, replaced);
}

async function meterReadings(checkId: string): Promise<Reading[]> {
  const r = await query(
    `SELECT done_on::text AS done_on, reading_value::float8 AS reading_value, meter_replaced
       FROM premises_records WHERE check_id = $1 AND removed_at IS NULL AND reading_value IS NOT NULL`, [checkId]);
  return readingsOf(r.rows);
}

/**
 * Every meter the caller can see, with its last reading and how much was used
 * since the one before — Meter readings tab and the phone's reading screen.
 */
export async function listMeters(role: string | undefined) {
  const today = ukToday();
  const r = await query(
    `${CHECK_SELECT} WHERE c.kind = 'reading' AND c.retired_at IS NULL AND c.visibility = ANY($1::text[])
      ORDER BY p.sort_order, p.name, c.title`,
    [visibleLevels(role)],
  );
  const meters = [];
  for (const row of r.rows as CheckRow[]) {
    const readings = (await meterReadings(row.id)).sort((a, b) => (a.done_on < b.done_on ? -1 : a.done_on > b.done_on ? 1 : 0));
    const last = readings.length ? readings[readings.length - 1] : null;
    const usage = usageSeries(readings);
    const lastUse = last && usage.length && usage[usage.length - 1].to === last.done_on ? usage[usage.length - 1] : null;
    meters.push({
      ...decorate(row, today),
      last_reading: last,
      last_use: lastUse,
      usual_per_week: assessReading(readings, last?.value ?? 0, today, false).usual_per_week,
      usage: usage.slice(-12),
    });
  }
  return meters;
}

/** A failed check makes a To Do straight away (spec §1.9) — to its owner, else whoever recorded it. */
async function makeFixTask(c: CheckRow, recordId: string, input: RecordInput, caller: Caller) {
  try {
    let personId = c.owner_person_id;
    if (!personId) {
      const r = await query(`SELECT person_id FROM users WHERE id = $1`, [caller.userId]);
      personId = (r.rows[0]?.person_id as string | null) ?? null;
    }
    if (!personId) return;
    await createTask({
      title: `Get it fixed: ${c.title} failed on ${dateLabel(input.done_on)}`,
      detail: trimOrNull(input.notes),
      personId,
      dueDate: ukDatePlus(7),
      sourceType: FIX_SOURCE,
      sourceId: recordId,
      followUpOn: null,
    }, SYSTEM_USER_ID, 'admin');
  } catch (err) {
    console.error(`[premises] fix To Do for ${c.id} not made (non-fatal):`, err);
  }
}

/** Take a record off (a mistake). The due date is left alone — change it on the check if needed. */
export async function removeRecord(recordId: string, reason: string | null, caller: Caller) {
  if (!isManager(caller.role)) throw new PremisesError('Only a manager can remove a record', 403);
  const r = await query(`SELECT check_id FROM premises_records WHERE id = $1 AND removed_at IS NULL`, [recordId]);
  if (!r.rows.length) throw new PremisesError('Record not found', 404);
  const checkId = r.rows[0].check_id as string;
  await visibleCheck(checkId, caller.role);
  await query(
    `UPDATE premises_records SET removed_at = NOW(), removed_by = $2, removed_reason = $3 WHERE id = $1`,
    [recordId, caller.userId, trimOrNull(reason)],
  );
  return { check_id: checkId };
}

// ── Files ───────────────────────────────────────────────────────────────────

/** The check a record belongs to, if the caller may see it — before an upload. */
export async function checkForRecord(recordId: string, role: string | undefined): Promise<string> {
  const r = await query(`SELECT check_id FROM premises_records WHERE id = $1 AND removed_at IS NULL`, [recordId]);
  if (!r.rows.length) throw new PremisesError('Record not found', 404);
  await visibleCheck(r.rows[0].check_id as string, role);
  return r.rows[0].check_id as string;
}

export async function addFile(recordId: string, f: {
  id: string; r2Key: string; filename: string; contentType: string | null; size: number;
}, caller: Caller) {
  await query(
    `INSERT INTO premises_files (id, record_id, r2_key, filename, content_type, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [f.id, recordId, f.r2Key, f.filename.slice(0, 255), f.contentType, f.size, caller.userId],
  );
}

/** Take a file off — a manager, or whoever uploaded it. Kept in R2 and the table. */
export async function archiveFile(fileId: string, caller: Caller) {
  const r = await query(
    `SELECT f.uploaded_by, f.r2_key FROM premises_files f WHERE f.id = $1 AND f.archived_at IS NULL`, [fileId]);
  if (!r.rows.length) throw new PremisesError('File not found', 404);
  // A certificate on a check, or a version in the library — the same gate as opening it.
  if (!(await canOpenPremisesFile(r.rows[0].r2_key as string, caller.role))) throw new PremisesError('File not found', 404);
  if (!isManager(caller.role) && r.rows[0].uploaded_by !== caller.userId) {
    throw new PremisesError('Only a manager or whoever added it can remove a file', 403);
  }
  await query(`UPDATE premises_files SET archived_at = NOW(), archived_by = $2 WHERE id = $1`, [fileId, caller.userId]);
}

/**
 * May this role open this premises/ file? THE gate for GET /api/files/download
 * (routes/files.ts) — per file, by its check's visibility. A key with no row
 * is refused.
 */
export async function canOpenPremisesFile(key: string, role: string | undefined): Promise<boolean> {
  const r = await query(
    `SELECT c.visibility AS check_visibility, d.visibility AS doc_visibility, fo.visibility AS folder_visibility
       FROM premises_files f
       LEFT JOIN premises_records r ON r.id = f.record_id
       LEFT JOIN premises_checks c ON c.id = r.check_id
       LEFT JOIN premises_documents d ON d.id = f.document_id
       LEFT JOIN premises_folders fo ON fo.id = d.folder_id
      WHERE f.r2_key = $1`, [key]);
  const row = r.rows[0] as { check_visibility: string | null; doc_visibility: string | null; folder_visibility: string | null } | undefined;
  if (!row) return false;
  // A check's certificate follows the check; a library version follows its document (the tighter of it and its folder).
  if (row.check_visibility) return canSee(role, row.check_visibility);
  if (row.folder_visibility) return canSee(role, effectiveVisibility(row.doc_visibility, row.folder_visibility));
  return false;
}

// ── Advisories ──────────────────────────────────────────────────────────────

/** Advisories from a form: trimmed, no blanks, at most 30 of 500 characters. */
function cleanAdvisories(raw: string[] | null | undefined): string[] {
  return (raw ?? []).map(t => String(t ?? '').trim().slice(0, 500)).filter(Boolean).slice(0, 30);
}

/** The advisory, its record's check (visible to the caller), or 404. */
async function advisoryFor(advisoryId: string, role: string | undefined) {
  const r = await query(
    `SELECT a.id, a.text, a.task_id, a.done_at, r.check_id, t.status AS task_status
       FROM premises_advisories a
       JOIN premises_records r ON r.id = a.record_id AND r.removed_at IS NULL
       LEFT JOIN staff_tasks t ON t.id = a.task_id
      WHERE a.id = $1`, [advisoryId]);
  const a = r.rows[0] as { id: string; text: string; task_id: string | null; done_at: string | null; check_id: string; task_status: string | null } | undefined;
  if (!a) throw new PremisesError('Advisory not found', 404);
  const check = await visibleCheck(a.check_id, role);
  return { a, check };
}

/** Add advisories to a record after the event (anyone who can see the check). */
export async function addAdvisories(recordId: string, texts: string[], caller: Caller) {
  const checkId = await checkForRecord(recordId, caller.role);
  const clean = cleanAdvisories(texts);
  if (!clean.length) throw new PremisesError('Type the advisory');
  for (const text of clean) {
    await query(`INSERT INTO premises_advisories (record_id, text, created_by, created_at) VALUES ($1, $2, $3, clock_timestamp())`, [recordId, text, caller.userId]);
  }
  return { check_id: checkId };
}

/**
 * Turn an advisory into a To Do (spec §1.9) — for the check's owner, else for
 * whoever asked. Set by the person who pressed it, so it reads as theirs.
 */
export async function makeAdvisoryTask(advisoryId: string, caller: Caller) {
  const { a, check } = await advisoryFor(advisoryId, caller.role);
  if (a.done_at) throw new PremisesError('That advisory is already done');
  if (a.task_id && a.task_status !== 'cancelled') throw new PremisesError('That advisory is already a To Do');
  let personId = check.owner_person_id;
  if (!personId) {
    const me = await query(`SELECT person_id FROM users WHERE id = $1`, [caller.userId]);
    personId = (me.rows[0]?.person_id as string | null) ?? null;
  }
  if (!personId) throw new PremisesError('Nobody looks after this check yet, and your login has no person to give it to');
  const task = await createTask({
    title: `${check.title}: ${a.text}`.slice(0, 300),
    personId,
    dueDate: ukDatePlus(30),
    sourceType: ADVISORY_SOURCE,
    sourceId: advisoryId,
  }, caller.userId, caller.role) as { id: string };
  await query(`UPDATE premises_advisories SET task_id = $2 WHERE id = $1`, [advisoryId, task.id]);
  return { task_id: task.id };
}

/** Tick an advisory off (or back on). Ticking it off closes its open To Do too. */
export async function setAdvisoryDone(advisoryId: string, done: boolean, caller: Caller) {
  const { a } = await advisoryFor(advisoryId, caller.role);
  await query(
    `UPDATE premises_advisories SET done_at = ${done ? 'NOW()' : 'NULL'}, done_by = $2 WHERE id = $1`,
    [advisoryId, done ? caller.userId : null]);
  if (done && a.task_id && a.task_status === 'open') {
    await updateTask(a.task_id, { status: 'done' }, SYSTEM_USER_ID, 'admin')
      .catch(e => console.error(`[premises] closing advisory To Do ${a.task_id} failed (non-fatal):`, e));
  }
}

// ── The bill in Costs ───────────────────────────────────────────────────────

/**
 * Bills to link a record to: with no search, the contractor's recent ones (by
 * the name on the cost); with one, by supplier, description, invoice number or
 * amount. Read-only over Money › Costs — nothing about the cost changes.
 */
export async function linkableCosts(checkId: string, rawSearch: string, role: string | undefined) {
  const check = await visibleCheck(checkId, role);
  const raw = rawSearch.trim().slice(0, 100);
  const escape = (v: string) => v.replace(/[\\%_]/g, (m) => `\\${m}`);
  const search = raw.length >= 2 ? escape(raw) : null;
  const amountTyped = raw ? Number(raw.replace(/[£,\s]/g, '')) : NaN;
  const amount = Number.isFinite(amountTyped) && amountTyped > 0 ? Math.round(amountTyped * 100) / 100 : null;
  const contractor = check.contractor_name ? escape(String(check.contractor_name).trim().slice(0, 100)) : null;
  if (!search && !contractor) return [];
  const r = await query(
    `SELECT c.id, c.supplier_name, c.description, c.invoice_number,
            to_char(c.cost_date, 'YYYY-MM-DD') AS cost_date,
            c.amount_net::float8 AS amount_net, c.amount_gross::float8 AS amount_gross
       FROM costs c
      WHERE ($1::text IS NULL AND c.supplier_name ILIKE '%' || $2::text || '%')
         OR ($1::text IS NOT NULL AND (
              c.supplier_name ILIKE '%' || $1::text || '%'
              OR c.description ILIKE '%' || $1::text || '%'
              OR c.invoice_number ILIKE '%' || $1::text || '%'
              OR ($3::numeric IS NOT NULL AND (ABS(c.amount_gross - $3::numeric) < 0.005 OR ABS(c.amount_net - $3::numeric) < 0.005))))
      ORDER BY c.cost_date DESC NULLS LAST, c.created_at DESC
      LIMIT 40`,
    [search, contractor, amount]);
  return r.rows;
}

/** Point a record at its bill in Costs, or take the link off (null). Anyone who can see the check. */
export async function linkCost(recordId: string, costId: string | null, caller: Caller) {
  const checkId = await checkForRecord(recordId, caller.role);
  if (costId) {
    const c = await query(`SELECT 1 FROM costs WHERE id = $1`, [costId]);
    if (!c.rows.length) throw new PremisesError('That bill isn’t in Costs any more');
  }
  await query(`UPDATE premises_records SET cost_id = $2 WHERE id = $1`, [recordId, costId]);
  return { check_id: checkId };
}

// ── Places and headings (admins) ────────────────────────────────────────────

type Taxonomy = 'places' | 'headings';
const TABLE: Record<Taxonomy, 'premises_places' | 'premises_headings'> = { places: 'premises_places', headings: 'premises_headings' };
const COLUMN: Record<Taxonomy, 'place_id' | 'heading_id'> = { places: 'place_id', headings: 'heading_id' };

export async function addTaxonomy(kind: Taxonomy, name: string, caller: Caller) {
  if (!isAdmin(caller.role)) throw new PremisesError('Only an admin can change these', 403);
  if (!name?.trim()) throw new PremisesError('Give it a name');
  const r = await query(
    `INSERT INTO ${TABLE[kind]} (name, sort_order)
     VALUES ($1, COALESCE((SELECT MAX(sort_order) FROM ${TABLE[kind]}), 0) + 1) RETURNING id`,
    [name.trim().slice(0, 100)],
  );
  return { id: r.rows[0].id as string };
}

export async function updateTaxonomy(kind: Taxonomy, id: string, patch: { name?: string; sort_order?: number; retired?: boolean }, caller: Caller) {
  if (!isAdmin(caller.role)) throw new PremisesError('Only an admin can change these', 403);
  const r = await query(`SELECT id FROM ${TABLE[kind]} WHERE id = $1`, [id]);
  if (!r.rows.length) throw new PremisesError('Not found', 404);
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new PremisesError('Give it a name');
    await query(`UPDATE ${TABLE[kind]} SET name = $2 WHERE id = $1`, [id, patch.name.trim().slice(0, 100)]);
  }
  if (patch.sort_order !== undefined) {
    await query(`UPDATE ${TABLE[kind]} SET sort_order = $2 WHERE id = $1`, [id, Math.round(patch.sort_order)]);
  }
  if (patch.retired === true) {
    const used = await query(
      `SELECT COUNT(*)::int AS n FROM premises_checks WHERE ${COLUMN[kind]} = $1 AND retired_at IS NULL`, [id]);
    const n = used.rows[0].n as number;
    if (n > 0) throw new PremisesError(`${n} check${n === 1 ? ' is' : 's are'} still under it — move ${n === 1 ? 'it' : 'them'} first`, 409);
    await query(`UPDATE ${TABLE[kind]} SET retired_at = NOW() WHERE id = $1`, [id]);
  } else if (patch.retired === false) {
    await query(`UPDATE ${TABLE[kind]} SET retired_at = NULL WHERE id = $1`, [id]);
  }
}

// ── The owner's reminder (To Do) ────────────────────────────────────────────

/**
 * ONE open To Do for a check's owner while it is inside its reminder lead or
 * overdue; re-titled if the date moves, moved if the owner changes, cancelled
 * when it's retired, has no owner, or the owner can no longer see it. Never
 * throws — the check is saved either way.
 */
export async function syncCheckReminder(checkId: string): Promise<void> {
  try {
    const r = await query(
      `SELECT c.id, c.title, c.kind, c.responsibility, c.visibility, c.owner_person_id, c.retired_at, c.points,
              c.next_due::text AS next_due, c.remind_days_before, c.reminded_for_due::text AS reminded_for_due,
              c.reminded_key, o.name AS contractor_name,
              b.id AS booking_id, b.visit_on::text AS booking_on, b.visit_time AS booking_time,
              b.letting_in_person_id AS booking_person_id,
              (SELECT r.point FROM premises_records r
                WHERE r.check_id = c.id AND r.removed_at IS NULL AND r.point IS NOT NULL
                ORDER BY r.done_on DESC, r.created_at DESC LIMIT 1) AS last_point
         FROM premises_checks c
         LEFT JOIN organisations o ON o.id = c.contractor_org_id
         LEFT JOIN premises_bookings b ON b.check_id = c.id AND b.status = 'booked'
        WHERE c.id = $1`, [checkId]);
    const c = r.rows[0] as {
      title: string; kind: string; responsibility: string; visibility: string; owner_person_id: string | null;
      points: string[] | null; last_point: string | null; contractor_name: string | null;
      retired_at: string | null; next_due: string | null; remind_days_before: number;
      reminded_for_due: string | null; reminded_key: string | null;
      booking_id: string | null; booking_on: string | null; booking_time: string | null; booking_person_id: string | null;
    } | undefined;
    const today = ukToday();
    const open = (await listTasksForSource(REMINDER_SOURCE, checkId) as Array<{ id: string; status: string; person_id: string; title: string }>)
      .filter(t => t.status === 'open');
    const sees = async (personId: string | null) =>
      !!personId && !!c && canSee(roleNameForRank(await personRank(personId)), c.visibility);

    // What the To Do should be right now — or nothing.
    let plan: { person: string; title: string; due: string; key: string } | null = null;
    if (c && !c.retired_at && c.booking_id && c.booking_on) {
      // A booked visit: whoever is letting them in (else the owner), from the moment it's booked.
      const person = c.booking_person_id ?? c.owner_person_id;
      if (person && await sees(person)) {
        plan = {
          person,
          title: bookingTitle(c.contractor_name, c.title, c.booking_on, c.booking_time),
          due: c.booking_on < today ? today : c.booking_on,
          key: `booking:${c.booking_id}:${c.booking_on}`,
        };
      }
    } else if (c && !c.retired_at && c.owner_person_id && c.next_due
      && reminderWanted(c.next_due, c.remind_days_before, today) && await sees(c.owner_person_id)) {
      plan = {
        person: c.owner_person_id,
        title: reminderTitle(c.kind, c.responsibility, c.title, c.next_due, nextPoint(c.points, c.last_point)),
        // A To Do's date can't be in the past; an overdue check's says so in its title.
        due: c.next_due < today ? today : c.next_due,
        key: `due:${c.next_due}`,
      };
    }

    if (!plan) {
      for (const t of open) await cancelTask(t.id, SYSTEM_USER_ID, 'admin');
      return;
    }
    if (open.length === 1 && open[0].person_id === plan.person && open[0].title === plan.title) return;
    // Ticked (or dropped) by hand for this same due date or booking: don't make it again.
    // (Before mig 362 only the due date was kept — still honoured.)
    const lastKey = c!.reminded_key ?? (c!.reminded_for_due ? `due:${c!.reminded_for_due}` : null);
    if (open.length === 0 && lastKey === plan.key) return;
    for (const t of open) await cancelTask(t.id, SYSTEM_USER_ID, 'admin');
    await createTask({
      title: plan.title,
      personId: plan.person,
      dueDate: plan.due,
      sourceType: REMINDER_SOURCE,
      sourceId: checkId,
      followUpOn: null,
    }, SYSTEM_USER_ID, 'admin');
    await query(`UPDATE premises_checks SET reminded_key = $2, reminded_for_due = $3::date WHERE id = $1`,
      [checkId, plan.key, c!.next_due]);
  } catch (err) {
    console.error(`[premises] reminder for ${checkId} not set (non-fatal):`, err);
  }
}

// ── Booking a visit (phase 3b) ──────────────────────────────────────────────

export interface BookingInput {
  visit_on: string;
  visit_time: string | null;
  letting_in_person_id: string | null;
  note: string | null;
}

/**
 * Book the contractor in — or change the booking (one live booking per check).
 * Anyone who can see the check. The person letting them in must be able to see
 * it too: their To Do opens the check.
 */
export async function bookVisit(checkId: string, input: BookingInput, caller: Caller) {
  const c = await visibleCheck(checkId, caller.role);
  if (c.retired_at) throw new PremisesError('This check has been retired — bring it back first');
  if (!DATE_RE.test(input.visit_on)) throw new PremisesError('Say which day they’re coming');
  if (input.visit_on < ukToday()) throw new PremisesError('That day has gone — record the visit instead');
  if (input.visit_time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.visit_time)) throw new PremisesError('The time must be HH:MM');
  if (input.letting_in_person_id) {
    const rank = await personRank(input.letting_in_person_id);
    if (!canSee(roleNameForRank(rank), c.visibility)) {
      throw new PremisesError('They can’t see this check, so their To Do wouldn’t open — pick someone else');
    }
  }
  const live = await query(`SELECT id FROM premises_bookings WHERE check_id = $1 AND status = 'booked'`, [checkId]);
  if (live.rows.length) {
    await query(
      `UPDATE premises_bookings SET visit_on = $2::date, visit_time = $3, letting_in_person_id = $4, note = $5, updated_at = NOW()
        WHERE id = $1`,
      [live.rows[0].id, input.visit_on, input.visit_time, input.letting_in_person_id, trimOrNull(input.note)]);
  } else {
    await query(
      `INSERT INTO premises_bookings (check_id, visit_on, visit_time, letting_in_person_id, note, created_by)
       VALUES ($1, $2::date, $3, $4, $5, $6)`,
      [checkId, input.visit_on, input.visit_time, input.letting_in_person_id, trimOrNull(input.note), caller.userId]);
  }
  await syncCheckReminder(checkId);
  return getCheck(checkId, caller.role);
}

/** Call a booking off (soft — the row stays). The reminder goes back to "book it" if it's due. */
export async function cancelBooking(checkId: string, caller: Caller) {
  await visibleCheck(checkId, caller.role);
  await query(
    `UPDATE premises_bookings SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, updated_at = NOW()
      WHERE check_id = $1 AND status = 'booked'`, [checkId, caller.userId]);
  await syncCheckReminder(checkId);
  return getCheck(checkId, caller.role);
}

/**
 * Booked visits between two dates, for the staff calendar's "Contractors on
 * site" lane — only checks the caller can see. Read-through: the calendar's
 * own tables are never touched (STAFF-CALENDAR rules).
 */
export async function listVisits(from: string, to: string, role: string | undefined) {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) throw new PremisesError('from and to must be dates');
  const r = await query(
    `SELECT b.id, b.check_id, b.visit_on::text AS visit_on, b.visit_time, b.status, b.note,
            c.title AS check_title, o.name AS contractor_name, p.name AS place_name,
            NULLIF(TRIM(COALESCE(NULLIF(bp.preferred_name, ''), bp.first_name, '') || ' ' || COALESCE(bp.last_name, '')), '') AS letting_in_name
       FROM premises_bookings b
       JOIN premises_checks c ON c.id = b.check_id
       JOIN premises_places p ON p.id = c.place_id
       LEFT JOIN organisations o ON o.id = c.contractor_org_id
       LEFT JOIN people bp ON bp.id = b.letting_in_person_id
      WHERE b.status <> 'cancelled' AND b.visit_on BETWEEN $1::date AND $2::date
        AND c.visibility = ANY($3::text[])
      ORDER BY b.visit_on, b.visit_time NULLS LAST, c.title`,
    [from, to, visibleLevels(role)]);
  return r.rows;
}

/** The checks an organisation does for us — its contractor, or it did a recorded visit (org page). */
export async function listChecksForOrganisation(orgId: string, role: string | undefined) {
  const today = ukToday();
  const r = await query(
    `${CHECK_SELECT}
      WHERE c.visibility = ANY($1::text[]) AND c.retired_at IS NULL
        AND (c.contractor_org_id = $2
             OR EXISTS (SELECT 1 FROM premises_records x WHERE x.check_id = c.id AND x.done_by_org_id = $2 AND x.removed_at IS NULL))
      ORDER BY c.title`,
    [visibleLevels(role), orgId]);
  return (r.rows as CheckRow[]).map(row => decorate(row, today));
}

/** A role name standing for a rank, so canSee() stays the one rule. */
function roleNameForRank(rank: number): string | undefined {
  return rank >= 2 ? 'admin' : rank === 1 ? 'manager' : rank === 0 ? 'staff' : undefined;
}

/**
 * Daily (09:17): every check coming into its reminder lead gets its To Do, and
 * every open reminder is re-checked. Never throws per check.
 */
export async function runPremisesReminders(): Promise<number> {
  const r = await query(
    `SELECT id FROM premises_checks
      WHERE (retired_at IS NULL AND owner_person_id IS NOT NULL AND next_due IS NOT NULL
             AND next_due - remind_days_before <= $1::date)
         OR id IN (SELECT source_id FROM staff_tasks WHERE source_type = $2 AND status = 'open')
         OR id IN (SELECT check_id FROM premises_bookings WHERE status = 'booked')`,
    [ukToday(), REMINDER_SOURCE],
  );
  for (const row of r.rows) await syncCheckReminder(row.id as string);
  return r.rows.length;
}
