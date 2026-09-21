/**
 * Credits — money coming BACK from a supplier.
 *
 * We bought the wrong screws, returned them, Screwfix refunded the card. The
 * purchase and the refund are two real events, so OP holds two rows: the
 * original is never edited, and the credit is an ordinary cost row that is
 * NEGATIVE and knows its parent. Every existing `SUM(amount_gross)` then nets
 * to the true cost without being taught anything.
 *
 * THE SIGN RULE, and the reason this file exists: **a credit is entered as
 * positive money and stored negative.** `applyCreditSign()` is the only place
 * that flips it. Callers — the capture modal, the Record-refund modal, a future
 * import — all send plain positive amounts, so none of them can put a positive
 * credit or a negative purchase in the table by getting a minus sign wrong.
 *
 * The other job here is INHERITANCE. A credit only nets correctly if it carries
 * the same facets as the purchase: same job, same vehicle, same account code,
 * same cost type. Book the refund of a van part as a generic overhead and the
 * van stays overspent forever with nothing to flag it. So the facets are copied
 * from the parent for anything the caller didn't explicitly set, rather than
 * being re-picked by whoever is doing the capture.
 *
 * Deliberately NOT here:
 *   - Reducing a recharge. If the purchase was recharged to a client, the HH
 *     item has to be edited down by a human (HireHop silently clamps a negative
 *     to zero — see .claude/rules/money-excess.md), so we warn and stop.
 *   - Re-splitting across the parent's allocations. Same reasoning: warn, and
 *     let someone who can see the whole picture decide.
 */
import { query } from '../config/database';

/** Money fields that flip sign on a credit. */
const SIGNED_FIELDS = ['amount_gross', 'amount_vat', 'amount_net', 'recharge_amount'] as const;

export interface CreditParent {
  id: string;
  is_credit: boolean;
  amount_gross: string | number | null;
  supplier_name: string | null;
  recharge_mode: string | null;
  job_id: string | null;
  hh_job_number?: number | null;
}

export interface CreditPrep {
  /** Staff-readable refusals. When set, nothing should be written. */
  error?: string;
  /** Things a human has to go and do elsewhere. Never blocking. */
  warnings: string[];
  parent?: CreditParent;
}

const pence = (v: unknown) => Math.round((Number(v) || 0) * 100);

/**
 * Force the stored sign to match what the row IS.
 *
 * Credits store negative money, purchases store positive. Applied on every
 * write path (create, update, and the refund helper), so the table can't hold a
 * positive credit however the payload arrived. A missing/zero field is left
 * alone — `-0` is not a value anyone wants to read back.
 */
export function applyCreditSign(data: Record<string, unknown>, isCredit: boolean): void {
  for (const f of SIGNED_FIELDS) {
    const raw = data[f];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n === 0) continue;
    data[f] = isCredit ? -Math.abs(n) : Math.abs(n);
  }
}

/** Facets a credit inherits from its purchase, unless the caller set them. */
const INHERITED = [
  'supplier_name', 'xero_contact_id', 'currency', 'vat_treatment',
  'payment_method', 'cot_card_holder', 'cot_card_last4',
  'xero_account_code', 'category', 'cost_type',
  'job_id', 'vehicle_id', 'quote_assignment_id', 'platform_issue_id',
  'vehicle_service_log_id', 'vehicle_fuel_log_id',
] as const;

/**
 * How much of a purchase has NOT been refunded yet, in pounds.
 *
 * Existing credits count against it, so two £6 refunds of a £12.60 purchase are
 * fine and a third is not.
 */
export async function remainingRefundable(parentId: string): Promise<{ gross: number; refunded: number; remaining: number } | null> {
  const r = await query(
    `SELECT c.amount_gross,
            COALESCE((SELECT SUM(ABS(k.amount_gross)) FROM costs k
                       WHERE k.refund_of_cost_id = c.id AND k.is_credit), 0) AS refunded
       FROM costs c WHERE c.id = $1`,
    [parentId],
  );
  if (!r.rows.length) return null;
  const gross = Math.abs(Number(r.rows[0].amount_gross) || 0);
  const refunded = Number(r.rows[0].refunded) || 0;
  return { gross, refunded, remaining: Math.round((gross - refunded) * 100) / 100 };
}

/**
 * Validate a credit against its purchase and inherit the purchase's facets.
 *
 * `data` is mutated in place — it is the payload on its way to the INSERT.
 * Amounts are read as magnitudes here (the caller sends positive); the sign is
 * applied afterwards by `applyCreditSign`.
 */
export async function prepareCreditFromParent(
  parentId: string,
  data: Record<string, unknown>,
): Promise<CreditPrep> {
  const p = await query(
    `SELECT c.id, c.is_credit, c.amount_gross, c.supplier_name, c.recharge_mode, c.job_id,
            c.xero_contact_id, c.currency, c.vat_treatment, c.payment_method,
            c.cot_card_holder, c.cot_card_last4, c.xero_account_code, c.category, c.cost_type,
            c.vehicle_id, c.quote_assignment_id, c.platform_issue_id,
            c.vehicle_service_log_id, c.vehicle_fuel_log_id,
            j.hh_job_number,
            (SELECT COUNT(*)::int FROM cost_allocations a WHERE a.cost_id = c.id) AS allocation_count
       FROM costs c
       LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.id = $1`,
    [parentId],
  );
  if (!p.rows.length) return { error: 'That purchase no longer exists — refresh and try again.', warnings: [] };
  const parent = p.rows[0];

  // A credit of a credit is money going out again, which is a purchase. Saying
  // no here is cheaper than working out what the chain means later.
  if (parent.is_credit) {
    return { error: 'That row is already a credit — you can\'t refund a refund.', warnings: [] };
  }

  const amount = Math.abs(Number(data.amount_gross) || 0);
  if (amount <= 0) return { error: 'Enter the amount that came back.', warnings: [] };

  const balance = await remainingRefundable(parentId);
  if (balance && pence(amount) > pence(balance.remaining)) {
    return {
      error: balance.refunded > 0
        ? `That's more than is left to refund. This purchase was £${balance.gross.toFixed(2)}, `
          + `£${balance.refunded.toFixed(2)} has already come back, so £${balance.remaining.toFixed(2)} is outstanding.`
        : `That's more than the purchase itself (£${balance.gross.toFixed(2)}). Check the amount, `
          + 'or record it as a separate cost if it isn\'t a refund of this one.',
      warnings: [],
    };
  }

  for (const f of INHERITED) {
    if (data[f] === undefined && parent[f] !== undefined) data[f] = parent[f];
  }
  // A credit is money coming in — it is never itself something to recharge, and
  // never something to approve or pay. (Inheriting recharge_mode would put a
  // refund on the Recharges tab asking to be billed to a client.)
  data.recharge_mode = 'none';
  data.recharge_amount = null;
  data.payment_status = 'paid';

  const warnings: string[] = [];
  if (parent.recharge_mode && parent.recharge_mode !== 'none') {
    warnings.push(
      `This purchase was recharged to the client${parent.hh_job_number ? ` on job #${parent.hh_job_number}` : ''}. `
      + 'OP has NOT changed that — reduce the item in HireHop yourself.',
    );
  }
  if (Number(parent.allocation_count) > 0) {
    warnings.push(
      `This purchase is split across ${parent.allocation_count} job${Number(parent.allocation_count) === 1 ? '' : 's'}. `
      + 'The credit lands on the capture job only — split it yourself if it needs to follow the original.',
    );
  }

  return { warnings, parent };
}

/**
 * Bell the admins when a credit lands on something OP can't tidy up by itself.
 *
 * The warnings are shown to whoever recorded it, but that person is often not
 * the person who invoices the client — and "I saw a yellow box once" is not a
 * record. Non-fatal: a missing bell must never fail the credit.
 */
export async function notifyCreditNeedsFollowUp(
  creditId: string,
  supplierName: string | null,
  amount: number,
  warnings: string[],
): Promise<void> {
  if (!warnings.length) return;
  try {
    const admins = await query(`SELECT id FROM users WHERE role IN ('admin', 'manager') AND is_active = true`);
    const title = `Refund recorded on a recharged/split cost — needs a manual tidy-up`;
    const content = `A credit of £${Math.abs(amount).toFixed(2)}`
      + `${supplierName ? ` from ${supplierName}` : ''} was recorded in OP. ${warnings.join(' ')}`;
    for (const a of admins.rows as Array<{ id: string }>) {
      await query(
        `INSERT INTO notifications (user_id, type, title, content, entity_type, entity_id, action_url, priority)
         VALUES ($1, 'follow_up', $2, $3, 'cost', $4, $5, 'normal')`,
        [a.id, title, content, creditId, `/money/costs?cost=${creditId}`],
      );
    }
  } catch (err) {
    console.error('[cost-credit] follow-up bell failed (non-fatal):', err instanceof Error ? err.message : err);
  }
}
