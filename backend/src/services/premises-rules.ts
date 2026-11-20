/**
 * Premises & compliance — the pure rules (docs/PREMISES-COMPLIANCE-SPEC.md).
 *
 * PURE: no database, no clock of its own (callers pass "today"). Three
 * questions, answered once here so the register, the check page, the reminder
 * service and the To Do title can't disagree:
 *
 *   1. Who may see a check?             canSee() / visibleLevels()
 *   2. Is it overdue, due soon, OK?     checkStatus()
 *   3. When is it next due once done?   nextDueAfterRecord()
 *
 * WHEN a repeating thing falls is NOT worked out here: that is
 * task-recurrence.ts, the engine repeating to-dos already use (CLAUDE.md's
 * helper rule). Both of jon's patterns are its two modes:
 *   after_done — "every 12 months from the last visit"
 *   schedule   — "every year on 1 Jan", "every week on Thursday"
 */
import { RecurrenceRule, Mode, addInterval, nextAfterClose } from './task-recurrence';

export const CHECK_KINDS = ['visit', 'test', 'reading', 'renewal'] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const VISIBILITIES = ['all', 'managers', 'admins'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

export const OUTCOMES = ['pass', 'advisories', 'fail'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type CheckStatus = 'overdue' | 'due_soon' | 'ok' | 'no_date';

// ── 1. Who may see it ───────────────────────────────────────────────────────

export const VIS_RANK: Record<Visibility, number> = { all: 0, managers: 1, admins: 2 };

/**
 * A library document's visibility: the tighter of its own and its folder's
 * (a document may be set tighter than its folder, never looser). THE rule for
 * the library list and the file gate.
 */
export function effectiveVisibility(doc: string | null | undefined, folder: string): Visibility {
  const f = (VIS_RANK[folder as Visibility] !== undefined ? folder : 'admins') as Visibility;
  const d = doc as Visibility | null | undefined;
  return d && VIS_RANK[d] !== undefined && VIS_RANK[d] > VIS_RANK[f] ? d : f;
}

/**
 * How far up the visibility ladder a role reaches. -1 = sees nothing (a
 * freelancer, an unknown role). weekend_manager ≡ manager (CLAUDE.md RBAC).
 */
export function roleRank(role: string | null | undefined): number {
  switch (role) {
    case 'admin': return 2;
    case 'manager':
    case 'weekend_manager': return 1;
    case 'staff':
    case 'general_assistant': return 0;
    default: return -1;
  }
}

export function canSee(role: string | null | undefined, visibility: string): boolean {
  const need = VIS_RANK[visibility as Visibility];
  return need !== undefined && roleRank(role) >= need;
}

/** The visibility values a role may see — for `visibility = ANY($n)` in SQL. */
export function visibleLevels(role: string | null | undefined): Visibility[] {
  const rank = roleRank(role);
  return VISIBILITIES.filter(v => VIS_RANK[v] <= rank);
}

/** May this role set / keep a check at this visibility? (never one they couldn't see) */
export function canSetVisibility(role: string | null | undefined, visibility: string): boolean {
  return canSee(role, visibility);
}

// ── 2. Status ───────────────────────────────────────────────────────────────

/** Days from `from` to `to` (both YYYY-MM-DD), UTC so a clock change can't shift it. */
export function daysBetween(from: string, to: string): number {
  const a = Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10));
  const b = Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10));
  return Math.round((b - a) / 86_400_000);
}

/**
 * Overdue once the due date has passed; due soon inside the check's reminder
 * lead (0 = only on the day); otherwise OK. No date = not set up yet.
 */
export function checkStatus(nextDue: string | null, remindDaysBefore: number, today: string): CheckStatus {
  if (!nextDue) return 'no_date';
  const days = daysBetween(today, nextDue);
  if (days < 0) return 'overdue';
  if (days <= Math.max(0, remindDaysBefore)) return 'due_soon';
  return 'ok';
}

/** Is the owner's reminder wanted today? (inside the lead, or overdue) */
export function reminderWanted(nextDue: string | null, remindDaysBefore: number, today: string): boolean {
  if (!nextDue) return false;
  return daysBetween(today, nextDue) <= Math.max(0, remindDaysBefore);
}

// ── 3. Next due once it's done ──────────────────────────────────────────────

export interface RepeatSetting {
  mode: Mode | null;
  rule: RecurrenceRule | null;
  anchor: string | null;
}

/**
 * The check's next due date after a record dated `doneOn`.
 *
 *   - A date typed from the certificate WINS (an EICR may say 3 years, not 5).
 *     Never "keep the later date" — the DVSA MOT rule: a date later than the
 *     real one makes reminders fire late.
 *   - after_done → doneOn + the interval.
 *   - schedule   → the next scheduled date after BOTH doneOn and the date it
 *     was due (done Tuesday for Thursday's test → next Thursday, not this one).
 *   - a one-off with no certificate date → nothing further is due.
 */
export function nextDueAfterRecord(
  repeat: RepeatSetting,
  doneOn: string,
  previousDue: string | null,
  certificateDate: string | null,
): { date: string | null; source: 'computed' | 'certificate' | null } {
  if (certificateDate) return { date: certificateDate, source: 'certificate' };
  if (!repeat.mode || !repeat.rule) return { date: null, source: null };
  if (repeat.mode === 'after_done') return { date: addInterval(repeat.rule, doneOn), source: 'computed' };
  const date = nextAfterClose('schedule', repeat.rule, repeat.anchor || doneOn, { today: doneOn, closedDue: previousDue });
  return { date, source: date ? 'computed' : null };
}

// ── Words ───────────────────────────────────────────────────────────────────

/** "14 Dec 2026" */
export function dateLabel(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * The owner's To Do title — it says what to DO, and when it's due.
 *   visit    → "Book: Gas safety inspection (due 14 Dec 2026)"
 *   renewal  → "Renew: Public liability insurance (due 1 Jan 2027)"
 *   test     → "Fire alarm test (due 20 Nov 2026)"
 *   landlord → "Get the landlord's copy: Gas safety inspection (due …)"
 */
export function reminderTitle(
  kind: string, responsibility: string, title: string, nextDue: string, point: string | null = null,
): string {
  const due = `(due ${dateLabel(nextDue)})`;
  if (responsibility === 'landlord') return `Get the landlord's copy: ${title} ${due}`;
  if (kind === 'visit') return `Book: ${title} ${due}`;
  if (kind === 'renewal') return `Renew: ${title} ${due}`;
  // A test that rotates through call points says which one is next.
  if (point) return `${title}: ${point} ${due}`;
  return `${title} ${due}`;
}

/**
 * The To Do once a visit is BOOKED — it stops asking "book it" and says who is
 * coming and when, for whoever is letting them in:
 *   "Northside Heating Ltd coming 14 Dec 2026 at 10:00 — let them in (Gas safety inspection)"
 */
export function bookingTitle(contractor: string | null, checkTitle: string, visitOn: string, visitTime: string | null): string {
  const when = `${dateLabel(visitOn)}${visitTime ? ` at ${visitTime}` : ''}`;
  return contractor
    ? `${contractor} coming ${when} — let them in (${checkTitle})`
    : `Visit on ${when} — let them in (${checkTitle})`;
}

// ── Call points (the weekly fire alarm test) ────────────────────────────────

/**
 * Which point is tested next: the one after the last one tested, round the
 * list. Nothing tested yet (or the last one has since been taken off the
 * list) starts at the first. No list = no rotation.
 */
export function nextPoint(points: string[] | null | undefined, lastPoint: string | null | undefined): string | null {
  const list = (points ?? []).map(p => p.trim()).filter(Boolean);
  if (!list.length) return null;
  const i = lastPoint ? list.indexOf(lastPoint.trim()) : -1;
  return list[(i + 1) % list.length];
}

/** A points list from a form: one per line or comma, trimmed, no blanks or repeats. */
export function cleanPoints(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[\n,]/);
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim().slice(0, 80);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, 50);
}

// ── Meter readings ──────────────────────────────────────────────────────────

export interface Reading { done_on: string; value: number; meter_replaced: boolean }

export interface UsageInterval {
  from: string;
  to: string;
  days: number;
  used: number;
  /** Used per 7 days over the interval — so a 9-day gap compares with a 7-day one. */
  per_week: number;
}

/**
 * Use between consecutive readings (oldest first). A reading marked "meter
 * replaced" starts the count afresh, so the gap before it is not a use; a
 * same-day pair is skipped (no rate).
 */
export function usageSeries(readings: Reading[]): UsageInterval[] {
  const sorted = [...readings].sort((a, b) => (a.done_on < b.done_on ? -1 : a.done_on > b.done_on ? 1 : 0));
  const out: UsageInterval[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.meter_replaced) continue;
    const days = daysBetween(prev.done_on, cur.done_on);
    if (days <= 0) continue;
    const used = cur.value - prev.value;
    out.push({ from: prev.done_on, to: cur.done_on, days, used, per_week: (used / days) * 7 });
  }
  return out;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export interface ReadingAssessment {
  previous: Reading | null;
  used: number | null;
  days: number | null;
  per_week: number | null;
  /** The usual week: the median of the last 8 intervals' use per week. */
  usual_per_week: number | null;
  flag: 'lower' | 'high' | null;
}

/** How many times the usual week counts as "looks high". */
export const HIGH_READING_FACTOR = 3;

/**
 * A new reading against the meter's history — a warning, never a refusal
 * (CLAUDE.md "warnings, not hard gates"):
 *   lower — less than the reading before (a typo, or a replaced meter)
 *   high  — more than three times the usual week
 * A replaced meter is never flagged: its count starts again.
 */
export function assessReading(history: Reading[], value: number, doneOn: string, replaced: boolean): ReadingAssessment {
  const before = history
    .filter(r => r.done_on <= doneOn)
    .sort((a, b) => (a.done_on < b.done_on ? -1 : a.done_on > b.done_on ? 1 : 0));
  const previous = before.length ? before[before.length - 1] : null;
  const usual = median(usageSeries(before).slice(-8).map(u => u.per_week).filter(x => x >= 0));
  if (!previous || replaced) {
    return { previous, used: null, days: null, per_week: null, usual_per_week: usual, flag: null };
  }
  const days = daysBetween(previous.done_on, doneOn);
  const used = value - previous.value;
  const perWeek = days > 0 ? (used / days) * 7 : null;
  let flag: ReadingAssessment['flag'] = null;
  if (used < 0) flag = 'lower';
  else if (perWeek !== null && usual !== null && usual > 0 && perWeek > usual * HIGH_READING_FACTOR) flag = 'high';
  return { previous, used, days, per_week: perWeek, usual_per_week: usual, flag };
}
