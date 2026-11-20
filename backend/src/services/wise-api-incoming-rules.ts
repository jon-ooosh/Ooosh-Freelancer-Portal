/**
 * Pure rules for reading money IN from the Wise API (services/wise-api-incoming.ts).
 * No database, no network — tested on their own.
 *
 * Proven on the live business account, 20 Nov 2026 (transfer #2501093374, O I B RE,
 * the payment Wise never emailed about):
 *   - The activity feed lists every movement. Money in is a TRANSFER whose amount is
 *     wrapped as `<positive>+ 2,363.64 GBP</positive>`; money out reads `810 GBP`
 *     ("Sent by …"), a Direct Debit `360 GBP` ("Sent").
 *   - `GET /v1/transfers/{id}` answers for incoming transfers too: it carries the
 *     reference and the amounts, and `sourceAccount` is null on money in (it did not
 *     come from one of our balances) but set on money we sent.
 *   - Wise's `status` on an incoming transfer reads "outgoing_payment_sent" — it is the
 *     SENDER's view — so it says nothing about direction and is never used for it.
 *
 * Money is taken as IN only when BOTH say so (the activity is positive AND the
 * transfer has no source account) and the two agree on the amount. Anything else is
 * skipped: a missed payment is caught by the email or the queue; a supplier payment
 * recorded as a client payment would not be.
 */
import type { WiseActivity, WiseTransfer } from '../config/wise';
import type { ParsedWisePayment } from './wise-incoming';

export function stripTags(s: string | null | undefined): string {
  return String(s ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

export interface ActivityAmount {
  /** Wise marked it positive AND it reads "+ …" — money in. */
  incoming: boolean;
  amount: number | null;
  currency: string | null;
}

/** `<positive>+ 2,363.64 GBP</positive>` → in, 2363.64, GBP. `810 GBP` → not in. */
export function readActivityAmount(raw: string | null | undefined): ActivityAmount {
  const s = String(raw ?? '');
  const positive = /<positive>/i.test(s);
  const m = stripTags(s).match(/^([+-])?\s*([\d,]+(?:\.\d+)?)\s*([A-Z]{3})\b/);
  if (!m) return { incoming: false, amount: null, currency: null };
  const amount = parseFloat(m[2].replace(/,/g, ''));
  return {
    incoming: positive && m[1] === '+',
    amount: Number.isFinite(amount) ? amount : null,
    currency: m[3],
  };
}

/** A completed transfer INTO the account, by the activity alone (the first of the two checks). */
export function isIncomingTransferActivity(a: WiseActivity | null | undefined): boolean {
  if (!a) return false;
  return a.type === 'TRANSFER'
    && a.resource?.type === 'TRANSFER'
    && /^\d+$/.test(String(a.resource?.id ?? ''))
    && a.status === 'COMPLETED'
    && readActivityAmount(a.primaryAmount).incoming;
}

/** Wise's transfer `created` ("2026-11-17 16:35:13") is UTC with no zone marker. */
export function parseWiseTransferCreated(created: string | null | undefined): Date | null {
  if (!created) return null;
  const s = String(created).trim();
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s.replace(' ', 'T') : `${s.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pence = (n: number) => Math.round(n * 100);

export type IncomingCheck =
  | { ok: true; parsed: ParsedWisePayment; receivedAt: Date }
  | { ok: false; reason: string };

/**
 * Turn an activity + its transfer into the same shape the "Money received" email
 * parser produces, or say why not. Amount is what the client SENT (`sourceValue`,
 * jon's rule — Xero owns any fee); what landed (`targetValue`) is kept alongside.
 */
export function toIncomingPayment(a: WiseActivity, t: WiseTransfer | null | undefined): IncomingCheck {
  if (!isIncomingTransferActivity(a)) return { ok: false, reason: 'the activity is not a completed transfer into the account' };
  const number = String(a.resource?.id);
  if (!t || String(t.id) !== number) return { ok: false, reason: `Wise's transfer record is not #${number}` };
  if (!('sourceAccount' in t) || t.sourceAccount === undefined) {
    return { ok: false, reason: `Wise's record of #${number} doesn't say where the money came from` };
  }
  if (t.sourceAccount !== null) {
    return { ok: false, reason: `#${number} came from one of our own Wise balances — money out, not in` };
  }

  const landed = Number(t.targetValue);
  const landedCurrency = String(t.targetCurrency || '').toUpperCase();
  if (!Number.isFinite(landed) || landed <= 0 || !landedCurrency) {
    return { ok: false, reason: `Wise's record of #${number} has no amount` };
  }
  const act = readActivityAmount(a.primaryAmount);
  if (act.amount == null || pence(act.amount) !== pence(landed) || act.currency !== landedCurrency) {
    return {
      ok: false,
      reason: `#${number}: the activity says ${act.amount ?? '?'} ${act.currency ?? ''} but the transfer says ${landed} ${landedCurrency}`,
    };
  }

  const sent = Number(t.sourceValue);
  const sentCurrency = String(t.sourceCurrency || '').toUpperCase();
  const amount = Number.isFinite(sent) && sent > 0 ? sent : landed;
  const currency = sentCurrency || landedCurrency;
  const fee = currency === landedCurrency && pence(amount) > pence(landed)
    ? (pence(amount) - pence(landed)) / 100 : null;

  const receivedAt = (a.createdOn ? new Date(a.createdOn) : null);
  const when = receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : parseWiseTransferCreated(t.created);
  if (!when) return { ok: false, reason: `Wise doesn't say when #${number} arrived` };

  const reference = String(t.details?.reference ?? t.reference ?? '').trim();
  const payerName = stripTags(a.title);
  return {
    ok: true,
    receivedAt: when,
    parsed: {
      payerName: payerName ? payerName.slice(0, 200) : null,
      amount,
      currency,
      fee,
      amountCredited: landed,
      reference: reference ? reference.slice(0, 500) : null,
      transferNumber: number,
    },
  };
}

/** Same payer, ignoring spacing and company endings ("O I B RE LTD SW" = "OIB RE LTD SW"). */
export function samePayer(a: string | null | undefined, b: string | null | undefined, normalise: (s: string | null | undefined) => string): boolean {
  const x = normalise(a).replace(/ /g, '');
  const y = normalise(b).replace(/ /g, '');
  return x.length > 0 && x === y;
}
