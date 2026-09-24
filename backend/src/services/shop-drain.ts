/**
 * shop-drain.ts — sends queued shop transactions to HireHop.
 *
 * Step 5 of `docs/SHOP-SALES-SPEC.md`. THIS SLICE HANDLES CONSUMPTION ONLY
 * ("used for Ooosh"). Sales — job lines plus a deposit — are step 6.
 *
 * Why a deferred worker rather than pushing inline (§7):
 *   - The counter never waits on HireHop. A 327 storm must not stop you selling
 *     a Coke.
 *   - Retries come free, at 'low' broker priority so shop traffic yields to
 *     anything user-facing.
 *   - It creates Window A (§8): inside the hold nothing has reached HireHop, so
 *     a cancel is a true undo rather than a refund.
 *
 * ⚠️ TWO RULES THIS FILE EXISTS TO ENFORCE
 *
 * 1. `success: true` does NOT mean HireHop did it (§2.5). Verified live:
 *    `save_job.php` accepted a delete instruction, returned success, and
 *    changed nothing. So every push is judged on the OBJECT HireHop returns,
 *    never on the status flag.
 *
 * 2. A stock movement is EITHER a job line OR a tally adjustment, never both —
 *    the double-decrement trap (§2). Consumption takes the tally path and must
 *    never also land on a job.
 */
import { query } from '../config/database';
import hhBroker from './hirehop-broker';
import { hhLocalNow } from './shop-stock';
import { getOrCreateShopPeriod } from './shop-period';
import { pushDepositToHH } from './hh-deposit';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_ATTEMPTS_KEY = 'shop_push_max_attempts';
const DEFAULT_MAX_ATTEMPTS = 5;

/** How many transactions one drain pass will handle. */
const BATCH_SIZE = 20;

export interface DrainResult {
  considered: number;
  pushed: number;
  failed: number;
  errors: string[];
}

async function getMaxAttempts(): Promise<number> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [MAX_ATTEMPTS_KEY]);
    const n = Number(r.rows[0]?.value);
    if (Number.isFinite(n) && n >= 1 && n <= 50) return n;
  } catch {
    // fall through to the default
  }
  return DEFAULT_MAX_ATTEMPTS;
}

/**
 * Record one line's consumption as a HireHop stock adjustment.
 *
 * ⚠️ THE PARAMETER NAMES BELOW ARE CAPTURED FROM HIREHOP'S OWN UI, AND THEY DO
 * NOT MATCH HIREHOP'S API DOCUMENTATION. The docs describe `cons`, `id`, `qty`
 * and `details`; the endpoint actually wants `CONSUMABLE_ID`, `ID`, `QTY`,
 * `DETAILS` — uppercase — plus `local`, `tz` and `CUSTOM_FIELDS`, none of which
 * the docs mention as required. Sending the documented shape returns error 3.
 * That cost a live round; `items_delete.php` differed from its docs the same
 * way. Capture the payload, never trust the docs. See SHOP-SALES-SPEC.md §2.9.
 *
 * Verified Sep 2026: a NEGATIVE `QTY` consumes and a positive one restores, and
 * each adjustment comes back with its own editable `ID`.
 *
 * Returns the adjustment id, or null with a reason.
 *
 * Exported for its own tests: the response-validation rules below are the §2.5
 * lesson in code, and they deserve pinning independently of the drain loop.
 */
export async function pushTally(
  stockId: number,
  qty: number,
  details: string,
): Promise<{ tallyId: number | null; error: string | null }> {
  const payload = {
    ID: 0,                      // 0 = create; a real id would EDIT an adjustment
    CONSUMABLE_ID: stockId,     // NOT `cons`, whatever the docs say
    QTY: -Math.abs(qty),        // negative consumes. Never trust a caller's sign.
    DETAILS: details.slice(0, 250),
    CUSTOM_FIELDS: '{}',
    local: hhLocalNow(),
    tz: 'Europe/London',
  };

  const res = await hhBroker.post<any>('/modules/consumables/tally_save.php', payload, { priority: 'low' });

  if (!res?.success) {
    console.error('[shop-drain] tally_save rejected. sent=%j reply=%j', payload, res);
    // Store the whole reply on the row, not just the code. "3" on its own told
    // us nothing, and by the time anyone looked the journal had rotated past it.
    const detail = JSON.stringify({ error: res?.error ?? null, data: res?.data ?? null }).slice(0, 400);
    return { tallyId: null, error: `HireHop rejected tally_save — ${detail}` };
  }

  // Judge the RESULT, not the flag (§2.5). HireHop returns the created
  // adjustment itself, so we can check it is real and says what we asked for.
  const data: any = res.data;
  const tallyId = Number(data?.ID);
  if (!Number.isFinite(tallyId) || tallyId <= 0) {
    console.error('[shop-drain] tally_save returned no id. reply=%j', data);
    return { tallyId: null, error: `HireHop accepted the adjustment but returned no ID (keys: ${data && typeof data === 'object' ? Object.keys(data).join(',') : 'none'})` };
  }
  const returnedQty = Number(data?.QTY);
  if (Number.isFinite(returnedQty) && Math.abs(returnedQty + Math.abs(qty)) > 0.001) {
    // It adjusted by something other than what we asked. Better to stop and be
    // looked at than to record a number we know is wrong.
    return { tallyId: null, error: `HireHop adjusted by ${returnedQty}, expected ${-Math.abs(qty)}` };
  }

  return { tallyId, error: null };
}

/**
 * Drain queued CONSUMPTION transactions.
 *
 * Idempotent at LINE level, deliberately: `hh_tally_id` is written the moment
 * an adjustment exists, and a line that already has one is skipped. If the
 * process dies between HireHop accepting an adjustment and the row being
 * marked, the retry cannot double-decrement the shelf.
 */
export async function drainShopConsumption(): Promise<DrainResult> {
  const maxAttempts = await getMaxAttempts();
  const out: DrainResult = { considered: 0, pushed: 0, failed: 0, errors: [] };

  const due = await query(
    `SELECT s.id, s.notes, s.push_attempts
       FROM shop_sales s
      WHERE s.kind = 'consumption'
        AND s.status = 'queued'
        AND s.push_after <= NOW()
      ORDER BY s.created_at
      LIMIT $1`,
    [BATCH_SIZE],
  );
  out.considered = due.rows.length;

  for (const sale of due.rows) {
    const saleId = sale.id as string;
    const attempts = Number(sale.push_attempts) + 1;

    try {
      const lines = await query(
        `SELECT id, hh_stock_id, qty, name_snapshot, hh_tally_id
           FROM shop_sale_lines WHERE sale_id = $1 ORDER BY created_at`,
        [saleId],
      );

      let failedReason: string | null = null;
      for (const line of lines.rows) {
        if (line.hh_tally_id) continue;   // already adjusted — never do it twice

        // The reason is compulsory on HireHop's side and is the whole point of
        // the trail: "what did we burn through, and what for".
        const details = `${sale.notes || 'Used by Ooosh'} (via OP)`;
        const { tallyId, error } = await pushTally(
          Number(line.hh_stock_id), Number(line.qty), details,
        );
        if (!tallyId) { failedReason = `${line.name_snapshot}: ${error}`; break; }

        await query(`UPDATE shop_sale_lines SET hh_tally_id = $2 WHERE id = $1`, [line.id, tallyId]);
      }

      if (failedReason) {
        const giveUp = attempts >= maxAttempts;
        await query(
          `UPDATE shop_sales
              SET push_attempts = $2, push_error = $3, status = CASE WHEN $4 THEN 'failed' ELSE status END
            WHERE id = $1`,
          [saleId, attempts, failedReason, giveUp],
        );
        if (giveUp) out.failed++;
        out.errors.push(`${saleId}: ${failedReason}`);
        continue;
      }

      await query(
        `UPDATE shop_sales
            SET status = 'pushed', pushed_at = NOW(), push_attempts = $2, push_error = NULL
          WHERE id = $1`,
        [saleId, attempts],
      );
      out.pushed++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const giveUp = attempts >= maxAttempts;
      await query(
        `UPDATE shop_sales
            SET push_attempts = $2, push_error = $3, status = CASE WHEN $4 THEN 'failed' ELSE status END
          WHERE id = $1`,
        [saleId, attempts, reason, giveUp],
      ).catch(() => { /* the DB is already unhappy; the log below is the record */ });
      if (giveUp) out.failed++;
      out.errors.push(`${saleId}: ${reason}`);
    }
  }

  if (out.considered > 0) {
    console.log(`[shop-drain] consumption: ${out.pushed} pushed, ${out.failed} gave up, of ${out.considered} due`);
  }
  return out;
}

// ── Sales (step 6b) ──────────────────────────────────────────────────────

/**
 * Put ONE sale line on a HireHop job and return its line id.
 *
 * `save_job.php` returns the created line in its OWN response, under
 * `data.items.itms` (§2.6). That is why this is one call rather than the
 * four the recharge pattern uses — it needs a re-read only because it then
 * sets a custom price.
 *
 * One call PER LINE, not one call for the basket: `items: {a25: 2, a36: 1}`
 * would add both, but matching the returned lines back to our rows would be
 * guesswork, and a mis-mapped `hh_line_id` means a reversal later deletes the
 * wrong line.
 *
 * Exported for its own tests — the §2.5 response check is the load-bearing part.
 */
export async function pushSaleLine(
  hhJobNumber: number,
  stockId: number,
  qty: number,
): Promise<{ lineId: number | null; unitPrice: number | null; error: string | null }> {
  const res = await hhBroker.post<any>('/api/save_job.php', {
    job: hhJobNumber,
    items: JSON.stringify({ [`a${stockId}`]: qty }),   // a = sales, b = hire, c = labour
    no_webhook: 1,
  }, { priority: 'low' });

  if (!res?.success) {
    console.error('[shop-drain] save_job line rejected. job=%s stock=%s reply=%j', hhJobNumber, stockId, res);
    return { lineId: null, unitPrice: null, error: `HireHop rejected the line — ${JSON.stringify(res?.error ?? null).slice(0, 200)}` };
  }

  // Judge the RESULT, not the flag (§2.5).
  const itms: any[] = res.data?.items?.itms || [];
  const line = itms.find((i) => String(i.LIST_ID) === String(stockId));
  if (!line?.ID) {
    console.error('[shop-drain] save_job accepted but returned no line. reply=%j', res.data?.items);
    return { lineId: null, unitPrice: null, error: 'HireHop accepted the line but did not return it — check the job by hand.' };
  }
  return {
    lineId: Number(line.ID),
    unitPrice: line.UNIT_PRICE != null ? Number(line.UNIT_PRICE) : null,
    error: null,
  };
}

/**
 * Override a line's unit price, for a discounted sale.
 *
 * Skipped entirely at list price — the line already arrives correctly priced
 * (§2.6), so most sales never make this call. Field shape copied from the
 * proven `cost-recharge-hh.ts` push; `vat_rate: 0` means "derive VAT from the
 * stock's own tax rules", NOT zero-rate it (§2.2).
 */
async function setLinePrice(
  hhJobNumber: number, lineId: number, stockId: number,
  qty: number, unitPrice: number, note: string,
): Promise<string | null> {
  const res = await hhBroker.post<any>('/php_functions/items_save.php', {
    job: hhJobNumber, kind: 1, id: lineId, list_id: stockId,
    qty, unit_price: unitPrice, price: unitPrice,
    price_type: 0, add: note.slice(0, 200), cust_add: '', memo: '', name: '',
    parent: 0, vat_rate: 0, value: 0, cost_price: 0, weight: 0,
    start: '', end: '', duration: 0, country_origin: '', hs_code: '',
    flag: 0, priority_confirm: 0, no_shortfall: 1, no_availability: 0,
    ignore: 0, local: hhLocalNow(),
  }, { priority: 'low' });
  return res?.success ? null : `priced at list — the discount did not save (${JSON.stringify(res?.error ?? null).slice(0, 120)})`;
}

/**
 * Drain queued SALES.
 *
 * Order matters: lines first, money last. If the money push fails, the lines
 * are already recorded against `hh_line_id` and the retry skips them, so a
 * second attempt cannot double-sell the stock. The reverse order could take
 * payment for stock that never left the shelf.
 *
 * Idempotent at line level via `hh_line_id`, and at sale level for the deposit
 * via `hh_deposit_id` — a crash between HireHop taking the money and OP
 * recording it must not charge twice.
 */
export async function drainShopSales(): Promise<DrainResult> {
  const maxAttempts = await getMaxAttempts();
  const out: DrainResult = { considered: 0, pushed: 0, failed: 0, errors: [] };

  const due = await query(
    `SELECT id, tender, gross_amount, notes, push_attempts,
            hh_job_number, hh_deposit_id, sold_to_job_id
       FROM shop_sales
      WHERE kind = 'sale' AND status = 'queued' AND push_after <= NOW()
      ORDER BY created_at
      LIMIT $1`,
    [BATCH_SIZE],
  );
  out.considered = due.rows.length;

  for (const sale of due.rows) {
    const saleId = sale.id as string;
    const attempts = Number(sale.push_attempts) + 1;
    let failedReason: string | null = null;

    try {
      // Which job? A sale routed to a client's own job goes there; everything
      // else pools on the week's shop job (§9).
      let hhJobNumber = sale.hh_job_number ? Number(sale.hh_job_number) : null;
      if (!hhJobNumber) {
        if (sale.sold_to_job_id) {
          const j = await query(`SELECT hh_job_number FROM jobs WHERE id = $1`, [sale.sold_to_job_id]);
          hhJobNumber = j.rows[0]?.hh_job_number ? Number(j.rows[0].hh_job_number) : null;
          if (!hhJobNumber) throw new Error('That job has no HireHop job number.');
        } else {
          hhJobNumber = (await getOrCreateShopPeriod(new Date())).hhJobNumber;
        }
        await query(`UPDATE shop_sales SET hh_job_number = $2 WHERE id = $1`, [saleId, hhJobNumber]);
      }

      const lines = await query(
        `SELECT id, hh_stock_id, qty, name_snapshot, unit_price_list, unit_price_charged, hh_line_id
           FROM shop_sale_lines WHERE sale_id = $1 ORDER BY created_at`,
        [saleId],
      );

      for (const line of lines.rows) {
        if (line.hh_line_id) continue;      // already on the job — never twice

        const stockId = Number(line.hh_stock_id);
        const qty = Number(line.qty);
        const { lineId, error } = await pushSaleLine(hhJobNumber, stockId, qty);
        if (!lineId) { failedReason = `${line.name_snapshot}: ${error}`; break; }

        // Record the id BEFORE anything else can fail, so a retry skips it.
        await query(`UPDATE shop_sale_lines SET hh_line_id = $2 WHERE id = $1`, [line.id, lineId]);

        const charged = Number(line.unit_price_charged);
        const list = Number(line.unit_price_list);
        if (Math.abs(charged - list) > 0.001) {
          const note = `Shop sale — discounted from £${list.toFixed(2)}`;
          const priceErr = await setLinePrice(hhJobNumber, lineId, stockId, qty, charged, note);
          if (priceErr) {
            // The line exists and the stock has moved; only the price is wrong.
            // Surface it rather than retrying the whole sale and double-selling.
            failedReason = `${line.name_snapshot}: ${priceErr}`;
            break;
          }
        }
      }

      // Money last. `invoice_later` rides the client's own invoice, so there is
      // no payment to record here.
      if (!failedReason && !sale.hh_deposit_id && sale.tender && sale.tender !== 'invoice_later') {
        const gross = Number(sale.gross_amount);
        if (gross > 0) {
          const dep = await pushDepositToHH({
            hhJobNumber,
            amount: gross,
            paymentMethod: sale.tender,
            paymentType: 'other',
            notes: sale.notes ? String(sale.notes).slice(0, 150) : 'Shop sale',
          });
          if (dep.error || !dep.hhDepositId) {
            failedReason = `payment: ${dep.error || 'HireHop returned no deposit id'}`;
          } else {
            await query(`UPDATE shop_sales SET hh_deposit_id = $2 WHERE id = $1`, [saleId, dep.hhDepositId]);
          }
        }
      }

      if (failedReason) {
        const giveUp = attempts >= maxAttempts;
        await query(
          `UPDATE shop_sales SET push_attempts = $2, push_error = $3,
                  status = CASE WHEN $4 THEN 'failed' ELSE status END
            WHERE id = $1`,
          [saleId, attempts, failedReason, giveUp],
        );
        if (giveUp) out.failed++;
        out.errors.push(`${saleId}: ${failedReason}`);
        continue;
      }

      await query(
        `UPDATE shop_sales SET status = 'pushed', pushed_at = NOW(),
                push_attempts = $2, push_error = NULL WHERE id = $1`,
        [saleId, attempts],
      );
      out.pushed++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const giveUp = attempts >= maxAttempts;
      await query(
        `UPDATE shop_sales SET push_attempts = $2, push_error = $3,
                status = CASE WHEN $4 THEN 'failed' ELSE status END
          WHERE id = $1`,
        [saleId, attempts, reason, giveUp],
      ).catch(() => { /* the log below is the record */ });
      if (giveUp) out.failed++;
      out.errors.push(`${saleId}: ${reason}`);
    }
  }

  if (out.considered > 0) {
    console.log(`[shop-drain] sales: ${out.pushed} pushed, ${out.failed} gave up, of ${out.considered} due`);
  }
  return out;
}

/** Both queues, consumption first (cheaper and money-free). */
export async function drainShop(): Promise<{ consumption: DrainResult; sales: DrainResult }> {
  return { consumption: await drainShopConsumption(), sales: await drainShopSales() };
}
