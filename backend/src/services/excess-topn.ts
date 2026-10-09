/**
 * Top-N excess reconciliation — make the job's chargeable excess records match
 * the documented rule: the total for a hire = the N highest driver liabilities,
 * where N = the HH self-drive van count.
 *
 * ── WHY THIS EXISTS (the under-collection leak, Sep 2026) ──────────────────
 *
 * The rule has always been "top N by amount", but neither write path could
 * implement it, because a driver's liability isn't known until they submit:
 *
 *   • `POST /hire-forms` ranked by ARRIVAL, not amount — its own comment
 *     admitted the approximation ("we can't sort by amount at submission time
 *     ... so we approximate as first-N-assigned. Staff can manually flip
 *     records if a higher-excess referral lands late"). No such flip existed.
 *     Once N drivers had records, a LATER driver was inserted at £0 /
 *     `not_required` and their amount discarded — the incumbent record was
 *     never revisited. A 1-van hire where a clean £1,200 driver submitted
 *     first and an £1,800 referral driver submitted second collected £1,200.
 *     Six hundred pounds, silently, with every surface reading "all clear".
 *
 *   • `POST /hire-forms/quick-assign` was worse: it inserted a flat £1,200 and
 *     never read the driver's liability at all, so a quick-assigned referral
 *     driver was under-charged even when they WERE within the top N.
 *
 *   • The safety net didn't work. The referral-authorise step claimed to
 *     "surface the recomputed top-N vs held", but its query SUMS the records
 *     that are already chargeable and EXCLUDES `not_required` — so the £1,800
 *     driver sitting at £0 was invisible to the very check meant to catch them.
 *
 * The fix is not a manual flip. `drivers.calculated_excess_amount` is written
 * for EVERY driver on submission (hire-forms.ts §3a) whatever the top-N outcome,
 * so the correct ranking is already knowable — it just was never asked for.
 * This runs after any driver write and applies it.
 *
 * ── THE MONEY GUARD (the reason this is safe) ─────────────────────────────
 *
 * Reshuffling is pure arithmetic on two rows UNTIL money lands. After that a
 * record accumulates things that cannot be moved with it — the HireHop deposit
 * id and its Xero posting, a Stripe PaymentIntent, refund legs, encrypted bank
 * details, and membership of a cross-job rollover chain. So a record holding
 * ANY of those is FROZEN: never demoted, never re-priced. If a frozen record
 * occupies a slot the ranking would give to someone else, we leave it alone and
 * report it in `blocked` for staff to decide (top up, or adjust) — the same
 * "never silently move money" convention as the referral-authorise step.
 *
 * Idempotent, and deliberately stable: ranking ties break on `created_at ASC`,
 * so equal-liability drivers leave the incumbent in place rather than churning
 * the record set on every write.
 */

type Querier = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;

/** The floor every driver carries, matching hire-forms.ts. */
export const STANDARD_EXCESS_PER_DRIVER = 1200;

export interface TopNBlockedSlot {
  /** Driver who SHOULD be carrying a charge but can't be promoted. */
  driverName: string | null;
  /** Their liability — what the hire is short by, if nothing else changes. */
  shouldBe: number;
  /** Why we couldn't act. */
  reason: 'frozen_incumbent';
}

export interface TopNReconcileResult {
  /** True when any record's status or amount actually changed. */
  changed: boolean;
  vanCount: number;
  /** Sum of excess_amount_required across chargeable records after the pass. */
  chargeableTotal: number;
  /** What the total WOULD be if no record were frozen. */
  correctTotal: number;
  /** Slots the money guard stopped us fixing. Empty in the normal case. */
  blocked: TopNBlockedSlot[];
  /** Human-readable summary for logs / audit. Null when nothing changed. */
  summary: string | null;
}

const EMPTY = (vanCount = 0): TopNReconcileResult => ({
  changed: false, vanCount, chargeableTotal: 0, correctTotal: 0, blocked: [], summary: null,
});

/**
 * Terminal / deliberate states this must never touch. `waived` covers both a
 * staff waive and the auto-cover-from-account marker; `not_required` is the
 * state we ourselves assign to a covered driver, so it IS in the candidate set
 * (it must be promotable) but is excluded from the "has money" test by virtue
 * of being £0.
 */
const UNTOUCHABLE = ['reimbursed', 'fully_claimed', 'rolled_over', 'waived', 'released'];

/**
 * Hire is over — do not reshuffle it. Mirrors the dispatch gate's lifecycle cut.
 *
 * A finished hire's excess is history: whatever was collected has been
 * reimbursed, claimed or rolled forward, and moving the charge between drivers
 * achieves nothing except retrospectively inflating "required" on a settled
 * job. `dispatched` is deliberately NOT here — a mid-tour driver joining a live
 * hire still needs ranking.
 */
const FINISHED_PIPELINE = ['returned_incomplete', 'returned', 'completed', 'cancelled', 'lost'];

interface Candidate {
  id: string;
  status: string;
  required: number;
  liability: number;
  /** max(liability, stored required) — see the note where this is computed. */
  effective: number;
  driverName: string | null;
  frozen: boolean;
  /** False for a cancelled/swapped assignment: can never win a slot, and is
   *  demoted out of one if it money-free-ly holds it. */
  eligible: boolean;
  /** Terminal/deliberate state (UNTOUCHABLE). Never modified, but OCCUPIES a
   *  slot — see the slot-accounting note below. */
  terminal: boolean;
}

/**
 * @param opts.dryRun compute the result without writing. Used by the Money tab
 *   (a GET must never write) and by the sweep script's dry run. Read-only by
 *   construction rather than by BEGIN/ROLLBACK — a rollback would still need a
 *   dedicated pool connection per page load, and this pool has been saturated
 *   before.
 */
export async function reconcileJobExcessTopN(
  q: Querier,
  jobId: string,
  opts?: { dryRun?: boolean },
): Promise<TopNReconcileResult> {
  const dryRun = opts?.dryRun === true;
  // Internal jobs deliberately record every driver as not_required £0 — there
  // is nothing chargeable, so promoting one would invent a charge. Van & Driver
  // suspension and auto-cover both land records in `waived`, which the
  // UNTOUCHABLE filter below already excludes.
  const jobRow = await q(
    `SELECT COALESCE(is_internal, false) AS is_internal,
            pipeline_status,
            COALESCE((hh_derived_flags->>'self_drive_count')::int, 0) AS self_drive_count
       FROM jobs WHERE id = $1`,
    [jobId],
  );
  if (jobRow.rows.length === 0) return EMPTY();
  if (jobRow.rows[0].is_internal === true) return EMPTY();
  if (FINISHED_PIPELINE.includes(String(jobRow.rows[0].pipeline_status || ''))) return EMPTY();

  const vanCount = Math.max(Number(jobRow.rows[0].self_drive_count) || 1, 1);

  // Candidate set: EVERY driver-linked record on the job. Nothing is filtered
  // out of the query — records we must not modify are flagged instead, because
  // a record's slot matters even when its contents are untouchable.
  //
  // ⚠️ TERMINAL RECORDS OCCUPY SLOTS. Filtering them out of the query (the
  // first cut of this function) made the slot they hold look EMPTY, so a
  // covered sibling was promoted into it. Job 15777 (Florrie Arnold): one van,
  // Cameron's £1,200 collected and reimbursed, Robbie covered at £0 — the
  // reconcile could not see Cameron, so it "fixed" the hire by charging Robbie
  // £1,200 on a settled job. It reported 71 such jobs, every one a false
  // positive; the tell was that every line promoted to exactly the £1,200
  // floor, when the whole premise of a genuine fix is a HIGHER driver having
  // been passed over. A waive, a reimbursement, a claim and a rollover are all
  // statements that this hire's excess has been dealt with.
  //
  // Cancelled/swapped assignments are likewise INCLUDED but marked ineligible.
  // Filtering them would leave a removed driver's stale chargeable record
  // standing while a live driver was promoted alongside it — £3,000 of
  // "required" on a one-van hire. A money-free ineligible record is demoted;
  // one holding money stays frozen, because the cash still has to be reimbursed
  // or claimed whatever happened to the driver.
  const rows = await q(
    `SELECT je.id,
            je.excess_status                              AS status,
            COALESCE(je.excess_amount_required, 0)::float AS required,
            GREATEST(COALESCE(d.calculated_excess_amount, $2), $2)::float AS liability,
            d.full_name                                   AS driver_name,
            (vha.status NOT IN ('cancelled', 'swapped'))  AS eligible,
            (je.excess_status = ANY($3::text[]))          AS terminal,
            (
              COALESCE(je.excess_amount_taken, 0) > 0
              OR COALESCE(je.amount_held, 0) > 0
              OR COALESCE(je.claim_amount, 0) > 0
              OR COALESCE(je.reimbursement_amount, 0) > 0
              OR je.hh_deposit_id IS NOT NULL
              OR je.stripe_payment_intent_id IS NOT NULL
            )                                             AS frozen
       FROM job_excess je
       JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
       LEFT JOIN drivers d ON d.id = vha.driver_id
      WHERE je.job_id = $1
        AND je.assignment_id IS NOT NULL
      ORDER BY je.created_at ASC`,
    [jobId, STANDARD_EXCESS_PER_DRIVER, UNTOUCHABLE],
  );

  const candidates: Candidate[] = rows.rows.map((r: any) => ({
    id: r.id,
    status: r.status,
    required: Number(r.required) || 0,
    liability: Number(r.liability) || STANDARD_EXCESS_PER_DRIVER,
    driverName: r.driver_name || null,
    frozen: r.frozen === true,
    eligible: r.eligible === true,
    terminal: r.terminal === true,
    /*
     * ⚠️ NEVER LOWER A DELIBERATELY-SET AMOUNT.
     *
     * `drivers.calculated_excess_amount` is the driver's standing liability,
     * but a hire's record can legitimately be priced ABOVE it — an insurer
     * surcharge written by referral resolution (`routes/drivers.ts`
     * resolve-referral `adjusted_excess`), or a staff edit through
     * `PUT /excess/:id`. NEITHER of those touches the driver column, and they
     * shouldn't: an insurer's surcharge for one hire is not that person's
     * permanent liability. The two are separate on purpose.
     *
     * So the reconcile ranks and prices on the GREATER of the two. Without
     * this it re-priced an £1,800 insurer-imposed excess back down to the
     * £1,200 floor the moment a second driver joined the hire — silently
     * undoing the insurer's decision on money not yet collected (so the money
     * guard, which only protects records that already hold cash, didn't catch
     * it either). Raising to the driver's liability is a correction; lowering
     * below a figure a human set is not.
     */
    effective: Math.max(
      Number(r.liability) || STANDARD_EXCESS_PER_DRIVER,
      Number(r.required) || 0,
    ),
  }));
  if (candidates.length === 0) return EMPTY(vanCount);

  /*
   * SLOT ACCOUNTING. There are `vanCount` chargeable slots on the hire. Two
   * kinds of record hold one immovably:
   *
   *   • terminal — waived / reimbursed / claimed / rolled over / released.
   *     The hire's excess for that slot has been dealt with, one way or
   *     another. We never modify these, and crucially they still COUNT.
   *   • frozen   — holds money, a HireHop deposit, a Stripe PI or a rollover
   *     chain. Can't be demoted (the money would be stranded) and can't be
   *     re-priced (that's a money decision, not a reconciliation).
   *
   * Reserve those slots first; only what's left is filled from the ranking.
   */
  const occupants = candidates.filter(
    (c) => c.terminal || (c.frozen && c.status !== 'not_required'),
  );
  const occupantIds = new Set(occupants.map((o) => o.id));
  const slotsLeft = Math.max(vanCount - occupants.length, 0);

  // Rank by liability DESC. `rows` is already ordered by created_at ASC and
  // Array.prototype.sort is stable, so equal liabilities keep arrival order —
  // the incumbent holds the slot and repeated runs don't churn.
  const promotable = candidates
    .filter((c) => c.eligible && !occupantIds.has(c.id))
    .sort((a, b) => b.effective - a.effective);
  const winners = promotable.slice(0, slotsLeft);
  const winnerIds = new Set(winners.map((w) => w.id));

  // What the hire SHOULD total: the immovable slots at their stored amounts,
  // plus the best of the rest.
  const correctTotal =
    occupants.reduce((sum, o) => sum + o.required, 0) +
    winners.reduce((sum, w) => sum + w.effective, 0);

  const blocked: TopNBlockedSlot[] = [];
  // Only a MONEY-frozen occupant produces a warning. A terminal one is a
  // deliberate decision (a staff waive, a settled reimbursement) — flagging
  // "under-collected" against it would be nagging about a closed question.
  const moneyOccupants = occupants.filter((o) => !o.terminal);
  if (moneyOccupants.length > 0) {
    const lowestFrozen = Math.min(...moneyOccupants.map((f) => f.effective));
    for (const c of promotable) {
      if (winnerIds.has(c.id)) continue;
      if (c.effective > lowestFrozen) {
        blocked.push({ driverName: c.driverName, shouldBe: c.effective, reason: 'frozen_incumbent' });
      }
    }
  }

  const changes: string[] = [];
  let chargeableTotal = 0;

  for (const c of candidates) {
    if (c.terminal) {
      // Untouched, but its money still counts toward the hire's total.
      chargeableTotal += c.required;
      continue;
    }
    const isFrozen = c.frozen && c.status !== 'not_required';
    const shouldCharge = isFrozen || winnerIds.has(c.id);

    if (shouldCharge) {
      // Frozen records keep their stored amount untouched — re-pricing a record
      // that already holds cash is a money decision, not a reconciliation.
      const target = isFrozen ? c.required : c.effective;
      chargeableTotal += target;
      const needsStatus = c.status === 'not_required';
      const needsAmount = !isFrozen && Math.abs(c.required - target) > 0.005;
      if (needsStatus || needsAmount) {
        if (!dryRun) await q(
          `UPDATE job_excess
              SET excess_amount_required = $2,
                  excess_status = CASE WHEN excess_status = 'not_required' THEN 'pending' ELSE excess_status END,
                  excess_calculation_basis = $3,
                  updated_at = NOW()
            WHERE id = $1`,
          [c.id, target, `Top-N recompute: £${target.toLocaleString()} (driver liability, ${vanCount}-van hire)`],
        );
        changes.push(`${c.driverName || c.id}: charge £${target}`);
      }
    } else {
      if (c.status !== 'not_required' || Math.abs(c.required) > 0.005) {
        // Never demote a record holding money — the guard above should have
        // kept it chargeable, so this is belt and braces.
        if (c.frozen) continue;
        if (!dryRun) await q(
          `UPDATE job_excess
              SET excess_amount_required = 0,
                  excess_status = 'not_required',
                  excess_calculation_basis = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [c.id, `Covered by another driver's excess on this ${vanCount}-van hire (top-N recompute)`],
        );
        changes.push(`${c.driverName || c.id}: covered`);
      }
    }
  }

  return {
    changed: changes.length > 0,
    vanCount,
    chargeableTotal,
    correctTotal,
    blocked,
    summary: changes.length > 0 ? changes.join('; ') : null,
  };
}
