/**
 * What became of a job — the outcome buckets for history views.
 *
 * ONE definition, shared by the org Hire History tab filter
 * (`GET /organisations/:id/hire-history?outcome=`) and the Leads client-history
 * summary (`services/leads/history.ts`), so "booked" and "lost" mean the same
 * thing on both.
 *
 * Each is a SQL predicate over a `jobs` row aliased `j`. OP-native jobs carry a
 * `pipeline_status`; older HireHop-synced ones may only have the HH `status`
 * code, hence the fallback on each.
 */
export const JOB_OUTCOME_SQL = {
  /** Still in play — enquiry, quoting, provisional, paused. */
  open: `(j.pipeline_status IN ('new_enquiry','quoting','provisional','paused','chasing') OR (j.pipeline_status IS NULL AND j.status IN (0,1)))`,
  /** Booked and not yet back. */
  confirmed: `(j.pipeline_status IN ('confirmed','prepped','dispatched') OR (j.pipeline_status IS NULL AND j.status IN (2,3,4,5,8)))`,
  /** Booked and done. */
  returned: `(j.pipeline_status IN ('returned','returned_incomplete','completed') OR (j.pipeline_status IS NULL AND j.status IN (6,7,11)))`,
  /** We quoted and they went elsewhere / didn't proceed (HH "Not Interested"). */
  lostOnly: `(j.pipeline_status = 'lost' OR (j.pipeline_status IS NULL AND j.status = 10))`,
  /** Booked, then called off (HH "Cancelled"). */
  cancelled: `(j.pipeline_status = 'cancelled' OR (j.pipeline_status IS NULL AND j.status = 9))`,
} as const;

/** Booked at some point and went ahead (confirmed or returned). */
export const JOB_BOOKED_SQL = `(${JOB_OUTCOME_SQL.confirmed} OR ${JOB_OUTCOME_SQL.returned})`;

/** The Hire History tab's "Lost" filter — lost OR cancelled. */
export const JOB_LOST_OR_CANCELLED_SQL = `(${JOB_OUTCOME_SQL.lostOnly} OR ${JOB_OUTCOME_SQL.cancelled})`;
