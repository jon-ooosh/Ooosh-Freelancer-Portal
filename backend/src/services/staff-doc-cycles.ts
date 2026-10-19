/**
 * Document review cycles — "we want a new DVLA check code every year".
 * docs/STAFF-RECORDS-SPEC.md §4, Phase 6.
 *
 * DELIBERATELY UNRELATED TO THE DRIVER SYSTEM. jon, Sep 2026: the `drivers`
 * machinery verifies self-drive-hire CLIENTS; the staff version is an annual
 * sanity check that an employee is still declaring what they should. Same
 * words, different people, different consequence — so nothing here reads
 * `drivers`, and `services/driver-validity.ts` (30-day hire insurability)
 * stays untouched. That is what finally settles §1.1/§1.2: by not sharing.
 *
 * THE MODEL, inherited from driver-validity even though the code is not:
 * a human records the FROM date — `document_date`, the day it was issued,
 * signed or checked — and the system derives when it next needs looking at.
 * Never ask anybody for "due on".
 *
 *   review due = document_date + the type's interval
 *   …capped by expires_on when the document has its own printed expiry,
 *     because a passport that runs out in March does not need re-checking
 *     in June — it needs replacing in March.
 *
 * SINCE MIGRATION 243 that derived date is a DEFAULT, not the clock. jon
 * wanted to set each record's date himself, like the remind-me on a job, so
 * the upload form pre-fills `action_on` from this rule (frontend
 * StaffRecordFiles.tsx `suggestActionDate`) and whatever he leaves there is
 * what fires. The intervals below still matter — they are what the form
 * suggests and what decides whether a record "should" have a date.
 * docs/STAFF-RECORDS-SPEC.md §22.
 */

import { query } from '../config/database';

/** Months per doc_type. 0 = no cycle, which is right for a contract. */
export const DEFAULT_INTERVALS: Record<string, number> = {
  dvla_check: 12,
  licence: 12,
  right_to_work: 0,
  passport: 0,
  qualification: 0,
  contract: 0,
  medical: 0,
  other: 0,
};

/**
 * The configured intervals, falling back rather than throwing.
 *
 * Same rule as the review questions: this is staff-editable, so a typo must
 * not take the scan down. Chasing nothing is a silent failure and chasing
 * everything is a flood — the built-in map is the safe middle.
 */
export async function getReviewIntervals(): Promise<Record<string, number>> {
  const { getSystemSetting } = await import('../routes/system-settings');
  const raw = await getSystemSetting('staff.doc_review_intervals');
  if (!raw?.trim()) return DEFAULT_INTERVALS;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    const out: Record<string, number> = { ...DEFAULT_INTERVALS };
    for (const [key, value] of Object.entries(parsed)) {
      const months = Number(value);
      if (Number.isFinite(months) && months >= 0 && months <= 600) out[key] = months;
    }
    return out;
  } catch (err) {
    console.warn('[staff-doc-cycles] staff.doc_review_intervals is not a JSON object of months — using the built-in map:',
      err instanceof Error ? err.message : err);
    return DEFAULT_INTERVALS;
  }
}

/**
 * Types where only the NEWEST record is current. Filing this year's DVLA check
 * makes last year's history, so a reminder still set on the old one is noise.
 * Deliberately not every type: two "qualification" or "medical" records are
 * usually two different things, and silencing one because the other exists
 * would lose a reminder somebody set on purpose.
 */
export const SUPERSEDING_TYPES = ['contract', 'right_to_work', 'passport', 'licence', 'dvla_check'];

export interface RecordAction {
  id: string;
  label: string;
  doc_type: string;
  person_id: string;
  person_name: string | null;
  action_on: string;
  action_kind: 'remind' | 'delete';
  action_delivery: 'notification' | 'email' | 'both';
  action_user_id: string | null;
  action_note: string | null;
  expires_on: string | null;
}

/**
 * Records whose action date has come round (or comes round within
 * `withinDays`). THE one clock for staff records since mig 243 — it replaced
 * the separate expiry and re-check clocks, which could nag twice about one
 * passport.
 *
 * The date is whatever the admin set. The form PRE-FILLS it from the printed
 * expiry and the type's interval (getReviewIntervals), so the old automatic
 * behaviour is the default rather than something to remember — but the stored
 * date is the only thing read here.
 *
 * `onlyUnchased` is the same split as listReviewsDue(): the 09:45 scan fires
 * once per date, the Staff page's attention list always shows. One query, so
 * the bell and the page cannot disagree.
 *
 * Deliberately NOT filtered on employment status: a "flag for deletion" date
 * is mostly set on somebody who has LEFT, and that is exactly when it matters.
 */
export async function listRecordActionsDue(
  opts: { onlyUnchased: boolean; withinDays: number }
): Promise<RecordAction[]> {
  const r = await query(
    `SELECT f.id, f.label, f.doc_type, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name,
            f.action_on::text AS action_on, f.action_kind, f.action_delivery,
            f.action_user_id, f.action_note, f.expires_on::text AS expires_on
       FROM staff_record_files f
       JOIN people p ON p.id = f.person_id
      WHERE f.deleted_at IS NULL
        AND f.action_on IS NOT NULL
        AND f.action_on <= (CURRENT_DATE + ($1 || ' days')::interval)::date
        AND ($2::boolean IS FALSE OR f.action_chased_at IS NULL)
        -- A newer record of a one-current type supersedes a REMINDER on this
        -- one. Never a deletion flag: that was set on purpose about this file.
        AND NOT (
          f.action_kind = 'remind'
          AND f.doc_type = ANY($3::text[])
          AND EXISTS (
            SELECT 1 FROM staff_record_files newer
             WHERE newer.person_id = f.person_id
               AND newer.doc_type = f.doc_type
               AND newer.deleted_at IS NULL
               AND newer.id <> f.id
               AND COALESCE(newer.document_date, newer.uploaded_at::date)
                 > COALESCE(f.document_date, f.uploaded_at::date)
          )
        )
      ORDER BY f.action_on`,
    [String(opts.withinDays), opts.onlyUnchased, SUPERSEDING_TYPES]
  );
  return r.rows as RecordAction[];
}

/**
 * Current records that SHOULD have a date and don't — the safety net under a
 * self-serve system, where the one failure mode is forgetting to set one.
 *
 * "Should" is read from the data, not a second list: a record has a printed
 * expiry, or its type has a re-check interval. Superseded records and people
 * who have left are skipped; the first is history and the second has the
 * leaver prompt on the attention list instead.
 */
export async function listRecordsMissingDate(): Promise<
  { id: string; label: string; person_id: string; person_name: string | null }[]
> {
  const intervals = await getReviewIntervals();
  const cycled = Object.entries(intervals).filter(([, m]) => m > 0).map(([t]) => t);
  const r = await query(
    `SELECT f.id, f.label, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name
       FROM staff_record_files f
       JOIN people p ON p.id = f.person_id
       JOIN staff_employment se ON se.person_id = f.person_id
      WHERE f.deleted_at IS NULL
        AND se.employment_status = 'employed'
        AND f.action_on IS NULL
        AND (f.expires_on IS NOT NULL OR f.doc_type = ANY($1::text[]))
        AND NOT (
          f.doc_type = ANY($2::text[])
          AND EXISTS (
            SELECT 1 FROM staff_record_files newer
             WHERE newer.person_id = f.person_id
               AND newer.doc_type = f.doc_type
               AND newer.deleted_at IS NULL
               AND newer.id <> f.id
               AND COALESCE(newer.document_date, newer.uploaded_at::date)
                 > COALESCE(f.document_date, f.uploaded_at::date)
          )
        )
      ORDER BY p.first_name, f.label`,
    [cycled, SUPERSEDING_TYPES]
  );
  return r.rows;
}

/** Stamp a record's action as fired, so the daily scan fires once per date. */
export async function markActionChased(fileId: string): Promise<void> {
  await query('UPDATE staff_record_files SET action_chased_at = NOW() WHERE id = $1', [fileId]);
}
