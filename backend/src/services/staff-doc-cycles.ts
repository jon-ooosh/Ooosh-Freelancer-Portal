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

export interface DueDoc {
  id: string;
  label: string;
  doc_type: string;
  person_id: string;
  person_name: string | null;
  document_date: string;
  due_on: string;
}

/**
 * Documents whose review cycle has come round.
 *
 * `onlyUnchased` is the same split as listReviewsDue(): the daily scan nudges
 * once per cycle, the Staff page's attention list always shows. One query,
 * so the bell and the page cannot disagree.
 */
export async function listDocsDueReview(opts: { onlyUnchased: boolean; withinDays: number }): Promise<DueDoc[]> {
  const intervals = await getReviewIntervals();
  const cycled = Object.entries(intervals).filter(([, months]) => months > 0);
  if (!cycled.length) return [];

  // The interval varies per type, so it goes in as a (type, months) list the
  // query joins against rather than a CASE expression built by string
  // concatenation.
  const types = cycled.map(([type]) => type);
  const months = cycled.map(([, m]) => String(m));

  const r = await query(
    `WITH iv AS (
       SELECT * FROM UNNEST($1::text[], $2::int[]) AS t(doc_type, months)
     )
     SELECT f.id, f.label, f.doc_type, f.person_id,
            NULLIF(TRIM(COALESCE(p.preferred_name, p.first_name, '') || ' ' ||
                        COALESCE(p.last_name, '')), '') AS person_name,
            f.document_date::text AS document_date,
            LEAST(
              (f.document_date + (iv.months || ' months')::interval)::date,
              COALESCE(f.expires_on, 'infinity'::date)
            )::text AS due_on
       FROM staff_record_files f
       JOIN iv ON iv.doc_type = f.doc_type
       JOIN people p ON p.id = f.person_id
       JOIN staff_employment se ON se.person_id = f.person_id
      WHERE f.deleted_at IS NULL
        AND se.employment_status = 'employed'
        AND f.document_date IS NOT NULL
        AND ($3::boolean IS FALSE OR f.review_chased_at IS NULL)
        AND LEAST(
              (f.document_date + (iv.months || ' months')::interval)::date,
              COALESCE(f.expires_on, 'infinity'::date)
            ) <= (CURRENT_DATE + ($4 || ' days')::interval)::date
        -- A newer document of the same type supersedes this one: re-checking
        -- last year's DVLA check when this year's is already filed is noise.
        AND NOT EXISTS (
          SELECT 1 FROM staff_record_files newer
           WHERE newer.person_id = f.person_id
             AND newer.doc_type = f.doc_type
             AND newer.deleted_at IS NULL
             AND newer.document_date > f.document_date
        )
      ORDER BY due_on`,
    [types, months, opts.onlyUnchased, String(opts.withinDays)]
  );
  return r.rows as DueDoc[];
}

/** Stamp a document as chased, so the daily scan nudges once per cycle. */
export async function markDocChased(fileId: string): Promise<void> {
  await query('UPDATE staff_record_files SET review_chased_at = NOW() WHERE id = $1', [fileId]);
}
