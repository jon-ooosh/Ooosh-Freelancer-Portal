/**
 * Vouchers — the pure part (docs/GOODWILL-CREDIT-SPEC.md §16). Codes, VAT, and how a
 * voucher is spread across a shop basket. No database here, so it can be tested alone.
 *
 * A voucher is a goodwill credit with a code. Its GW ref is sequential (GW-0013), so
 * anyone could guess one; the code is what the client is given and is 12 random
 * characters from an alphabet with no look-alikes — 31^12 ≈ 8×10^17, about 60 bits.
 * Only staff look a code up, it works once, so guessing is hopeless. It is a secret
 * like a gift-card number, not a password: OP keeps it as it is (a hash would stop
 * staff ever seeing the code again, and they need to hand it out).
 */
import { randomInt } from 'crypto';

// No 0/O, 1/I/L — read off a screen or a phone, typed by staff.
export const VOUCHER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LEN = 4;

/** 'K7QM-4XWP-C9TR'. */
export function makeVoucherCode(rand: (n: number) => number = randomInt): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let s = '';
    for (let i = 0; i < GROUP_LEN; i++) s += VOUCHER_ALPHABET[rand(VOUCHER_ALPHABET.length)];
    groups.push(s);
  }
  return groups.join('-');
}

/**
 * What staff typed → the stored form, or null when it can't be a code. Case, spaces and
 * dashes don't matter ("k7qm 4xwp c9tr" is fine).
 */
export function normaliseVoucherCode(input: string | null | undefined): string | null {
  const raw = String(input || '').toUpperCase().replace(/[\s-]+/g, '');
  if (raw.length !== GROUPS * GROUP_LEN) return null;
  for (const ch of raw) if (!VOUCHER_ALPHABET.includes(ch)) return null;
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) groups.push(raw.slice(g * GROUP_LEN, (g + 1) * GROUP_LEN));
  return groups.join('-');
}

const penny = (n: number) => Math.round(n * 100) / 100;

/** £20 inc VAT → £16.67 ex VAT: what every goodwill sum (and a HireHop discount) works in. */
export function exVatOf(incVat: number): number {
  return penny(incVat / 1.2);
}

/** A shop line as the till prices it (ex-VAT unit price, VAT per line, rounded per line). */
export interface SpreadLine { hhStockId: number; qty: number; unitPrice: number; vatRatePct: number }

/** A line's gross, rounded exactly as shop-sales.ts `priceLines()` does. */
export function lineGross(unitPrice: number, qty: number, vatRatePct: number): number {
  const net = penny(unitPrice * qty);
  return penny(net + penny(net * (vatRatePct / 100)));
}

/**
 * Spread a voucher (an INC-VAT amount) across a basket as lowered unit prices — the till's
 * only kind of discount, pushed to HireHop as the line's price (SHOP-SALES-SPEC §2.8). The
 * dearest line goes first. Never takes off more than the voucher; a few pence can be left
 * over where a quantity doesn't divide (they lapse, like the rest of a single-use voucher).
 * Returns the new unit prices and what came off in all (inc VAT).
 */
export function spreadVoucher(lines: SpreadLine[], voucherIncVat: number): { lines: SpreadLine[]; takenOff: number } {
  let left = penny(voucherIncVat);
  const order = lines.map((l, i) => ({ l, i, g: lineGross(l.unitPrice, l.qty, l.vatRatePct) }))
    .sort((a, b) => b.g - a.g);
  const out = lines.map((l) => ({ ...l }));
  for (const { l, i, g } of order) {
    if (left < 0.01 || g <= 0 || l.qty <= 0) continue;
    const target = Math.max(0, g - left);  // the gross we may come down to, no lower
    // The lowest whole-penny unit price whose line gross is still ≥ target.
    let unit = Math.ceil(((target / (1 + l.vatRatePct / 100)) / l.qty) * 100 - 1e-9) / 100;
    unit = Math.min(Math.max(unit, 0), l.unitPrice);
    while (unit < l.unitPrice && lineGross(unit, l.qty, l.vatRatePct) < target - 1e-9) unit = penny(unit + 0.01);
    // VAT is rounded per line, so a penny lower can still land on the target — use it.
    while (unit >= 0.01 && lineGross(penny(unit - 0.01), l.qty, l.vatRatePct) >= target - 1e-9) unit = penny(unit - 0.01);
    const off = penny(g - lineGross(unit, l.qty, l.vatRatePct));
    if (off <= 0) continue;
    out[i].unitPrice = unit;
    left = penny(left - off);
  }
  return { lines: out, takenOff: penny(voucherIncVat - left) };
}
