/**
 * COT receipt chaser — runs WEEKLY from config/scheduler.ts (Wed 12:00 London).
 *
 * Company-card (COT) purchases are already in Xero via the bank feed, so the
 * one thing OP needs from staff is the RECEIPT. Without it the bookkeeper chases
 * months later. This sends ONE weekly digest per card-holder summarising their
 * own cot_card costs (older than GRACE_DAYS) that still have no receipt attached,
 * deep-linked to their missing-receipt list. A cost drops out the moment a
 * receipt lands (receipt_r2_key set). The weekly cadence is the throttle — no
 * per-cost dedup needed; receipt_chase_sent_at is stamped only as a "last
 * chased" record.
 *
 * Looks at ALL outstanding costs (it backfills) — but because it's a single
 * weekly digest, a bigger backlog just means a higher count, never more emails.
 *
 * OP-side only (no Xero read) — chases what staff logged in OP. Purchases never
 * logged at all are caught later by the Xero-matched reconciliation (future).
 */
import { query } from '../config/database';
import { getFrontendUrl } from '../config/app-urls';

const GRACE_DAYS = 3;    // give staff a few days to attach the receipt before the weekly digest picks it up

interface ChaseResult { holdersNudged: number; costsChased: number; }

export async function runCostReceiptChase(): Promise<ChaseResult> {
  const result: ChaseResult = { holdersNudged: 0, costsChased: 0 };

  // One row per card-holder with their outstanding count + the cost ids to stamp.
  // No per-cost dedup — the once-a-week schedule is the throttle.
  const due = await query(
    `SELECT c.uploaded_by AS user_id,
            COUNT(*)::int  AS n,
            ARRAY_AGG(c.id) AS cost_ids
       FROM costs c
      WHERE c.payment_method = 'cot_card'
        AND c.receipt_r2_key IS NULL
        AND c.uploaded_by IS NOT NULL
        AND c.cost_date <= (CURRENT_DATE - ($1 || ' days')::interval)
      GROUP BY c.uploaded_by`,
    [String(GRACE_DAYS)]
  );

  const actionUrl = `${getFrontendUrl()}/my-receipts`;

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
