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
  }

  const holdSeconds = await getPushHoldSeconds();

  const client = await getClient();
  try {
    await client.query('BEGIN');

    const saleRes = await client.query(
      `INSERT INTO shop_sales (
         kind, status, tender, net_amount, vat_amount, gross_amount, discount_amount,
         recorded_by, recorded_in, sold_to_person_id, sold_to_job_id,
         needs_review, notes, push_after
       ) VALUES ($1,'queued',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW() + ($13 || ' seconds')::interval)
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
        input.soldToJobId || null,
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
    return { id: saleId, totals, pushAfter: saleRes.rows[0].push_after };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Read / cancel ────────────────────────────────────────────────────────

export async function listShopSales(opts: { limit?: number; since?: string } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const r = await query(
    // `users` carries no name — it points at `people`. DISPLAY_NAME_SQL is THE
    // definition of what a person is called, and expects `people` joined as `p`.
    `SELECT s.*,
            NULLIF(${DISPLAY_NAME_SQL}, ' ') AS recorded_by_name,
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
      WHERE ($1::timestamptz IS NULL OR s.created_at >= $1)
      GROUP BY s.id, p.preferred_name, p.first_name, p.last_name
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [opts.since || null, limit],
  );
  return r.rows;
}

/**
 * Soft-cancel (house rule: never delete).
 *
 * Inside Window A this is a TRUE undo — nothing has reached HireHop or Xero, so
 * cancelling the queued row is the whole job. Once pushed it is not: the money
 * is already in Xero and a reversal is a new linked event, not an erasure (§8).
 * That path lands with the drain, so this refuses rather than pretending.
 */
export async function cancelShopSale(
  id: string,
  user: { id: string },
  reason: string | null,
): Promise<{ cancelled: boolean; message?: string }> {
  const r = await query(`SELECT status FROM shop_sales WHERE id = $1`, [id]);
  if (!r.rows[0]) return { cancelled: false, message: 'Sale not found.' };

  const status = r.rows[0].status as string;
  if (status === 'cancelled') return { cancelled: true };
  if (status === 'pushed') {
    return {
      cancelled: false,
      message: 'This sale has already reached HireHop, so it needs a refund rather than a cancel.',
    };
  }

  await query(
    `UPDATE shop_sales
        SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = $2, cancel_reason = $3
      WHERE id = $1`,
    [id, user.id, reason || null],
  );
  return { cancelled: true };
}
