/**
 * excess-refund.ts — unwind a refund event onto an OP excess record.
 *
 * One refund can arrive on OP via three paths and the OP-side state change has
 * to be the same on each:
 *   1. `payment-event` from the Payment Portal with `payment_type='refund'`
 *      or `'excess_refund'` (after the portal does a Stripe refund itself).
 *   2. `charge.refunded` from the Stripe webhook (refund issued directly in the
 *      Stripe dashboard, no portal involvement).
 *   3. Money-tab passive reconciliation when a refund has been processed on
 *      HireHop directly (see `services/excess-hh-reconcile.ts`).
 *
 * This helper is the single place state flips. Idempotent: each refund leg
 * is identified by `(source, sourceRef)`; replaying the same leg is a no-op.
 *
 * The behaviour mirrors the existing `/excess/:id/reimburse` endpoint's state
 * machine (partial-vs-full status, claim-aware), so OP's auto-reconciled
 * records look identical to staff-driven ones.
 */
import { query } from '../config/database';
import { syncExcessRequirementStatus } from './excess-requirement-sync';

export type RefundSource = 'stripe_webhook' | 'payment_event' | 'hh_reconcile' | 'manual';

export interface UnwindRefundInput {
  excessId: string;
  amount: number;             // gross refund amount (positive)
  source: RefundSource;
  /**
   * Stable per-leg identifier (Stripe refund id, HH payment-application id,
   * portal job_payments row id, etc.). Used for idempotency — repeated calls
   * with the same (source, sourceRef) are no-ops. Optional; if omitted, callers
   * are responsible for their own idempotency (e.g. webhook dedup).
   */
  sourceRef?: string | null;
  method?: string | null;       // reimburse_method on the record
  notes?: string | null;        // appended to record's notes
}

export interface UnwindRefundResult {
  /** True if the record was updated by this call. */
  updated: boolean;
  /** Status the record now sits at. */
  newStatus: string;
  /** Reason for skip if updated=false. */
  reason?: string;
}

/**
 * Apply a refund leg to an excess record. Safe to call multiple times — if
 * the leg has already been recorded (matching (source, sourceRef)), or the
 * record is in a terminal state where this refund makes no sense, returns
 * `{ updated: false, reason: ... }`.
 */
export async function unwindRefundOnExcess(input: UnwindRefundInput): Promise<UnwindRefundResult> {
  const { excessId, amount, source, sourceRef, method, notes } = input;
  if (amount <= 0) {
    return { updated: false, newStatus: '', reason: 'non-positive amount' };
  }

  const cur = await query(
    `SELECT excess_status, excess_amount_taken, reimbursement_amount, claim_amount,
            amount_held, refund_legs, notes AS prev_notes, job_id
     FROM job_excess WHERE id = $1`,
    [excessId]
  );
  if (cur.rows.length === 0) {
    return { updated: false, newStatus: '', reason: 'excess not found' };
  }
  const row = cur.rows[0];

  // Idempotency check — refund_legs is a JSONB array of {source, ref, amount, at}.
  // If this (source, sourceRef) has already been recorded, skip silently.
  const legs: Array<{ source: string; ref: string | null; amount: number }> =
    Array.isArray(row.refund_legs) ? row.refund_legs : [];
  if (sourceRef && legs.some((l) => l.source === source && l.ref === sourceRef)) {
    return { updated: false, newStatus: row.excess_status, reason: 'duplicate leg (idempotent skip)' };
  }

  const status = row.excess_status as string;

  // Terminal-resolved states: nothing to do. The refund either pre-dated our
  // tracking or was already accounted for in a different way.
  if (['waived', 'rolled_over', 'released'].includes(status)) {
    return { updated: false, newStatus: status, reason: `record already ${status}` };
  }
  if (status === 'reimbursed') {
    // Already fully reimbursed — append the leg for audit but don't double-act.
    await appendRefundLeg(excessId, { source, ref: sourceRef || null, amount, at: new Date().toISOString() }, row.prev_notes, notes);
    return { updated: false, newStatus: status, reason: 'record already reimbursed (leg logged)' };
  }

  // Pre-auth case: a refund on a held authorisation means it was voided. The
  // proper signal for this is `payment_intent.canceled` (handled by the
  // stripe-webhook → markExcessReleased path). If we somehow get a refund event
  // on a pre_auth record, fall through to leg-log without state change — the
  // canceled webhook will arrive in parallel and do the right thing.
  if (status === 'pre_auth') {
    await appendRefundLeg(excessId, { source, ref: sourceRef || null, amount, at: new Date().toISOString() }, row.prev_notes, notes);
    return { updated: false, newStatus: status, reason: 'pre_auth — waiting for payment_intent.canceled' };
  }

  // `needed` / `not_required` / `pending` — refund landed on a record with no
  // money taken. Log + skip — likely an orphan event or staff resolving a
  // separate flow.
  if (['needed', 'not_required', 'pending'].includes(status)) {
    await appendRefundLeg(excessId, { source, ref: sourceRef || null, amount, at: new Date().toISOString() }, row.prev_notes, notes);
    return { updated: false, newStatus: status, reason: `record is ${status}; nothing to unwind` };
  }

  // Active money cases: taken / partially_paid / partially_reimbursed / fully_claimed.
  // Increment reimbursement_amount; partial-vs-full uses the same predicate as
  // the /reimburse endpoint so OP-driven and auto-reconciled records end up
  // in the same state shape.
  const amountTaken = parseFloat(row.excess_amount_taken || '0');
  const alreadyReimbursed = parseFloat(row.reimbursement_amount || '0');
  const claimed = parseFloat(row.claim_amount || '0');
  const remaining = amountTaken - alreadyReimbursed - claimed;
  // Allow a small over-shoot — Stripe rounding sometimes lands a few pence
  // above the OP-side taken figure on jobs that split fees by VAT.
  const cappedAmount = Math.min(amount, Math.max(remaining, 0));
  if (cappedAmount <= 0.005) {
    await appendRefundLeg(excessId, { source, ref: sourceRef || null, amount, at: new Date().toISOString() }, row.prev_notes, notes);
    return { updated: false, newStatus: status, reason: 'no remaining balance to refund' };
  }
  const isPartial = (alreadyReimbursed + cappedAmount + claimed) < amountTaken - 0.005;
  const newStatus = isPartial ? 'partially_reimbursed' : 'reimbursed';

  const dateStr = new Date().toISOString().split('T')[0];
  const sourceLabel = SOURCE_LABEL[source] || source;
  const noteLine = `[${dateStr}] Refund auto-reconciled — ${sourceLabel}: £${cappedAmount.toFixed(2)}${sourceRef ? ` (${sourceRef})` : ''}${notes ? ` — ${notes}` : ''}.`;
  const newNotes = row.prev_notes ? `${row.prev_notes}\n${noteLine}` : noteLine;

  const newLeg = { source, ref: sourceRef || null, amount: cappedAmount, at: new Date().toISOString() };
  const newLegs = [...legs, newLeg];

  await query(
    `UPDATE job_excess SET
      excess_status = $1,
      reimbursement_amount = COALESCE(reimbursement_amount, 0) + $2,
      reimbursement_date = COALESCE(reimbursement_date, NOW()),
      reimbursement_method = COALESCE(reimbursement_method, $3),
      refund_legs = $4::jsonb,
      notes = $5,
      updated_at = NOW()
     WHERE id = $6`,
    [newStatus, cappedAmount, method || null, JSON.stringify(newLegs), newNotes, excessId]
  );

  // Re-derive the close-out requirement state.
  if (row.job_id) {
    syncExcessRequirementStatus(row.job_id).catch((e) =>
      console.error('[excess-refund] syncExcessRequirementStatus failed:', e)
    );
  }

  console.log(`[excess-refund] Unwound £${cappedAmount.toFixed(2)} on excess ${excessId} via ${source}${sourceRef ? `(${sourceRef})` : ''} → ${newStatus}`);
  return { updated: true, newStatus };
}

const SOURCE_LABEL: Record<RefundSource, string> = {
  stripe_webhook: 'Stripe webhook',
  payment_event: 'payment portal',
  hh_reconcile: 'HireHop reconciliation',
  manual: 'manual',
};

async function appendRefundLeg(
  excessId: string,
  leg: { source: string; ref: string | null; amount: number; at: string },
  prevNotes: string | null,
  noteAddendum: string | null | undefined
): Promise<void> {
  const cur = await query(`SELECT refund_legs FROM job_excess WHERE id = $1`, [excessId]);
  const legs: typeof leg[] = Array.isArray(cur.rows[0]?.refund_legs) ? cur.rows[0].refund_legs : [];
  legs.push(leg);
  const noteLine = `[${leg.at.split('T')[0]}] Refund leg logged — ${leg.source}: £${leg.amount.toFixed(2)}${leg.ref ? ` (${leg.ref})` : ''}${noteAddendum ? ` — ${noteAddendum}` : ''} (no state change).`;
  const newNotes = prevNotes ? `${prevNotes}\n${noteLine}` : noteLine;
  await query(
    `UPDATE job_excess SET refund_legs = $1::jsonb, notes = $2, updated_at = NOW() WHERE id = $3`,
    [JSON.stringify(legs), newNotes, excessId]
  );
}

/**
 * Find an excess record by Stripe PaymentIntent id. Used by the Stripe webhook
 * (charge.refunded) to locate the OP record for a refund leg.
 */
export async function findExcessByStripePI(piId: string): Promise<{ id: string; job_id: string | null } | null> {
  if (!piId) return null;
  const r = await query(
    `SELECT id, job_id FROM job_excess
     WHERE stripe_payment_intent_id = $1
     ORDER BY updated_at DESC LIMIT 1`,
    [piId]
  );
  return r.rows[0] || null;
}

/**
 * Find an excess record by HireHop deposit id. Used by HH passive
 * reconciliation when a refund-application is detected against a linked
 * deposit.
 */
export async function findExcessByHhDeposit(hhDepositId: number): Promise<{ id: string; job_id: string | null } | null> {
  if (!hhDepositId) return null;
  const r = await query(
    `SELECT id, job_id FROM job_excess WHERE hh_deposit_id = $1 LIMIT 1`,
    [hhDepositId]
  );
  return r.rows[0] || null;
}
