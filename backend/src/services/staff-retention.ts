/**
 * Retention — what expires, and what must never expire.
 * docs/STAFF-RECORDS-SPEC.md §7, Phase 7.
 *
 * THE DISTINCTION THE WHOLE FILE TURNS ON: an absence record does two jobs.
 * It is special-category medical data AND it is the evidence behind ledger
 * entries — holiday reclaim, unpaid days on the payroll report. Deleting the
 * row would take the second with the first, so the sweep nulls the DETAIL and
 * leaves the spell standing.
 *
 * WHAT SURVIVES, verified rather than assumed: `absence_type` stays, because
 * `getSicknessMinutes()` filters on `absence_type = 'sickness'` and the
 * payroll report reads it. §7 originally listed the type as expiring; purging
 * it would silently zero everybody's sickness figures instead of anonymising
 * them. Day rows, minutes and ledger effects stay for the same reason.
 *
 * WHY RIGHT TO WORK IS NOT SWEPT HERE: see flagRightToWorkForDisposal(). It
 * is surfaced for a human, never deleted automatically.
 */

import { query } from '../config/database';

/**
 * Null the medical detail on absences that ended longer ago than the retention
 * period. Idempotent: `detail_purged_at` means it never runs twice on a row.
 */
export async function runAbsenceDetailPurge(): Promise<{ purged: number }> {
  const { getSystemSetting } = await import('../routes/system-settings');
  const raw = await getSystemSetting('staff.absence_detail_retention_months');
  const months = Number(raw) > 0 ? Number(raw) : 12;

  const r = await query(
    `UPDATE staff_absences
        SET reason_category   = NULL,
            notes             = NULL,
            rtw_fit_to_return = NULL,
            rtw_adjustments   = NULL,
            rtw_notes         = NULL,
            detail_purged_at  = NOW()
      WHERE detail_purged_at IS NULL
        AND end_date IS NOT NULL
        AND end_date < (CURRENT_DATE - ($1 || ' months')::interval)::date
        -- Only rows that actually hold detail. Without this every historic
        -- absence gets stamped on the first run and the log claims hundreds
        -- of purges that removed nothing.
        AND (reason_category IS NOT NULL OR notes IS NOT NULL
             OR rtw_fit_to_return IS NOT NULL OR rtw_adjustments IS NOT NULL
             OR rtw_notes IS NOT NULL)
      RETURNING id`,
    [String(months)]
  );

  if (r.rows.length) {
    console.log(`[staff-retention] absence detail purged on ${r.rows.length} spell(s)`);
  }
  return { purged: r.rows.length };
}

export interface DisposalItem {
  person_id: string;
  person_name: string | null;
  left_on: string;
  dispose_after: string;
}

/**
 * Right-to-work evidence past its statutory retention — SURFACED, not deleted.
 *
 * jon, Sep 2026: keep it for the whole employment plus two years after they
 * leave. So the clock starts from `staff_employment.end_date`, which is a date
 * a human typed.
 *
 * It is deliberately NOT swept automatically, unlike absence detail, for three
 * reasons: destroying evidence of a right-to-work check is irreversible and
 * legally consequential; the clock depends on an end date somebody could have
 * entered wrongly; and CLAUDE.md's product policy is warnings rather than
 * silent action. An admin gets told, and decides.
 */
export async function flagRightToWorkForDisposal(): Promise<DisposalItem[]> {
  const { getSystemSetting } = await import('../routes/system-settings');
  const raw = await getSystemSetting('staff.rtw_retention_years_after_leaving');
  const years = Number(raw) > 0 ? Number(raw) : 2;

  const r = await query(
    `SELECT se.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name,
            se.end_date::text AS left_on,
            (se.end_date + ($1 || ' years')::interval)::date::text AS dispose_after
       FROM staff_employment se
       JOIN people p ON p.id = se.person_id
      WHERE se.employment_status = 'left'
        AND se.end_date IS NOT NULL
        AND (se.end_date + ($1 || ' years')::interval)::date <= CURRENT_DATE
        -- Only while there is still something to dispose of.
        AND (p.rtw_document_type IS NOT NULL
             OR EXISTS (SELECT 1 FROM staff_record_files f
                         WHERE f.person_id = se.person_id
                           AND f.doc_type = 'right_to_work'
                           AND f.deleted_at IS NULL))
      ORDER BY se.end_date`,
    [String(years)]
  );
  return r.rows as DisposalItem[];
}
