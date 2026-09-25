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

  // ── Staff records: the one dated action per record (mig 243) ─────────────
  // Replaced two sections — printed expiry and re-check cycle — which could
  // list one passport twice. Shows everything whose date is within the lead
  // window, chased or not: the bell is the push, this is the memory, and a row
  // stays until somebody moves or clears the date. Not filtered on employment
  // status, because a deletion flag is mostly for somebody who has left.
  const { listRecordActionsDue, listRecordsMissingDate } = await import('./staff-doc-cycles');
  const actions = await listRecordActionsDue({ onlyUnchased: false, withinDays: docLead });
  const withAction = new Set<string>();
  for (const a of actions) {
    withAction.add(a.id);
    const due = a.action_on <= today;
    if (a.action_kind === 'delete') {
      items.push({
        id: `record-${a.id}`,
        severity: due ? 'urgent' : 'soon',
        kind: 'record_delete_due',
        label: due ? `${a.label} is due for deletion` : `${a.label} due for deletion`,
        detail: a.action_on,
        personId: a.person_id,
        personName: a.person_name,
        tab: 'records',
        action: 'Review',
      });
    } else {
      const expired = !!a.expires_on && a.expires_on < today;
      items.push({
        id: `record-${a.id}`,
        severity: due || expired ? 'urgent' : 'soon',
        kind: 'record_action_due',
        label: expired ? `${a.label} expired` : due ? `${a.label} needs looking at` : `${a.label} coming up`,
        detail: a.action_on,
        personId: a.person_id,
        personName: a.person_name,
        tab: 'records',
        action: 'View',
      });
    }
  }

  // A document that has actually EXPIRED is a fact, not a reminder, so it
  // shows even when nobody set a date — unless the row above already covers
  // it. One row per record, never two.
  const expiredDocs = await query(
    `SELECT f.id, f.label, f.expires_on::text AS expires_on, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_record_files f
       JOIN people p ON p.id = f.person_id
       JOIN staff_employment se ON se.person_id = f.person_id
      WHERE f.deleted_at IS NULL
        AND se.employment_status = 'employed'
        AND f.expires_on IS NOT NULL
        AND f.expires_on < CURRENT_DATE
        AND f.action_kind <> 'delete'
      ORDER BY f.expires_on`
  );
  for (const d of expiredDocs.rows) {
    if (withAction.has(d.id)) continue;
    withAction.add(d.id);
    items.push({
      id: `record-${d.id}`,
      severity: 'urgent',
      kind: 'record_expired',
      label: `${d.label} expired`,
      detail: d.expires_on,
      personId: d.person_id,
      personName: d.person_name,
      tab: 'records',
      action: 'Replace',
    });
  }

  // The safety net under a self-serve system: a record that should have a
  // date (printed expiry, or a type with a re-check interval) and has none.
  for (const m of await listRecordsMissingDate()) {
    if (withAction.has(m.id)) continue;   // already on the list as expired
    items.push({
      id: `record-nodate-${m.id}`,
      severity: 'info',
      kind: 'record_no_date',
      label: `${m.label} has no review date`,
      detail: 'set one so it gets chased',
      personId: m.person_id,
      personName: m.person_name,
      tab: 'records',
      action: 'Set date',
    });
  }

  // Leavers: their records now need an end date, and nothing will prompt it
  // otherwise. Only while they still have records and none carries a deletion
  // date. Right-to-work has its own statutory row further down.
  const leavers = await query(
    `SELECT se.person_id, se.end_date::text AS left_on,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'left'
        AND EXISTS (SELECT 1 FROM staff_record_files f
                     WHERE f.person_id = se.person_id AND f.deleted_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM staff_record_files f
                         WHERE f.person_id = se.person_id AND f.deleted_at IS NULL
                           AND f.action_kind = 'delete' AND f.action_on IS NOT NULL)
      ORDER BY se.end_date DESC NULLS LAST`
  );
  for (const l of leavers.rows) {
    items.push({
      id: `leaver-${l.person_id}`,
      severity: 'info',
      kind: 'leaver_records',
      label: 'Left — records have no delete-by dates',
      detail: l.left_on ? `left ${l.left_on}` : null,
      personId: l.person_id,
      personName: l.person_name,
      tab: 'records',
      action: 'Set dates',
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

  // ── Check-in between reviews (spec §5.6) ──────────────────────────────────
  // Half-way through the cycle: "last time's actions — where are they?".
  // Same due date as the rows above, via listCheckInsDue().
  const { listCheckInsDue } = await import('./staff-employment');
  for (const c of await listCheckInsDue()) {
    items.push({
      id: `checkin-${c.person_id}`,
      severity: 'soon',
      kind: 'checkin_due',
      label: 'Check-in due',
      detail: `half-way since the ${c.last_reviewed_on} review`,
      personId: c.person_id,
      personName: c.person_name,
      tab: 'reviews',
      action: 'Check in',
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

  // ── Right to work past its statutory retention (Phase 7) ──────────────────
  // Surfaced for a human, never swept: destroying evidence of a right-to-work
  // check is irreversible and the clock runs off a hand-typed leaving date.
  const { flagRightToWorkForDisposal } = await import('./staff-retention');
  for (const d of await flagRightToWorkForDisposal()) {
    items.push({
      id: `rtw-disposal-${d.person_id}`,
      severity: 'info',
      kind: 'rtw_retention_expired',
      label: 'Right-to-work record can now be deleted',
      detail: `left ${d.left_on} — retention ended ${d.dispose_after}`,
      personId: d.person_id,
      personName: d.person_name,
      tab: 'records',
      action: 'Review',
    });
  }

  // ── Repeating to-dos still on a leaver (TASKS-SPEC §6.5) ──────────────────
  // Otherwise the meters stop being read the day somebody leaves.
  const { listLeaverSeries } = await import('./staff-task-series');
  for (const l of await listLeaverSeries()) {
    items.push({
      id: `leaver-series-${l.person_id}`,
      severity: 'soon',
      kind: 'leaver_repeating_todos',
      label: `${l.n} repeating to-do${l.n === 1 ? '' : 's'} still theirs`,
      detail: 'give them to someone else, or stop them',
      personId: l.person_id,
      personName: l.person_name,
      tab: null,
      action: 'Re-assign',
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
