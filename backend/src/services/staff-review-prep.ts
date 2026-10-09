/**
 * The staff-facing half of a review. docs/STAFF-RECORDS-SPEC.md §5.3, §5.5.
 *
 * Phase 4 gave the reviewer somewhere to record a review. This gives the other
 * person a part in it: the prep questions before, the write-up after. A review
 * somebody cannot read is an appraisal done TO them.
 *
 * THE TWO RULES THIS FILE KEEPS:
 *
 * 1. Both sides answer the SAME questions, in advance (§5.3). That is what
 *    turns "boss delivers verdict" into "two documents compared", and it only
 *    works if the questions are identical — hence one source for them here.
 *
 * 2. The reviewee NEVER sees `private_notes` or `manager_prep`. Everything
 *    staff-facing goes through `getMyReview()`, which selects column by column
 *    rather than `SELECT *`, so a column added later cannot leak by default.
 *
 * 3. The reviewee's DRAFT (mig 262) is theirs alone. `self_assessment_draft`
 *    is what autosave writes while they mull it over; the reviewer reads only
 *    `self_assessment`, which changes on an explicit "Submit to reviewer".
 *    getMyReview() is the only reader of the draft columns — never add them
 *    to listReviews() or any reviewer-side SELECT.
 */

import { query } from '../config/database';

/** Used when the setting is missing or unparseable — never an empty form. */
export const DEFAULT_QUESTIONS = [
  "What's gone well since we last talked? Give me a specific example or two.",
  "What hasn't gone the way you wanted — and what would have helped?",
  'Which parts of the job do you most want more of?',
  "What do you want to be doing in a year that you're not doing now? What would get you there?",
  'What should Ooosh do differently? What gets in your way?',
  "Anything we haven't covered, or anything you've been sitting on?",
];

export interface Answer { q: string; a: string }

/**
 * The current question set, from `system_settings`.
 *
 * Falls back rather than throwing: a typo in a staff-editable setting must not
 * take the review form down, and an empty form is worse than the old wording.
 */
export async function getReviewQuestions(): Promise<string[]> {
  const { getSystemSetting } = await import('../routes/system-settings');
  const raw = await getSystemSetting('staff.review_questions');
  if (!raw?.trim()) return DEFAULT_QUESTIONS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    const questions = parsed
      .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
      .map(q => q.trim());
    return questions.length ? questions : DEFAULT_QUESTIONS;
  } catch (err) {
    console.warn('[staff-review-prep] staff.review_questions is not a JSON array of strings — using the built-in set:',
      err instanceof Error ? err.message : err);
    return DEFAULT_QUESTIONS;
  }
}

/**
 * The review this person should be looking at, if any.
 *
 * Prefers an upcoming one; falls back to the most recently completed so the
 * write-up stays readable after the meeting. Column-by-column SELECT: see the
 * header — nothing admin-only is in reach.
 */
export async function getMyReview(personId: string) {
  const r = await query(
    `SELECT id, review_type, scheduled_for::text AS scheduled_for, status,
            completed_at, shared_summary, outcome,
            next_review_due::text AS next_review_due,
            self_assessment, self_assessment_submitted_at,
            self_assessment_draft, self_assessment_draft_saved_at
       FROM staff_reviews
      WHERE person_id = $1
        AND (status IN ('proposed','confirmed')
             OR (status = 'completed' AND completed_at > NOW() - INTERVAL '90 days'))
      ORDER BY status IN ('proposed','confirmed') DESC, scheduled_for DESC
      LIMIT 1`,
    [personId]
  );
  return r.rows[0] ?? null;
}

/**
 * Save the reviewee's own answers.
 *
 * Ownership is checked HERE, against person_id, rather than trusted from the
 * route: this is the one write in the module a non-admin performs.
 *
 * Re-submittable until the review is completed — somebody who remembers
 * something the evening before should be able to add it.
 */
export async function submitSelfAssessment(reviewId: string, personId: string, answers: Answer[]) {
  const clean = cleanAnswers(answers);

  // Sending supersedes the draft, so both draft columns clear in the same
  // write — "you have changes your reviewer hasn't seen" is then simply
  // "a draft exists".
  const r = await query(
    `UPDATE staff_reviews
        SET self_assessment = $3::jsonb,
            self_assessment_submitted_at = NOW(),
            self_assessment_draft = NULL,
            self_assessment_draft_saved_at = NULL,
            updated_at = NOW()
      WHERE id = $1 AND person_id = $2
        AND status IN ('proposed','confirmed')
      RETURNING id`,
    // JSON.stringify per CLAUDE.md: node-postgres would otherwise send a JS
    // array as a Postgres ARRAY literal and JSONB would reject it.
    [reviewId, personId, JSON.stringify(clean)]
  );
  if (!r.rows.length) throw new Error('Review not found');
  return getMyReview(personId);
}

function cleanAnswers(answers: Answer[]): Answer[] {
  return answers
    .filter(a => a && typeof a.q === 'string')
    .map(a => ({ q: String(a.q).slice(0, 500), a: String(a.a ?? '').slice(0, 10_000) }));
}

/** Thrown when the draft's review exists and is theirs but is already over. */
export class ReviewClosedError extends Error {}

/**
 * Autosave the reviewee's answers into their PRIVATE draft (mig 262).
 *
 * Same ownership rule as submitSelfAssessment — checked here against
 * person_id, never trusted from the route — and the same window: open while
 * the review is proposed or confirmed. Does NOT touch self_assessment or its
 * submitted stamp; the reviewer sees nothing until they submit.
 *
 * Deliberately no updated_at bump: a keystroke is not an edit to the review
 * the admin side should see as "changed".
 */
export async function saveSelfAssessmentDraft(
  reviewId: string, personId: string, answers: Answer[]
): Promise<{ self_assessment_draft_saved_at: string }> {
  const r = await query(
    `UPDATE staff_reviews
        SET self_assessment_draft = $3::jsonb,
            self_assessment_draft_saved_at = NOW()
      WHERE id = $1 AND person_id = $2
        AND status IN ('proposed','confirmed')
      RETURNING self_assessment_draft_saved_at`,
    [reviewId, personId, JSON.stringify(cleanAnswers(answers))]
  );
  if (r.rows.length) return { self_assessment_draft_saved_at: r.rows[0].self_assessment_draft_saved_at };

  // Tell "not yours / not there" apart from "finished", so the page can say
  // which. Still scoped to person_id: somebody else's review stays not-found.
  const own = await query(
    'SELECT status FROM staff_reviews WHERE id = $1 AND person_id = $2',
    [reviewId, personId]
  );
  if (!own.rows.length) throw new Error('Review not found');
  throw new ReviewClosedError('This review is finished, so the answers can no longer be changed');
}

/** The reviewer's own answers to the same questions. Admin-only. */
export async function saveManagerPrep(reviewId: string, personId: string, answers: Answer[]) {
  const clean = cleanAnswers(answers);
  const r = await query(
    `UPDATE staff_reviews SET manager_prep = $3::jsonb, updated_at = NOW()
      WHERE id = $1 AND person_id = $2 RETURNING id`,
    [reviewId, personId, JSON.stringify(clean)]
  );
  if (!r.rows.length) throw new Error('Review not found');
  return r.rows[0];
}
