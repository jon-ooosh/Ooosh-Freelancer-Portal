/**
 * Vouchers (docs/GOODWILL-CREDIT-SPEC.md §16) — a goodwill credit with a code on it.
 * Rules and codes: voucher-rules.ts. Every row is still read and written through
 * goodwill-credits.ts's shapes; this file holds what is voucher-only:
 *
 *   - looking a code up (staff only — never a public route),
 *   - making vouchers by hand (admin / managers, Money › Vouchers),
 *   - holding one for a hire (staff type the code on the job),
 *   - using one at the shop till (inside the sale's own transaction — shop-sales.ts),
 *     and giving it back if that sale is cancelled or refunded.
 *
 * Single use: once used, whatever it didn't take lapses (the goodwill rule).
 */
import type { PoolClient } from 'pg';
import { query } from '../config/database';
import {
  FREE_TO_RESERVE_SQL, GoodwillCredit, GoodwillError, creditCode, creditValueText, day, getGoodwillCredit,
  getGoodwillByRef, getGoodwillByVoucherCode, listVoucherCredits, noteGoodwill, offerGoodwill, reserveGoodwill,
} from './goodwill-credits';
import { normaliseVoucherCode } from './voucher-rules';

/**
 * By the code staff typed (any case, spaces or dashes) — or an old GW ref, which still works
 * for a credit made before §17 (staff only ever type these, so a guessable GW number is no
 * risk here). Null when there is no such voucher.
 */
export async function findVoucher(code: string): Promise<GoodwillCredit | null> {
  const gw = String(code || '').trim().toUpperCase();
  if (/^GW-?\d{4,}$/.test(gw)) return getGoodwillByRef(gw.replace(/^GW-?/, 'GW-'));
  const norm = normaliseVoucherCode(code);
  if (!norm) return null;
  return getGoodwillByVoucherCode(norm);
}

/** Why this voucher can't be used now, or null. Plain words for the till / job page. */
export function voucherProblem(g: GoodwillCredit | null, forJobId?: string | null): string | null {
  if (!g) return "That isn't a voucher code we know — check it with the client";
  if (g.status === 'used') return 'That voucher has already been used';
  if (g.status === 'withdrawn') return `That voucher was withdrawn${g.withdrawn_reason ? `: ${g.withdrawn_reason}` : ''}`;
  if (g.status === 'expired') return `That voucher ran out on ${day(g.expires_on)}`;
  if (g.status === 'reserved') {
    return g.reserved_job_id && g.reserved_job_id === forJobId
      ? 'That voucher is already held for this job'
      : `That voucher is held for ${g.reserved_job_number ? `job ${g.reserved_job_number}` : 'another job'} — a manager can take it off that job first`;
  }
  return null;
}

export interface MakeVouchersInput {
  valueIncVat: number;
  /** The net / VAT / gross input's net; left out, worked out from the inc-VAT value. */
  amountExVat?: number | null;
  reason: string;
  expiresOn?: string | null;
  personId?: string | null;
  organisationId?: string | null;
  count?: number;
}

/** Money › Vouchers: one or more vouchers, each with its own code. Admin / managers (the route checks). */
export async function makeVouchers(input: MakeVouchersInput, userId: string): Promise<GoodwillCredit[]> {
  const count = Math.max(1, Math.min(50, Math.floor(input.count || 1)));
  if (count > 1 && (input.personId || input.organisationId)) {
    throw new GoodwillError('Several vouchers at once are for handing out — make them for nobody in particular');
  }
  const made: GoodwillCredit[] = [];
  for (let i = 0; i < count; i++) {
    made.push(await offerGoodwill({
      organisation_id: input.organisationId || null,
      person_id: input.personId || null,
      amount_ex_vat: input.amountExVat ?? 0,   // 0 = worked out from the inc-VAT value
      voucher_value_inc_vat: input.valueIncVat,
      reason: input.reason,
      source_kind: 'voucher',
      expires_on: input.expiresOn || null,
    }, userId));
  }
  return made;
}

/** Every voucher, newest first (Money › Vouchers). */
export async function listVouchers(limit = 300): Promise<GoodwillCredit[]> {
  return listVoucherCredits(limit);
}

/** Staff typed a code on a job: hold the whole voucher for this hire (the usual goodwill reserve). */
export async function holdVoucherForJob(code: string, jobId: string, userId: string): Promise<GoodwillCredit> {
  const g = await findVoucher(code);
  const problem = voucherProblem(g, jobId);
  if (problem) throw new GoodwillError(problem, g ? 409 : 404);
  return reserveGoodwill(g!.id, { job_id: jobId, reserved_for: 'hire', amount_ex_vat: g!.amount_ex_vat }, userId);
}

/**
 * Use a voucher on a shop sale — called INSIDE createShopSale's transaction, so the sale
 * and the voucher stand or fall together. "Still free" is in the WHERE, so two tills
 * can't both use it. `takenOffIncVat` is what it actually came to (≤ its value); the rest
 * lapses. Throws when someone else got there first (the sale is then rolled back).
 */
export async function useVoucherOnSale(client: PoolClient, g: GoodwillCredit, sale: { id: string; ref: string | null }, takenOffIncVat: number, userId: string | null): Promise<void> {
  const value = g.voucher_value_inc_vat || 0;
  const usedExVat = value > 0 ? Math.round(g.amount_ex_vat * Math.min(1, takenOffIncVat / value) * 100) / 100 : 0;
  const r = await client.query(
    `UPDATE goodwill_credits g
        SET status = 'used', used_amount_ex_vat = $2, used_at = NOW(), used_by = $3, used_how = 'shop',
            used_shop_sale_id = $4, used_hh_ref = $5, reserved_job_id = NULL, reserved_for = NULL,
            reserved_invoice_number = NULL, reserved_amount_ex_vat = NULL, check_problem = NULL, updated_at = NOW()
      WHERE g.id = $1 AND ${FREE_TO_RESERVE_SQL}
      RETURNING g.id`,
    [g.id, Math.max(usedExVat, 0.01), userId, sale.id, sale.ref],
  );
  if (!r.rows.length) throw new Error(`Voucher ${creditCode(g)} has just been used or held somewhere else — take it off and ring the sale again.`);
}

/** A timeline line once the sale is in. Never throws. */
export async function noteVoucherUsedOnSale(creditId: string, saleRef: string | null, takenOffIncVat: number, userId: string | null): Promise<void> {
  try {
    const g = await getGoodwillCredit(creditId);
    if (!g) return;
    const value = g.voucher_value_inc_vat || 0;
    const lapsed = Math.round((value - takenOffIncVat) * 100) / 100;
    await noteGoodwill(g, `🎟️ Voucher ${creditCode(g)} used at the shop till${saleRef ? ` (${saleRef})` : ''}: £${takenOffIncVat.toFixed(2)} off.${lapsed >= 0.01 ? ` The other £${lapsed.toFixed(2)} lapses.` : ''}`,
      userId || '00000000-0000-0000-0000-000000000000', []);
  } catch (err) {
    console.warn('[vouchers] sale note failed:', err);
  }
}

/**
 * The sale it was used on was cancelled or refunded: the voucher is free again (to its
 * own use-by date — an expired one reads as expired). Never throws: the refund matters more.
 */
export async function giveVoucherBack(saleId: string, why: string, userId: string | null): Promise<void> {
  try {
    const r = await query(
      `UPDATE goodwill_credits SET status = 'offered', used_amount_ex_vat = NULL, used_at = NULL, used_by = NULL,
              used_how = NULL, used_shop_sale_id = NULL, used_hh_ref = NULL, updated_at = NOW()
        WHERE used_shop_sale_id = $1 AND status = 'used' RETURNING id`,
      [saleId],
    );
    for (const row of r.rows) {
      const g = await getGoodwillCredit(row.id);
      if (g) await noteGoodwill(g, `🎟️ Voucher ${creditCode(g)} is usable again — the sale it was used on was ${why}. ${creditValueText(g)}, use by ${day(g.expires_on)}.`,
        userId || '00000000-0000-0000-0000-000000000000', []);
    }
  } catch (err) {
    console.error(`[vouchers] giving the voucher back from sale ${saleId} failed (do it by hand):`, err);
  }
}
