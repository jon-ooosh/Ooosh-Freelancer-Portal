/**
 * Pipeline lifecycle ordering — "is this status change moving the job forward,
 * or winding it back?"
 *
 * WHY THIS ISN'T `PIPELINE_STATUS_CONFIG.order` FROM @shared:
 *   That `order` is a BOARD COLUMN order for the pipeline UI — it puts `lost`
 *   at 6 and `cancelled` at 7, after `confirmed`, and the operational statuses
 *   live in a separate config with no order at all. Read as a lifecycle it
 *   would call `confirmed -> lost` a step forward. Different question, so a
 *   separate definition, deliberately.
 *
 * WHY IT MATTERS:
 *   Several side effects on a status change assume the job is arriving at that
 *   status for the first time, on its way up. Staff also use the status
 *   dropdown to CORRECT a status — marking a job Prepped and putting it back
 *   to Booked — and those corrections used to look identical to real progress.
 *   That is how info@ got "last-minute booking" emails about jobs confirmed
 *   weeks earlier (jobs 15912, 16453, 16491, Aug-Sep 2026).
 *
 * The off-ramps (`lost`, `cancelled`, `paused`) sit outside the ladder: leaving
 * one is neither forwards nor backwards in a useful sense, and the routes
 * already handle resurrection explicitly by name. They get no rank, and
 * `isBackwardsTransition` answers false for anything it cannot rank.
 */

/** Rungs of the ladder a job climbs. Off-ramp statuses are absent by design. */
const PIPELINE_STAGE_ORDER: Record<string, number> = {
  new_enquiry: 1,
  quoting: 2,
  chasing: 2,
  provisional: 3,
  confirmed: 4,
  prepping: 5,
  prepped: 6,
  dispatched: 7,
  returned_incomplete: 8,
  returned: 9,
  completed: 10,
};

/**
 * Statuses a job sits at before the booking is won.
 *
 * `paused` is here because a paused enquiry is still an enquiry — it has not
 * been won, and confirming out of it IS winning it.
 */
export const PRE_CONFIRMED_STATUSES = [
  'new_enquiry', 'quoting', 'chasing', 'paused', 'provisional',
];

/**
 * Did this transition WIN the booking, as opposed to correcting a status on a
 * job that was already won?
 *
 * `lost` and `cancelled` count: a dead job that comes back is genuinely a new
 * booking, and anything gated on this (the last-minute alert, confirmation
 * reminders) should treat it as one.
 */
export function isBookingWonTransition(fromStatus: string | null | undefined): boolean {
  if (!fromStatus) return false;
  return PRE_CONFIRMED_STATUSES.includes(fromStatus)
    || fromStatus === 'lost'
    || fromStatus === 'cancelled';
}

/**
 * Is this a wind-back — a job moving DOWN the ladder?
 *
 * False when either end is an off-ramp or an unknown status: those are not
 * wind-backs, and callers must not read "can't tell" as "yes".
 */
export function isBackwardsTransition(
  fromStatus: string | null | undefined,
  toStatus: string | null | undefined,
): boolean {
  const from = fromStatus ? PIPELINE_STAGE_ORDER[fromStatus] : undefined;
  const to = toStatus ? PIPELINE_STAGE_ORDER[toStatus] : undefined;
  if (from === undefined || to === undefined) return false;
  return to < from;
}

/**
 * Is the job being wound back to a stage BEFORE the booking was won?
 *
 * The trigger for dropping the confirmation stamp: a job sent back to
 * Provisional has, as far as the record goes, been un-won, and a later genuine
 * re-confirmation should record its own date rather than inheriting the first
 * one through a COALESCE.
 */
export function isUnwonTransition(
  fromStatus: string | null | undefined,
  toStatus: string | null | undefined,
): boolean {
  if (!toStatus || !PRE_CONFIRMED_STATUSES.includes(toStatus)) return false;
  if (!fromStatus || PRE_CONFIRMED_STATUSES.includes(fromStatus)) return false;
  // Coming off the lost/cancelled off-ramps back into the enquiry pile is a
  // resurrection, handled by name elsewhere — not an un-winning.
  return fromStatus !== 'lost' && fromStatus !== 'cancelled';
}
