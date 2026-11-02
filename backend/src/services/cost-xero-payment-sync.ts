/**
 * Bill payment PULL-BACK sync — "it was paid in Xero, OP never found out".
 *
 * The return leg of the bills loop. OP pushes an AUTHORISED ACCPAY bill to Xero
 * on approval, and normally OP is also where it gets marked paid (which records
 * the payment in Xero). But money moves the other way round all the time: the
 * bookkeeper pays the bill in Xero, or reconciles a bank-feed line against it,
 * and OP is never told. The bill then sits on Bills to Pay forever, and the only
 * button there — Mark paid — would record a SECOND payment in Xero.
 *
 * So: ask Xero. Daily, for every unpaid OP bill that has a bill in Xero, read
 * the invoice back; if Xero says it's PAID, mark it paid here using XERO'S OWN
 * payment (its PaymentID and date). Writing the real `xero_payment_id` is what
 * permanently disarms the double-pay path — every push guard reads it.
 *
 * This is the counterpart of cost-xero-reconcile-sync.ts, which closes the same
 * loop for spend-money (card) costs. That one asks "has the bank line been
 * reconciled?"; this one asks "has the bill been paid?".
 *
 * Xero usage: one GET per chunk of 15 candidates (OR'd InvoiceID filter), so a
 * typical day is 1-3 calls.
 *
 * Deliberately left alone:
 *   - PART-paid bills (AmountDue > 0). We'd have to invent a part-payment model
 *     and the bill genuinely is still owed, so it stays on the list.
 *   - VOIDED / DELETED bills in Xero. A bill OP thinks is payable and Xero has
 *     thrown away is a real discrepancy — hiding it behind an auto-mark would
 *     make it invisible. It stays visible, exactly as before this sync existed.
 */
import { query } from '../config/database';
import { isXeroConfigured } from '../config/xero';
import { xeroBroker } from './xero-broker';
import { BILL_METHODS, withCostPushLock } from './cost-xero-push';

const CHUNK_SIZE = 15;

interface Candidate {
  id: string;
  xero_object_id: string;
  amount_gross: string | number | null;
  supplier_name: string | null;
}

interface XeroPaymentLite {
  PaymentID?: string;
  Date?: string;
  Amount?: number | string;
}

interface XeroInvoiceLite {
  InvoiceID?: string;
  Status?: string;
  AmountDue?: number | string;
  AmountPaid?: number | string;
  Payments?: XeroPaymentLite[];
}

/**
 * Xero's accounting API returns dates as `/Date(1518685950940+0000)/`, not ISO.
 * Handle both shapes — a plain ISO string comes back from some endpoints and
 * would otherwise parse to nothing. Returns YYYY-MM-DD, or null.
 */
export function xeroDateToISO(v: string | null | undefined): string | null {
  if (!v) return null;
  const ms = /\/Date\((-?\d+)/.exec(v);
  if (ms) {
    const d = new Date(Number(ms[1]));
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

const pence = (v: unknown) => Math.round((Number(v) || 0) * 100);

/** Fully paid in Xero? PAID status and nothing left owing. */
function isSettledInXero(inv: XeroInvoiceLite): boolean {
  if (String(inv.Status || '').toUpperCase() !== 'PAID') return false;
  // AmountDue is absent on some responses; a PAID status with no figure is paid.
  return inv.AmountDue === undefined || inv.AmountDue === null || pence(inv.AmountDue) <= 0;
}

/** The payment that settled it — the latest-dated one where there are several. */
function settlingPayment(inv: XeroInvoiceLite): XeroPaymentLite | null {
  const payments = (inv.Payments || []).filter((p) => p.PaymentID);
  if (!payments.length) return null;
  return payments.reduce((latest, p) =>
    (xeroDateToISO(p.Date) || '') >= (xeroDateToISO(latest.Date) || '') ? p : latest);
}

export async function runCostXeroPaymentSync(): Promise<{ checked: number; marked: number }> {
  if (!isXeroConfigured()) return { checked: 0, marked: 0 };

  // Bills only, still outstanding in OP, already in Xero. `xero_object_type` is
  // the authoritative "which Xero entity is this" (migration 209); legacy rows
  // have it null, and for those the bill payment method is a safe stand-in.
  const candidates = await query(
    `SELECT id, xero_object_id, amount_gross, supplier_name
       FROM costs
      WHERE xero_object_id IS NOT NULL
        AND payment_status <> 'paid'
        AND settled_externally = FALSE
        AND payment_method = ANY($1)
        AND COALESCE(xero_object_type, 'invoice') = 'invoice'`,
    [[...BILL_METHODS]],
  );
  const rows = candidates.rows as Candidate[];
  if (rows.length === 0) return { checked: 0, marked: 0 };

  let marked = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const where = chunk.map((c) => `InvoiceID==Guid("${c.xero_object_id}")`).join(' OR ');
    let invoices: XeroInvoiceLite[];
    try {
      invoices = (await xeroBroker.getInvoices(where)) as XeroInvoiceLite[];
    } catch (err) {
      // Xero blip — skip this chunk, tomorrow's run catches up.
      console.error('[cost-xero-payment-sync] Xero fetch failed for chunk:', err instanceof Error ? err.message : err);
      continue;
    }
    const byId = new Map<string, XeroInvoiceLite>();
    for (const inv of invoices) if (inv.InvoiceID) byId.set(inv.InvoiceID, inv);

    for (const c of chunk) {
      const inv = byId.get(c.xero_object_id);
      if (!inv || !isSettledInXero(inv)) continue;
      try {
        if (await markPaidFromXero(c, inv)) marked += 1;
      } catch (err) {
        console.error('[cost-xero-payment-sync] failed to mark cost paid:', c.id, err instanceof Error ? err.message : err);
      }
    }
  }
  return { checked: rows.length, marked };
}

/**
 * Write the "Xero paid it" fact onto the cost.
 *
 * Under the per-cost push lock, and re-reading the row inside it: a push could
 * be recording a genuine OP-side payment at this moment, and marking it paid
 * from under that would leave two payments in Xero with one recorded here.
 */
async function markPaidFromXero(c: Candidate, inv: XeroInvoiceLite): Promise<boolean> {
  return withCostPushLock(c.id, async () => {
    const fresh = await query(
      `SELECT payment_status, approval_state, settled_externally, xero_payment_id
         FROM costs WHERE id = $1`,
      [c.id],
    );
    const row = fresh.rows[0];
    if (!row || row.payment_status === 'paid' || row.settled_externally) return false;

    const payment = settlingPayment(inv);
    const paidDate = xeroDateToISO(payment?.Date ?? null);
    // Paid in Xero with no Payment on it — a credit note or prepayment cleared
    // the bill. There is no payment id to hold, and there must never be a
    // payment leg for it either, so it is flagged settled rather than left in
    // the state that invites one.
    const viaCreditNote = !payment?.PaymentID;

    await query(
      `UPDATE costs
          SET payment_status = 'paid',
              approval_state = 'paid',
              paid_at = NOW(),
              paid_value_date = COALESCE($1::date, CURRENT_DATE),
              xero_payment_id = COALESCE($2, xero_payment_id),
              settled_externally = $3,
              settled_externally_note = COALESCE(settled_externally_note, $4),
              xero_synced_at = NOW(),
              xero_error = NULL
        WHERE id = $5`,
      [
        paidDate,
        payment?.PaymentID ?? null,
        viaCreditNote,
        viaCreditNote ? 'Settled in Xero without a payment (credit note or prepayment)' : null,
        c.id,
      ],
    );

    // `paid_by` is deliberately left NULL — nobody in OP did this. The audit row
    // carries 'xero-sync' as the actor, and the Xero-side figure alongside ours:
    // a bill Xero paid for a different amount than OP holds is a real
    // discrepancy, and the log is where someone can see it after the fact.
    await query(
      `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
       VALUES ($1, 'cost', $2, 'cost_paid_in_xero', $3, $4)`,
      [
        'xero-sync', c.id,
        JSON.stringify({ payment_status: row.payment_status, approval_state: row.approval_state }),
        JSON.stringify({
          payment_status: 'paid',
          paid_value_date: paidDate,
          xero_payment_id: payment?.PaymentID ?? null,
          xero_amount_paid: inv.AmountPaid ?? null,
          op_amount_gross: c.amount_gross,
          amount_matches: pence(inv.AmountPaid) === pence(c.amount_gross),
          settled_externally: viaCreditNote,
        }),
      ],
    ).catch((err) => console.warn('[cost-xero-payment-sync] audit log failed (non-fatal):', (err as Error).message));

    if (inv.AmountPaid !== undefined && pence(inv.AmountPaid) !== pence(c.amount_gross)) {
      console.warn(
        `[cost-xero-payment-sync] amount mismatch on ${c.supplier_name || 'cost'} ${c.id}: `
        + `Xero paid ${inv.AmountPaid}, OP holds ${c.amount_gross}`,
      );
    }
    return true;
  });
}
