/**
 * "Needs attention" — the cross-person view of the Staff page.
 *
 * WHY THIS EXISTS: everything in the staff-records module was organised
 * person → topic, but almost every real question runs the other way — "whose
 * review is due?", "what's expiring?", "who's still missing right to work?".
 * Answering any of those meant opening seven cards in turn. The reminders
 * built in phases 3–4 push those facts at an admin once; this is the surface
 * you can ASK.
 *
 * Nothing here is stored or maintained by hand — every row is derived from
 * data another part of the module already writes. Adding a source means
 * adding a query below, never a new column or a flag somebody has to clear.
 *
 * The review-due rule is deliberately NOT restated here: it comes from
 * `listReviewsDue()` in staff-employment.ts, the same function the 09:45 scan
 * uses, so the page and the bell can never disagree about who is overdue.
 */

import { query } from '../config/database';
import { listReviewsDue } from './staff-employment';

export type Severity = 'urgent' | 'soon' | 'info';

export interface AttentionItem {
  /** Stable within a response — used as a React key, not persisted. */
  id: string;
  severity: Severity;
  /** What kind of thing this is, for grouping/filtering later. */
  kind: string;
  /** The headline, already phrased for a human. */
  label: string;
  /** Extra context, shown quieter. */
  detail?: string | null;
  personId?: string | null;
  personName?: string | null;
  /** Which tab of the person view answers it. */
  tab?: string | null;
  /** The call to action. */
  action?: string | null;
}

function ymd(offsetDays = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Sort: urgent first, then soon, then info; within a band, soonest date. */
const RANK: Record<Severity, number> = { urgent: 0, soon: 1, info: 2 };

export async function getStaffAttention(): Promise<AttentionItem[]> {
  const { getDocumentExpiryLeadDays, getReviewLeadDays } = await import('./staff-settings');
  const [docLead, reviewLead] = await Promise.all([
    getDocumentExpiryLeadDays(), getReviewLeadDays(),
  ]);

  const today = ymd();
  const items: AttentionItem[] = [];

  // ── Documents with an expiry that has passed or is close ──────────────────
  const docs = await query(
    `SELECT f.id, f.label, f.expires_on::text AS expires_on, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_record_files f
       JOIN people p ON p.id = f.person_id
       JOIN staff_employment se ON se.person_id = f.person_id
      WHERE f.deleted_at IS NULL
        AND se.employment_status = 'employed'
        AND f.expires_on IS NOT NULL
        AND f.expires_on <= $1::date
      ORDER BY f.expires_on`,
    [ymd(docLead)]
  );
  for (const d of docs.rows) {
    const expired = d.expires_on < today;
    items.push({
      id: `doc-${d.id}`,
      severity: expired ? 'urgent' : 'soon',
      kind: 'document_expiry',
      label: expired ? `${d.label} expired` : `${d.label} expires`,
      detail: d.expires_on,
      personId: d.person_id,
      personName: d.person_name,
      tab: 'records',
      action: expired ? 'Replace' : 'View',
    });
  }

  // ── Right to work: never recorded, or time-limited and running out ────────
  // A legal record we must hold and produce on request, so a missing one is
  // urgent regardless of how long they have been here.
  const rtw = await query(
    `SELECT se.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name,
            p.rtw_document_type,
            p.rtw_expires_on::text AS rtw_expires_on,
            se.start_date::text AS start_date,
            (p.ni_number_encrypted IS NOT NULL) AS has_ni
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'
      ORDER BY p.first_name, p.last_name`
  );
  for (const r of rtw.rows) {
    if (!r.rtw_document_type) {
      items.push({
        id: `rtw-missing-${r.person_id}`,
        severity: 'urgent',
        kind: 'right_to_work_missing',
        label: 'Right to work not recorded',
        detail: r.start_date ? `started ${r.start_date}` : null,
        personId: r.person_id,
        personName: r.person_name,
        tab: 'records',
        action: 'Record it',
      });
    } else if (r.rtw_expires_on && r.rtw_expires_on <= ymd(60)) {
      items.push({
        id: `rtw-expiring-${r.person_id}`,
        severity: r.rtw_expires_on < today ? 'urgent' : 'soon',
        kind: 'right_to_work_expiry',
        label: r.rtw_expires_on < today
          ? 'Permission to work has expired'
          : 'Permission to work expires',
        detail: r.rtw_expires_on,
        personId: r.person_id,
        personName: r.person_name,
        tab: 'records',
        action: 'Re-check',
      });
    }
    // NI is 'info', not 'soon': payroll needs it, but nothing breaks today and
    // an amber row for something quietly routine trains people to ignore amber.
    if (!r.has_ni) {
      items.push({
        id: `ni-${r.person_id}`,
        severity: 'info',
        kind: 'ni_missing',
        label: 'NI number not recorded',
        detail: 'needed for payroll',
        personId: r.person_id,
        personName: r.person_name,
        tab: 'records',
        action: 'Add it',
      });
    }
  }

  // ── Reviews falling due ───────────────────────────────────────────────────
  const reviews = await listReviewsDue({ onlyUnchased: false, withinDays: reviewLead });
  for (const r of reviews) {
    items.push({
      id: `review-${r.person_id}`,
      severity: r.due_on < today ? 'urgent' : 'soon',
      kind: 'review_due',
      label: r.due_on < today ? 'Review overdue' : 'Review due',
      detail: r.last_reviewed_on ? `last reviewed ${r.last_reviewed_on}` : 'never reviewed',
      personId: r.person_id,
      personName: r.person_name,
      tab: 'reviews',
      action: 'Book it',
    });
  }

  // ── Probation ending ──────────────────────────────────────────────────────
  const probation = await query(
    `SELECT se.person_id, se.probation_end_date::text AS ends_on,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'
        AND se.probation_end_date IS NOT NULL
        AND se.probation_end_date <= $1::date
        AND se.probation_end_date >= CURRENT_DATE - INTERVAL '30 days'
      ORDER BY se.probation_end_date`,
    [ymd(28)]
  );
  for (const p of probation.rows) {
    items.push({
      id: `probation-${p.person_id}`,
      severity: 'soon',
      kind: 'probation_ending',
      label: p.ends_on < today ? 'Probation has ended' : 'Probation ends',
      detail: p.ends_on,
      personId: p.person_id,
      personName: p.person_name,
      tab: 'reviews',
      action: 'Book review',
    });
  }

  // ── No working pattern ────────────────────────────────────────────────────
  // Same LATERAL as the roster's weekly_minutes: a person with no pattern in
  // force today reads zero everywhere — holiday entitlement, the payroll
  // report, the calendar — so this is a broken record, not a preference.
  const noPattern = await query(
    `SELECT se.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'employed'
        AND NOT EXISTS (
          SELECT 1 FROM staff_working_patterns wp
           WHERE wp.person_id = se.person_id
             AND wp.effective_from <= CURRENT_DATE
             AND (wp.effective_to IS NULL OR wp.effective_to >= CURRENT_DATE)
        )
      ORDER BY p.first_name, p.last_name`
  );
  for (const p of noPattern.rows) {
    items.push({
      id: `pattern-${p.person_id}`,
      severity: 'soon',
      kind: 'no_pattern',
      label: 'No working hours set',
      detail: 'holiday and payroll read zero',
      personId: p.person_id,
      personName: p.person_name,
      tab: 'employment',
      action: 'Set hours',
    });
  }

  // ── Logins with no person behind them ─────────────────────────────────────
  const unlinked = await query(
    `SELECT u.id, u.email FROM users u
      WHERE u.is_active = true AND u.person_id IS NULL
      ORDER BY u.email`
  );
  for (const u of unlinked.rows) {
    items.push({
      id: `unlinked-${u.id}`,
      severity: 'info',
      kind: 'unlinked_login',
      label: 'Login not linked to a person',
      detail: u.email,
      personId: null,
      personName: null,
      tab: null,
      action: 'Link',
    });
  }

  items.sort((a, b) => {
    const r = RANK[a.severity] - RANK[b.severity];
    if (r !== 0) return r;
    return (a.detail ?? '').localeCompare(b.detail ?? '');
  });
  return items;
}
