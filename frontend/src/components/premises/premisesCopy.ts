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
  next_due_set: string | null;
  next_due_source: 'computed' | 'certificate' | null;
  done_by_org_id: string | null;
  done_by_org_name: string | null;
  recorded_by_name: string | null;
  files: PremisesFile[];
}

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
  records?: PremisesRecord[];
  open_reminder?: { id: string; owner_name: string | null; due_date: string | null } | null;
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
  reading: 'A number off a meter.',
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

/** The pill: what it says and its colour. */
export function statusPill(c: Pick<PremisesCheck, 'status' | 'days_to_due' | 'retired_at'>): { text: string; cls: string } {
  if (c.retired_at) return { text: 'Retired', cls: 'bg-gray-100 text-gray-500' };
  const d = c.days_to_due;
  switch (c.status) {
    case 'overdue': return { text: `${-(d ?? 0)} day${d === -1 ? '' : 's'} overdue`, cls: 'bg-red-100 text-red-800' };
    case 'due_soon':
      return { text: d === 0 ? 'Due today' : d === 1 ? 'Due tomorrow' : `Due in ${d} days`, cls: 'bg-amber-100 text-amber-800' };
    case 'ok': return { text: 'OK', cls: 'bg-green-100 text-green-800' };
    default: return { text: 'Not set up', cls: 'bg-gray-100 text-gray-600' };
  }
}
