/**
 * Premises & compliance — the words, colours and shapes the screens share
 * (docs/PREMISES-COMPLIANCE-SPEC.md). No rules live here: status, dates and
 * who may see what are worked out by the backend (services/premises-rules.ts)
 * and arrive on each check.
 */
import type { RepeatMode, RepeatRule } from '../RecurrenceFields';

export type CheckKind = 'visit' | 'test' | 'reading' | 'renewal';
export type Visibility = 'all' | 'managers' | 'admins';
export type CheckStatus = 'overdue' | 'due_soon' | 'ok' | 'no_date';
export type Outcome = 'pass' | 'advisories' | 'fail';

export interface PremisesFile {
  id: string;
  r2_key: string;
  filename: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
}

export interface PremisesRecord {
  id: string;
  done_on: string;
  outcome: Outcome | null;
  notes: string | null;
  /** A meter reading, and whether the meter was replaced (its count starts again). */
  reading_value: number | null;
  meter_replaced: boolean;
  /** The call point a rotating test tried. */
  point: string | null;
  /** Filed later as a past record (spec §14). */
  backfilled: boolean;
  next_due_set: string | null;
  next_due_source: 'computed' | 'certificate' | null;
  done_by_org_id: string | null;
  done_by_org_name: string | null;
  recorded_by_name: string | null;
  files: PremisesFile[];
  /** The contractor's bill in Money › Costs, if linked (spec §15). */
  cost_id: string | null;
  cost: LinkedCost | null;
  /** The engineer's advisories — each can become a To Do or be ticked off. */
  advisories: Advisory[];
}

export interface LinkedCost {
  id: string;
  supplier_name: string | null;
  invoice_number: string | null;
  cost_date: string | null;
  amount_net: number | null;
  amount_gross: number | null;
}

export interface Advisory {
  id: string;
  text: string;
  done_at: string | null;
  task_id: string | null;
  task_status: 'open' | 'done' | 'cancelled' | null;
  task_owner: string | null;
}

/** An advisory is done when ticked off, or when its To Do was. */
export function advisoryDone(a: Advisory): boolean {
  return !!a.done_at || a.task_status === 'done';
}

/** "£186.00" */
export function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB', { style: 'currency', currency: 'GBP' });
}

// ── The documents library ───────────────────────────────────────────────────

export interface LibraryFile extends PremisesFile { created_at: string }
export interface LibraryDocument {
  id: string;
  folder_id: string;
  title: string;
  /** Its own setting (null = the folder's) and what it comes to. */
  visibility: Visibility | null;
  effective_visibility: Visibility;
  place_id: string | null;
  place_name: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Newest first — the first is the current version. */
  files: LibraryFile[];
}
export interface LibraryFolder {
  id: string;
  name: string;
  visibility: Visibility;
  sort_order: number;
  documents: LibraryDocument[];
}
export interface FolderRow { id: string; name: string; visibility: Visibility; sort_order: number; retired_at: string | null }

export interface PremisesCheck {
  id: string;
  title: string;
  kind: CheckKind;
  heading_id: string;
  heading_name: string;
  heading_sort: number;
  place_id: string;
  place_name: string;
  visibility: Visibility;
  owner_person_id: string | null;
  owner_name: string | null;
  contractor_org_id: string | null;
  contractor_name: string | null;
  responsibility: 'ours' | 'landlord';
  repeat_mode: RepeatMode | null;
  repeat_rule: RepeatRule | null;
  repeat_anchor: string | null;
  repeat_text: string;
  next_due: string | null;
  next_due_source: 'computed' | 'certificate' | 'typed' | null;
  remind_days_before: number;
  location_note: string | null;
  why_note: string | null;
  notes: string | null;
  retired_at: string | null;
  retired_reason: string | null;
  status: CheckStatus;
  days_to_due: number | null;
  last_done_on: string | null;
  last_outcome: Outcome | null;
  current_file_id: string | null;
  current_file_key: string | null;
  current_file_name: string | null;
  /** Meter readings: the unit ("kWh", "m³") and the meter's serial. */
  unit: string | null;
  meter_serial: string | null;
  /** A rotating test's call points, in order. */
  points: string[];
  records?: PremisesRecord[];
  open_reminder?: { id: string; owner_name: string | null; due_date: string | null } | null;
  /** A meter's use between readings, oldest first (check page). */
  usage?: UsageInterval[];
  /** The call point the next test should try (check page). */
  next_point?: string | null;
  /** What it has cost, by year, from the linked bills (check page). */
  cost_by_year?: { year: number; net: number; bills: number }[];
  /** A Staff Document this check is linked to (spec §16). */
  staff_document_id: string | null;
  staff_document_title: string | null;
  /** The live booked visit, if any (one per check). */
  booking_id: string | null;
  booking_on: string | null;
  booking_time: string | null;
  booking_note: string | null;
  booking_letting_in_person_id: string | null;
  booking_letting_in_name: string | null;
}

export interface UsageInterval { from: string; to: string; days: number; used: number; per_week: number }
export interface Reading { done_on: string; value: number; meter_replaced: boolean }

/** A meter as the Meter readings tab and the reading screen show it. */
export interface Meter extends PremisesCheck {
  last_reading: Reading | null;
  last_use: UsageInterval | null;
  usual_per_week: number | null;
  usage: UsageInterval[];
}

/** The server's view of a new reading — a warning, never a refusal. */
export interface ReadingAssessment {
  previous: Reading | null;
  used: number | null;
  days: number | null;
  per_week: number | null;
  usual_per_week: number | null;
  flag: 'lower' | 'high' | null;
}

export const METER_UNITS = ['kWh', 'm³', 'ft³', 'litres'];

/** "1,234.5" — readings and use, without trailing noise. */
export function fmtNumber(n: number | null | undefined, maxDecimals = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-GB', { maximumFractionDigits: maxDecimals });
}

/** The words for a reading's warning. */
export function readingWarning(a: ReadingAssessment | null, unit: string | null): string | null {
  if (!a || !a.flag) return null;
  const u = unit ? ` ${unit}` : '';
  if (a.flag === 'lower') return `That's lower than the last reading (${fmtNumber(a.previous?.value ?? null, 3)}${u}). Check the number — or tick "meter replaced" if it's a new meter.`;
  return `That's ${fmtNumber(a.used)}${u} since the last reading — over three times a usual week (about ${fmtNumber(a.usual_per_week)}${u}). Check the number, or add a note if it's right.`;
}

export interface Taxon { id: string; name: string; sort_order: number; retired_at: string | null }
export interface OwnerChoice { person_id: string; name: string | null; rank: number }
export interface PremisesMeta {
  places: Taxon[];
  headings: Taxon[];
  people: OwnerChoice[];
  my_person_id: string | null;
  can: { manage: boolean; admin: boolean };
}

export const KIND_LABEL: Record<CheckKind, string> = {
  visit: 'Contractor visit',
  test: 'In-house test',
  reading: 'Meter reading',
  renewal: 'Renewal date',
};
export const KIND_HINT: Record<CheckKind, string> = {
  visit: 'Someone comes in — gas, electrics, air con. Keep the certificate.',
  test: 'We do it ourselves — the weekly fire alarm test, first aid kits.',
  reading: 'A number off a meter — gas, electric, water.',
  renewal: 'A date and a document — insurance, lease, licences.',
};

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  all: 'Everyone (staff)',
  managers: 'Managers only',
  admins: 'Admins only',
};
export const VISIBILITY_RANK: Record<Visibility, number> = { all: 0, managers: 1, admins: 2 };

export const OUTCOME_LABEL: Record<Outcome, string> = {
  pass: 'Pass',
  advisories: 'Pass, with advisories',
  fail: 'Fail — needs work',
};
/** A test is OK or not — no advisories. */
export const TEST_OUTCOME_LABEL: Partial<Record<Outcome, string>> = { pass: 'OK', fail: 'Not OK' };

export const OUTCOME_CLASS: Record<Outcome, string> = {
  pass: 'bg-green-100 text-green-800',
  advisories: 'bg-amber-100 text-amber-800',
  fail: 'bg-red-100 text-red-800',
};

/** Sorting the register by status: most urgent first. */
export const STATUS_ORDER: Record<CheckStatus, number> = { overdue: 0, due_soon: 1, no_date: 2, ok: 3 };

/** "14 Dec 2026" */
export function fmtDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** "Mon 14 Dec" — a booked visit's day. */
export function fmtShortDay(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const d = new Date(`${ymd.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** A booked visit on the staff calendar (GET /premises/visits). */
export interface PremisesVisit {
  id: string;
  check_id: string;
  check_title: string;
  contractor_name: string | null;
  place_name: string;
  visit_on: string;
  visit_time: string | null;
  letting_in_name: string | null;
  note: string | null;
  status: 'booked' | 'done';
}

/** The pill: what it says and its colour. A booked visit shows as Booked, in blue. */
export function statusPill(c: Pick<PremisesCheck, 'status' | 'days_to_due' | 'retired_at'> & { booking_on?: string | null }): { text: string; cls: string } {
  if (c.retired_at) return { text: 'Retired', cls: 'bg-gray-100 text-gray-500' };
  if (c.booking_on) return { text: `Booked ${fmtShortDay(c.booking_on)}`, cls: 'bg-ooosh-100 text-ooosh-800' };
  const d = c.days_to_due;
  switch (c.status) {
    case 'overdue': return { text: `${-(d ?? 0)} day${d === -1 ? '' : 's'} overdue`, cls: 'bg-red-100 text-red-800' };
    case 'due_soon':
      return { text: d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due in ${d} days`, cls: 'bg-amber-100 text-amber-800' };
    case 'ok': return { text: 'OK', cls: 'bg-green-100 text-green-800' };
    default: return { text: 'Not set up', cls: 'bg-gray-100 text-gray-600' };
  }
}
