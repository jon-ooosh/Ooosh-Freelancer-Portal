/**
 * shop-sales.ts — THE definition of what a shop transaction is worth, and who
 * is allowed to discount it.
 *
 * Step 4 of `docs/SHOP-SALES-SPEC.md`. This builds and stores the transaction;
 * it does NOT talk to HireHop. Rows land `status = 'queued'` and the drain
 * (steps 5–6) sends them later.
 *
 * The load-bearing idea (§0): a sale is ONE atomic record — lines, tender, who,
 * when. The weekly HireHop job it eventually lands on is a downstream ledger,
 * not the unit of truth. That is the whole reason the current process fails to
 * reconcile: a week-long shared job has no point at which anyone can say "this
 * transaction is complete and balanced".
 *
 * Money conventions, all of which bite:
 *   - HireHop prices are EX-VAT. The customer pays gross (§2.2).
 *   - `vat_rate_index` is a tax-TYPE index, not a percentage. Index 0 is the
 *     STANDARD rate. Resolve it through `shop-stock.ts resolveVatRate()`.
 *   - VAT is computed and rounded PER LINE, because a basket can mix rates
 *     (971 standard items, 3 zero-rated) and summing then taxing would be wrong.
 */
import { query, getClient } from '../config/database';
import { resolveVatRate } from './shop-stock';
import { DISPLAY_NAME_SQL } from './display-name';
import { saleRef } from './shop-sale-ref';
import { withShopDrainLock } from './shop-drain';
import { assertSellableJob } from './shop-routing';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DISCOUNT_CAPS_KEY = 'shop_discount_caps';
const PUSH_HOLD_KEY = 'shop_push_hold_seconds';

/**
 * Fallback ceilings if the setting is missing or unreadable.
 *
 * Note the direction: this fails CLOSED, unlike the VAT and category fallbacks
 * in `shop-stock.ts` which fail open. Those govern what staff can SEE; this
 * governs money leaving the business, so an unreadable setting must not hand
 * everybody an admin's ceiling.
 */
const DEFAULT_DISCOUNT_CAPS: Record<string, number> = {
  admin: 100,
  manager: 50,
  staff: 10,
  general_assistant: 10,
  freelancer: 0,
};

/** Fallback hold before a sale drains to HireHop (Window A, §8). */
const DEFAULT_PUSH_HOLD_SECONDS = 120;

export interface ShopSaleLineInput {
  hhStockId: number;
  qty: number;
  /** Ex-VAT price actually charged. Omit to charge list price. */
  unitPriceCharged?: number;
}

export interface CreateShopSaleInput {
  kind: 'sale' | 'consumption';
  lines: ShopSaleLineInput[];
  /** Key into HH_BANK_IDS, or 'invoice_later'. Required for a sale. */
  tender?: string | null;
  soldToJobId?: string | null;
  soldToPersonId?: string | null;
  notes?: string | null;
  recordedIn?: 'staff_till' | 'sitter_till';
}

export interface ShopSaleTotals {
  net: number;
  vat: number;
  gross: number;
  discount: number;
  /** Discount as a % of the undiscounted ex-VAT total. */
  discountPct: number;
}

interface PricedLine {
  hhStockId: number;
  nameSnapshot: string;
  unitPriceList: number;
  unitPriceCharged: number;
  qty: number;
  vatRateIndex: number | null;
  vatRatePct: number;
  lineNet: number;
  lineVat: number;
  lineGross: number;
}

/** Round to the penny. Money is never left as float dust. */
function penny(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Discount ceilings ────────────────────────────────────────────────────

/**
 * THE definition: the most this role may discount, as a percentage of the
 * TRANSACTION total.
 *
 * ⚠️ Transaction, not line. A per-line cap breaks the rounding case — knocking
 * £2 off a £52 basket of £1 cans means discounting one can by 100%, which a
 * 10%-per-line rule blocks even though the customer is only getting 4% off.
 * What matters commercially is the margin given away overall (§2.8).
 *
 * `weekend_manager` is never listed separately: it IS a manager everywhere else
 * in the platform (`authorize()` grants it wherever `manager` is allowed), and
 * listing roles separately is how they drift apart.
 */
export async function maxDiscountPctForRole(role: string | null | undefined): Promise<number> {
  let caps = DEFAULT_DISCOUNT_CAPS;
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [DISCOUNT_CAPS_KEY]);
    const raw = r.rows[0]?.value;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const clean: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 0 && n <= 100) clean[k] = n;
        }
        if (Object.keys(clean).length > 0) caps = clean;
      }
    }
  } catch (err) {
    console.warn('[shop-sales] discount caps unreadable, using defaults:',
      err instanceof Error ? err.message : err);
  }

  const effective = role === 'weekend_manager' ? 'manager' : (role || '');
  // Unknown role → 0. Fails closed: money out of the door is not the place to
  // guess generously.
  return caps[effective] ?? 0;
}

/** Window A: how long a sale sits before the drain sends it (§8). */
export async function getPushHoldSeconds(): Promise<number> {
  try {
    const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [PUSH_HOLD_KEY]);
    const n = Number(r.rows[0]?.value);
    if (Number.isFinite(n) && n >= 0 && n <= 3600) return n;
  } catch {
    // fall through
  }
  return DEFAULT_PUSH_HOLD_SECONDS;
}

// ── Pricing ──────────────────────────────────────────────────────────────

/**
 * Price a basket from the catalogue mirror.
 *
 * Prices come from `shop_stock_cache`, never from the caller — a till that
 * trusts a client-supplied price is a till that can be talked into any number.
 * The caller may only propose a DISCOUNTED price, and only downwards.
 */
export async function priceLines(lines: ShopSaleLineInput[]): Promise<PricedLine[]> {
  if (!lines.length) throw new Error('A sale needs at least one line.');

  const ids = [...new Set(lines.map((l) => Number(l.hhStockId)))];
  const r = await query(
    `SELECT hh_stock_id, title, price, vat_rate_index, max_discount
       FROM shop_stock_cache WHERE hh_stock_id = ANY($1::int[])`,
    [ids],
  );
  const byId = new Map<number, any>(r.rows.map((row: any) => [Number(row.hh_stock_id), row]));

  const priced: PricedLine[] = [];
  for (const line of lines) {
    const stock = byId.get(Number(line.hhStockId));
    if (!stock) throw new Error(`Stock item ${line.hhStockId} is not in the catalogue.`);

    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty <= 0) throw new Error(`Invalid quantity for "${stock.title}".`);

    const listPrice = stock.price != null ? Number(stock.price) : 0;
    let charged = line.unitPriceCharged != null ? Number(line.unitPriceCharged) : listPrice;
    if (!Number.isFinite(charged) || charged < 0) {
      throw new Error(`Invalid price for "${stock.title}".`);
    }
    // Never silently move money: a price ABOVE list is not a discount, it is a
    // typo or a markup nobody agreed. Reject rather than quietly accept.
    if (charged > listPrice) {
      throw new Error(`"${stock.title}" cannot be sold above its list price of £${listPrice.toFixed(2)}.`);
    }

    // HireHop's own per-item ceiling. It is 100 on everything today, but it
    // exists and would reject the push, so check before taking the money.
    const maxDisc = stock.max_discount != null ? Number(stock.max_discount) : 100;
    if (listPrice > 0 && maxDisc < 100) {
      const discPct = ((listPrice - charged) / listPrice) * 100;
      if (discPct > maxDisc + 0.001) {
        throw new Error(`"${stock.title}" allows at most ${maxDisc}% discount.`);
      }
    }

    const vatRateIndex = stock.vat_rate_index != null ? Number(stock.vat_rate_index) : null;
    const vatRatePct = await resolveVatRate(vatRateIndex);

    // Rounded per line, not at the end: a basket can mix VAT rates, so a single
    // total-then-tax would be wrong as soon as a zero-rated item is in it.
    const lineNet = penny(charged * qty);
    const lineVat = penny(lineNet * (vatRatePct / 100));
    const lineGross = penny(lineNet + lineVat);

    priced.push({
      hhStockId: Number(line.hhStockId),
      nameSnapshot: stock.title,
      unitPriceList: listPrice,
      unitPriceCharged: penny(charged),
      qty,
      vatRateIndex,
      vatRatePct,
      lineNet,
      lineVat,
      lineGross,
    });
  }
  return priced;
}

export function totalsFor(lines: PricedLine[]): ShopSaleTotals {
  const net = penny(lines.reduce((s, l) => s + l.lineNet, 0));
  const vat = penny(lines.reduce((s, l) => s + l.lineVat, 0));
  const gross = penny(lines.reduce((s, l) => s + l.lineGross, 0));
  const listTotal = penny(lines.reduce((s, l) => s + l.unitPriceList * l.qty, 0));
  const discount = penny(listTotal - net);
  const discountPct = listTotal > 0 ? (discount / listTotal) * 100 : 0;
  return { net, vat, gross, discount, discountPct };
}

// ── Create ───────────────────────────────────────────────────────────────

export interface CreateResult {
  id: string;
  kind: 'sale' | 'consumption';
  /**
   * What was actually STORED — zeroes for a consumption.
   *
   * It previously returned the priced basket regardless of kind, so recording
   * "used for Ooosh" answered with a money total and the till cheerfully said
   * "Recorded — £9.00". Consumption has no money in it; showing a figure there
   * makes it look like a sale, which is the exact conflation §2 exists to undo.
   */
  totals: ShopSaleTotals;
  pushAfter: string;
}

/**
 * Record a transaction. Lines and totals land in ONE database transaction, so a
 * half-written sale cannot exist — which is the point of the whole module.
 */
export async function createShopSale(
  input: CreateShopSaleInput,
  user: { id: string; role: string },
): Promise<CreateResult> {
  const priced = await priceLines(input.lines);
  const totals = totalsFor(priced);

  // Discount ceiling, checked against the TRANSACTION (§2.8).
  if (totals.discount > 0) {
    const cap = await maxDiscountPctForRole(user.role);
    if (totals.discountPct > cap + 0.001) {
      throw new Error(
        `That is a ${totals.discountPct.toFixed(1)}% discount; your limit is ${cap}%. ` +
        `Ask a manager to apply it.`,
      );
    }
  }

  if (input.kind === 'sale') {
    if (!input.tender) throw new Error('A sale needs a payment method.');
    // §9: the weekly shop job pools every customer, so its invoice can never be
    // sent to one of them. Credit therefore requires a real job to invoice.
    if (input.tender === 'invoice_later' && !input.soldToJobId) {
      throw new Error('"Invoice later" needs a job to put it on — a walk-in must pay now.');
    }
    // Refuse a closed job HERE, while the customer is still at the counter,
    // rather than let the drain find out after they've gone (step 7).
    if (input.soldToJobId) await assertSellableJob(input.soldToJobId);
  }

  const holdSeconds = await getPushHoldSeconds();

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Only a SALE takes an OT-SHOP number — consumption has no money and no
    // receipt, so numbering it would just leave gaps in the sequence.
    const saleRes = await client.query(
      `INSERT INTO shop_sales (
         kind, status, tender, net_amount, vat_amount, gross_amount, discount_amount,
         recorded_by, recorded_in, sold_to_person_id, sold_to_job_id,
         needs_review, notes, push_after, sale_number
       ) VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' seconds')::interval,
                 CASE WHEN $1::text = 'sale' THEN nextval('shop_sale_number_seq') END)
       RETURNING id, push_after`,
      [
        input.kind,
        input.kind === 'consumption' ? null : input.tender,
        input.kind === 'consumption' ? 0 : totals.net,
        input.kind === 'consumption' ? 0 : totals.vat,
        input.kind === 'consumption' ? 0 : totals.gross,
        input.kind === 'consumption' ? 0 : totals.discount,
        user.id,
        input.recordedIn || 'staff_till',
        input.soldToPersonId || null,
        input.kind === 'sale' ? (input.soldToJobId || null) : null,
        (input.recordedIn || 'staff_till') === 'sitter_till',
        input.notes || null,
        String(holdSeconds),
      ],
    );
    const saleId = saleRes.rows[0].id as string;

    for (const l of priced) {
      await client.query(
        `INSERT INTO shop_sale_lines (
           sale_id, hh_stock_id, name_snapshot, unit_price_list, unit_price_charged,
           qty, vat_rate_index, vat_rate_pct, line_net, line_vat, line_gross
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          saleId, l.hhStockId, l.nameSnapshot, l.unitPriceList, l.unitPriceCharged,
          l.qty, l.vatRateIndex, l.vatRatePct, l.lineNet, l.lineVat, l.lineGross,
        ],
      );
    }

    await client.query('COMMIT');
    const stored: ShopSaleTotals = input.kind === 'consumption'
      ? { net: 0, vat: 0, gross: 0, discount: 0, discountPct: 0 }
      : totals;
    return { id: saleId, kind: input.kind, totals: stored, pushAfter: saleRes.rows[0].push_after };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Put a failed transaction back in the queue.
 *
 * The drain gives up after N attempts so a permanently-bad row cannot retry
 * forever (migration 241). That is right, but it leaves no way back once the
 * underlying problem is fixed — and "re-key the whole thing" is both annoying
 * and wrong, because the original row records what someone actually did.
 *
 * Only a FAILED row can be requeued. A pushed one must not be sent twice.
 */
export async function retryShopSale(id: string): Promise<{ requeued: boolean; message?: string }> {
  const r = await query(`SELECT status FROM shop_sales WHERE id = $1`, [id]);
  if (!r.rows[0]) return { requeued: false, message: 'Sale not found.' };
  if (r.rows[0].status !== 'failed') {
    return { requeued: false, message: `Only a failed transaction can be retried (this one is ${r.rows[0].status}).` };
  }
  await query(
    `UPDATE shop_sales
        SET status = 'queued', push_attempts = 0, push_error = NULL, push_after = NOW(),
            stuck_alerted_at = NULL   -- if it fails again, say so again
      WHERE id = $1`,
    [id],
  );
  return { requeued: true };
}

// ── Read / cancel ────────────────────────────────────────────────────────

/**
 * `attention` narrows to what a human needs to act on: transactions that
 * failed or are stuck in the queue past their hold, and refunds whose money
 * hasn't gone back yet. Same row shape, so the till renders it the same way.
 */
export async function listShopSales(opts: { limit?: number; since?: string; attention?: boolean } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const r = await query(
    // `users` carries no name — it points at `people`. DISPLAY_NAME_SQL is THE
    // definition of what a person is called, and expects `people` joined as `p`.
    `SELECT s.*,
            NULLIF(${DISPLAY_NAME_SQL}, ' ') AS recorded_by_name,
            o.sale_number AS reverses_sale_number,
            -- The job a routed sale went on. The four name fields are what
            -- lib/jobOrgName.ts needs; the till names the job through it.
            sj.hh_job_number AS sold_to_hh_job_number,
            sj.job_name AS sold_to_job_name,
            sj.company_name AS sold_to_company_name,
            sj.client_name AS sold_to_client_name,
            sjo.name AS sold_to_client_org_name,
            (SELECT lo.name FROM job_organisations jo
               JOIN organisations lo ON lo.id = jo.organisation_id
              WHERE jo.job_id = sj.id AND jo.is_primary = true LIMIT 1) AS sold_to_lead_org_name,
            -- The live reversal of this sale, if it has been refunded.
            (SELECT r.id FROM shop_sales r
              WHERE r.reverses_sale_id = s.id AND r.kind = 'reversal' AND r.status <> 'cancelled'
              LIMIT 1) AS reversal_id,
            COALESCE(
              json_agg(
                json_build_object(
                  'id', l.id, 'hhStockId', l.hh_stock_id, 'name', l.name_snapshot,
                  'qty', l.qty, 'unitPriceList', l.unit_price_list,
                  'unitPriceCharged', l.unit_price_charged,
                  'vatRatePct', l.vat_rate_pct, 'lineGross', l.line_gross
                ) ORDER BY l.created_at
              ) FILTER (WHERE l.id IS NOT NULL), '[]'
            ) AS lines
       FROM shop_sales s
       LEFT JOIN users u ON u.id = s.recorded_by
       LEFT JOIN people p ON p.id = u.person_id
       LEFT JOIN shop_sale_lines l ON l.sale_id = s.id
       LEFT JOIN shop_sales o ON o.id = s.reverses_sale_id
       -- A reversal names the job its original sale went on.
       LEFT JOIN jobs sj ON sj.id = COALESCE(s.sold_to_job_id, o.sold_to_job_id)
       LEFT JOIN organisations sjo ON sjo.id = sj.client_id AND sjo.is_deleted = false
      WHERE ($1::timestamptz IS NULL OR s.created_at >= $1)
        AND (NOT $3::boolean OR s.status = 'failed'
             OR (s.status = 'queued' AND s.push_after < NOW() - interval '30 minutes')
             OR (s.kind = 'reversal' AND s.status <> 'cancelled' AND s.refund_settled_at IS NULL))
      GROUP BY s.id, p.preferred_name, p.first_name, p.last_name, o.sale_number,
               sj.id, sj.hh_job_number, sj.job_name, sj.company_name, sj.client_name, sjo.name
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [opts.since || null, limit, !!opts.attention],
  );
  return r.rows.map((row: any) => ({
    ...row,
    sale_ref: row.sale_number != null ? saleRef(Number(row.sale_number)) : null,
    reverses_sale_ref: row.reverses_sale_number != null ? saleRef(Number(row.reverses_sale_number)) : null,
    // Tells the till whether a refund of this sale is handed back at the
    // counter (cash, card) or sent later — so the rule lives in ONE place.
    refund_at_counter: COUNTER_REFUND_TENDERS.includes(String(row.tender)),
  }));
}

/**
 * What we have consumed ourselves, grouped by item.
 *
 * HireHop keeps a per-item adjustment trail, which answers "what happened to
 * THIS item". It cannot answer "what did we burn through last month", because
 * that means opening every item in turn. This is the reordering view (§12): the
 * real answer to someone buying the drum heads earmarked for Thursday is
 * knowing on Monday that they were running low.
 *
 * Counts only what actually reached HireHop. A queued or failed row has not
 * moved any stock, so including it would overstate consumption and understate
 * what is still on the shelf.
 */
export async function getConsumptionSummary(days = 30) {
  const window = Math.min(Math.max(days, 1), 365);
  const r = await query(
    `SELECT l.hh_stock_id,
            MAX(l.name_snapshot)                AS name,
            SUM(l.qty)::numeric                 AS total_qty,
            COUNT(DISTINCT s.id)::int           AS occasions,
            MAX(s.created_at)                   AS last_used,
            MAX(c.quantity)                     AS on_shelf,
            MAX(c.reorder_level)                AS reorder_level
       FROM shop_sale_lines l
       JOIN shop_sales s ON s.id = l.sale_id
       LEFT JOIN shop_stock_cache c ON c.hh_stock_id = l.hh_stock_id
      WHERE s.kind = 'consumption'
        AND s.status = 'pushed'
        AND s.created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY l.hh_stock_id
      ORDER BY SUM(l.qty) DESC, MAX(l.name_snapshot)`,
    [String(window)],
  );
  return r.rows;
}

/**
 * The individual consumption events, newest first — the "who used what, when
 * and why" trail. HireHop holds the same facts per item; this is the view
 * across items that it cannot give.
 */
export async function getConsumptionLog(days = 30, limit = 100) {
  const window = Math.min(Math.max(days, 1), 365);
  const cap = Math.min(Math.max(limit, 1), 500);
  const r = await query(
    `SELECT s.id, s.created_at, s.status, s.notes,
            NULLIF(${DISPLAY_NAME_SQL}, ' ')   AS recorded_by_name,
            l.name_snapshot, l.qty, l.hh_tally_id
       FROM shop_sales s
       JOIN shop_sale_lines l ON l.sale_id = s.id
       LEFT JOIN users u ON u.id = s.recorded_by
       LEFT JOIN people p ON p.id = u.person_id
      WHERE s.kind = 'consumption'
        AND s.status <> 'cancelled'
        AND s.created_at >= NOW() - ($1 || ' days')::interval
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [String(window), cap],
  );
  return r.rows;
}

/**
 * Soft-cancel (house rule: never delete).
 *
 * Window A (§8): a TRUE undo, because nothing has reached HireHop or Xero, so
 * cancelling the row is the whole job. Once anything has been sent it is not:
 * the money is in Xero and a return is a new linked event — `reverseShopSale`.
 *
 * Runs inside the drain lock. Without it a cancel could land while the drain
 * was mid-push on the same row, and the drain's "pushed" would then leave a
 * cancelled sale with a real line and a real deposit in HireHop.
 *
 * "Nothing sent" is judged on the HireHop ids, not on the status: a FAILED sale
 * may have got its lines onto the job before the payment step fell over, and
 * cancelling that would strand stock and money nobody is tracking.
 */
export async function cancelShopSale(
  id: string,
  user: { id: string },
  reason: string | null,
): Promise<{ cancelled: boolean; message?: string }> {
  return withShopDrainLock(async () => {
    const r = await query(
      `SELECT s.status, s.kind, s.hh_deposit_id, s.hh_refund_id,
              EXISTS (SELECT 1 FROM shop_sale_lines l
                       WHERE l.sale_id = s.id AND (l.hh_line_id IS NOT NULL OR l.hh_tally_id IS NOT NULL)
                     ) AS has_hh_lines,
              -- A reversal's HireHop work is done on the ORIGINAL sale's lines.
              EXISTS (SELECT 1 FROM shop_sale_lines l
                       WHERE l.sale_id = s.reverses_sale_id AND l.hh_line_removed_at IS NOT NULL
                     ) AS removed_lines
         FROM shop_sales s WHERE s.id = $1`,
      [id],
    );
    const row = r.rows[0];
    if (!row) return { cancelled: false, message: 'Sale not found.' };

    const status = row.status as string;
    if (status === 'cancelled') return { cancelled: true };
    if (status === 'pushed') {
      return {
        cancelled: false,
        message: row.kind === 'reversal'
          ? 'This refund has already reached HireHop and cannot be undone here.'
          : 'This has already reached HireHop, so it needs a refund rather than a cancel.',
      };
    }

    // A reversal that stopped before touching anything — typically because the
    // week had already been invoiced — can be cancelled; one that has taken a
    // line off or refunded money cannot.
    const touchedHireHop = row.kind === 'reversal'
      ? (!!row.hh_refund_id || !!row.removed_lines)
      : (!!row.hh_deposit_id || !!row.has_hh_lines);
    if (touchedHireHop) {
      return {
        cancelled: false,
        message: 'Part of this has already reached HireHop, so cancelling it here would leave that behind. ' +
          'Retry it to finish the push, then refund it.',
      };
    }

    await query(
      `UPDATE shop_sales
          SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3
        WHERE id = $1`,
      [id, user.id, reason || null],
    );
    return { cancelled: true };
  });
}

/**
 * Refund a sale that has already reached HireHop — Window B (§8).
 *
 * Records a linked `kind = 'reversal'` row; the drain then takes the lines off
 * the job (stock back on the shelf) and applies a refund against the sale's
 * deposit. The original keeps its row and its `pushed` status: both events
 * really happened. Its money figures are stored NEGATIVE, so summing a week's
 * rows gives what the week actually took.
 *
 * Whole sale only in v1. Taking back one item from a basket is "refund the
 * sale, ring the rest again" — a partial reversal would mean editing a line's
 * quantity in HireHop, and nothing about that endpoint has been captured yet.
 *
 * The physical money back is the operator's job, and for cash and card it
 * happens there and then at the counter — so for those tenders pressing Refund
 * IS the confirmation, and the refund is settled on creation. Only tenders
 * whose money goes back later, from another screen (bank transfer, PayPal,
 * Stripe), are left OUTSTANDING until someone ticks them off. `moneyReturned`
 * can settle one of those immediately too.
 */
/** Tenders refunded there and then at the counter — cash from the till, card on the terminal. */
export const COUNTER_REFUND_TENDERS = ['till_cash', 'worldpay', 'amex'];

export async function reverseShopSale(
  saleId: string,
  user: { id: string },
  opts: { reason: string; moneyReturned: boolean },
): Promise<{ reversalId: string }> {
  const reason = (opts.reason || '').trim();
  if (!reason) throw new Error('Say why it is being refunded.');

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // FOR UPDATE: two people pressing Refund at once queue here, and the
    // second then finds the first one's reversal.
    const r = await client.query(
      `SELECT id, kind, status, tender, hh_job_number, hh_deposit_id,
              net_amount, vat_amount, gross_amount, discount_amount
         FROM shop_sales WHERE id = $1 FOR UPDATE`,
      [saleId],
    );
    const sale = r.rows[0];
    if (!sale) throw new Error('Sale not found.');
    if (sale.kind !== 'sale') throw new Error('Only a sale can be refunded.');
    if (sale.status === 'queued' || sale.status === 'failed') {
      throw new Error('This sale has not fully reached HireHop yet — cancel it instead (or retry it first if it failed).');
    }
    if (sale.status !== 'pushed') throw new Error(`This sale is ${sale.status} and cannot be refunded.`);

    const existing = await client.query(
      `SELECT 1 FROM shop_sales
        WHERE reverses_sale_id = $1 AND kind = 'reversal' AND status <> 'cancelled'`,
      [saleId],
    );
    if (existing.rows.length) throw new Error('This sale has already been refunded.');

    // Window C: once the week is invoiced, the payment is applied to that
    // invoice and a refund needs a credit note — deliberately not built (§8).
    // `invoiced_at` is not yet set automatically, so the drain ALSO checks the
    // deposit in HireHop before touching anything.
    if (sale.hh_job_number) {
      const inv = await client.query(
        `SELECT invoiced_at FROM shop_sale_periods WHERE hh_job_number = $1 AND invoiced_at IS NOT NULL`,
        [sale.hh_job_number],
      );
      if (inv.rows.length) {
        throw new Error("That week's shop job has been invoiced, so this needs a credit note in HireHop by hand.");
      }
    }

    const neg = (v: unknown) => -Math.abs(Number(v) || 0);
    const ins = await client.query(
      `INSERT INTO shop_sales (
         kind, status, reverses_sale_id, tender, hh_job_number,
         net_amount, vat_amount, gross_amount, discount_amount,
         recorded_by, recorded_in, notes, push_after,
         refund_settled_at, refund_settled_by
       ) VALUES ('reversal','queued',$1,$2,$3,$4,$5,$6,$7,$8,'staff_till',$9, NOW(),
                 CASE WHEN $10 THEN NOW() END, CASE WHEN $10 THEN $8::uuid END)
       RETURNING id`,
      [
        saleId, sale.tender, sale.hh_job_number,
        neg(sale.net_amount), neg(sale.vat_amount), neg(sale.gross_amount), neg(sale.discount_amount),
        user.id, reason,
        // Settled on creation: counter refunds (the button is the confirmation)
        // and "their bill" sales, which were never paid so have nothing to return.
        !!opts.moneyReturned || COUNTER_REFUND_TENDERS.includes(String(sale.tender)) || sale.tender === 'invoice_later',
      ],
    );

    await client.query('COMMIT');
    return { reversalId: ins.rows[0].id as string };
  } catch (err) {
    await client.query('ROLLBACK');
    // The partial unique index is the backstop for a race the FOR UPDATE
    // should already have prevented.
    if ((err as { code?: string })?.code === '23505') throw new Error('This sale has already been refunded.');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The customer has their money back — cash handed over, or the refund keyed on
 * the card terminal. OP cannot do that part itself until Stripe (§8), so it is
 * a tick rather than a push.
 */
export async function settleShopRefund(
  reversalId: string,
  user: { id: string },
): Promise<{ settled: boolean; message?: string }> {
  const r = await query(
    `UPDATE shop_sales SET refund_settled_at = NOW(), refund_settled_by = $2
      WHERE id = $1 AND kind = 'reversal' AND status <> 'cancelled' AND refund_settled_at IS NULL
      RETURNING id`,
    [reversalId, user.id],
  );
  if (r.rows.length) return { settled: true };
  const chk = await query(`SELECT kind, refund_settled_at FROM shop_sales WHERE id = $1`, [reversalId]);
  if (!chk.rows[0] || chk.rows[0].kind !== 'reversal') return { settled: false, message: 'Refund not found.' };
  if (chk.rows[0].refund_settled_at) return { settled: true };
  return { settled: false, message: 'That refund was cancelled.' };
}
