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

const VIS_RANK: Record<Visibility, number> = { all: 0, managers: 1, admins: 2 };

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
export function reminderTitle(kind: string, responsibility: string, title: string, nextDue: string): string {
  const due = `(due ${dateLabel(nextDue)})`;
  if (responsibility === 'landlord') return `Get the landlord's copy: ${title} ${due}`;
  if (kind === 'visit') return `Book: ${title} ${due}`;
  if (kind === 'renewal') return `Renew: ${title} ${due}`;
  return `${title} ${due}`;
}
