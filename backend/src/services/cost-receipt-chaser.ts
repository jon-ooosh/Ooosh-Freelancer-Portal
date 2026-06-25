/**
 * COT receipt chaser — runs daily from config/scheduler.ts.
 *
 * Company-card (COT) purchases are already in Xero via the bank feed, so the
 * one thing OP needs from staff is the RECEIPT. Without it the bookkeeper chases
 * months later. This nudges the card-holder within days instead: any cot_card
 * cost older than GRACE_DAYS with no receipt attached gets a single inbox
 * notification to whoever logged it, deep-linked to their own missing-receipt
 * list. Per-cost dedup via receipt_chase_sent_at — re-fires only after
 * RECHASE_DAYS so it's a reminder, not daily spam. A cost drops out the moment a
 * receipt lands (receipt_r2_key set).
 *
 * OP-side only (no Xero read) — chases what staff logged in OP. Purchases never
 * logged at all are caught later by the Xero-matched reconciliation (future).
 */
import { query } from '../config/database';
import { getFrontendUrl } from '../config/app-urls';

const GRACE_DAYS = 3;    // give staff a few days to attach the receipt
const RECHASE_DAYS = 7;  // re-nudge weekly until the receipt lands

interface ChaseResult { holdersNudged: number; costsChased: number; }

export async function runCostReceiptChase(): Promise<ChaseResult> {
  const result: ChaseResult = { holdersNudged: 0, costsChased: 0 };

  // One row per card-holder with their outstanding count + the cost ids to stamp.
  const due = await query(
    `SELECT c.uploaded_by AS user_id,
            COUNT(*)::int  AS n,
            ARRAY_AGG(c.id) AS cost_ids
       FROM costs c
      WHERE c.payment_method = 'cot_card'
        AND c.receipt_r2_key IS NULL
        AND c.uploaded_by IS NOT NULL
        AND c.cost_date <= (CURRENT_DATE - ($1 || ' days')::interval)
        AND (c.receipt_chase_sent_at IS NULL
             OR c.receipt_chase_sent_at < NOW() - ($2 || ' days')::interval)
      GROUP BY c.uploaded_by`,
    [String(GRACE_DAYS), String(RECHASE_DAYS)]
  );

  const actionUrl = `${getFrontendUrl()}/money/costs?missing_receipt=1&mine=1`;

  for (const row of due.rows as Array<{ user_id: string; n: number; cost_ids: string[] }>) {
    const n = row.n;
    const title = `${n} company-card ${n === 1 ? 'purchase needs' : 'purchases need'} a receipt`;
    const content = `You have ${n} company-card (COT) ${n === 1 ? 'cost' : 'costs'} with no receipt attached. `
      + `Please upload the ${n === 1 ? 'receipt' : 'receipts'} so the purchase can be reconciled in Xero.`;

    await query(
      `INSERT INTO notifications (user_id, type, title, content, entity_type, action_url, priority)
       VALUES ($1, 'follow_up', $2, $3, 'costs', $4, 'normal')`,
      [row.user_id, title, content, actionUrl]
    );

    await query(
      `UPDATE costs SET receipt_chase_sent_at = NOW() WHERE id = ANY($1::uuid[])`,
      [row.cost_ids]
    );

    result.holdersNudged += 1;
    result.costsChased += n;
  }

  return result;
}
