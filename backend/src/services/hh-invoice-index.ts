/**
 * hh-invoice-index.ts — which job does a HireHop invoice number belong to?
 *
 * HireHop has no "find invoice by number" call, so the Wise matcher used to open
 * the billing of 80 jobs looking for "OT-INV-12347" — and picked the 80 with the
 * latest start dates (next year's enquiries), so a finished job's invoice was never
 * found (job 16387, 2 Nov 2026). Instead OP keeps the numbers as it reads billing
 * anyway (migration 326, `hh_invoice_index`):
 *
 *   - the Money tab summary (every Money-tab open + the nightly refresh) — the read
 *     it already makes, no extra HireHop call;
 *   - HireHop's invoice.* webhooks (routes/webhooks.ts) — one billing read;
 *   - the Wise matcher's own billing reads (services/wise-incoming.ts).
 *
 * A derived list — HireHop stays the truth. Every write here is best-effort and
 * never throws: a failed index write must not break the Money tab or a webhook.
 */
import { query } from '../config/database';
import { hhBroker } from './hirehop-broker';

export interface BillingInvoice {
  id: number;
  number: string;
  digits: string;
  status: number | null;
  total: number | null;
  owing: number | null;
}

export interface IndexedInvoice {
  hh_invoice_id: number;
  invoice_number: string;
  job_id: string;
  hh_job_number: number;
  owing: number | null;
}

/** "OT-INV-012347" → "12347" — the part a bank reference is matched on. */
export function invoiceDigits(number: string): string {
  return String(number || '').replace(/\D/g, '').replace(/^0+/, '');
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

/** The numbered invoices (kind 1) in a billing_list.php `rows` array. Drafts have no number and are skipped. */
export function invoicesFromBillingRows(rows: unknown): BillingInvoice[] {
  if (!Array.isArray(rows)) return [];
  const out: BillingInvoice[] = [];
  for (const row of rows as any[]) {
    if (parseInt(row?.kind ?? '0') !== 1) continue;
    const data = row.data || {};
    const id = parseInt(data.ID || String(row.id ?? '').replace(/\D/g, '') || '0');
    const number = String(data.NUMBER || '').trim();
    const digits = invoiceDigits(number);
    if (!id || !number || !digits) continue;
    const status = num(data.STATUS ?? row.status);
    out.push({
      id,
      number,
      digits,
      status: status === null ? null : Math.trunc(status),
      total: num(row.debit),
      owing: num(row.owing ?? data.owing),
    });
  }
  return out;
}

/**
 * Replace this job's entries with what its billing shows now. Pass the `rows` of a
 * SUCCESSFUL billing_list.php read only — a non-array is ignored, so a failed read
 * never empties the job's entries.
 */
export async function indexJobInvoices(job: { id: string; hh_job_number: number }, rows: unknown): Promise<void> {
  if (!Array.isArray(rows) || !job.id || !job.hh_job_number) return;
  const invoices = invoicesFromBillingRows(rows);
  try {
    // Invoices deleted in HireHop since the last read
    await query(
      `DELETE FROM hh_invoice_index WHERE job_id = $1 AND NOT (hh_invoice_id = ANY($2::int[]))`,
      [job.id, invoices.map(i => i.id)],
    );
    for (const inv of invoices) {
      await query(
        `INSERT INTO hh_invoice_index
           (hh_invoice_id, invoice_number, invoice_digits, job_id, hh_job_number, status, total, owing, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
         ON CONFLICT (hh_invoice_id) DO UPDATE SET
           invoice_number = EXCLUDED.invoice_number,
           invoice_digits = EXCLUDED.invoice_digits,
           job_id         = EXCLUDED.job_id,
           hh_job_number  = EXCLUDED.hh_job_number,
           status         = EXCLUDED.status,
           total          = EXCLUDED.total,
           owing          = EXCLUDED.owing,
           updated_at     = NOW()`,
        [inv.id, inv.number, inv.digits, job.id, job.hh_job_number, inv.status, inv.total, inv.owing],
      );
    }
  } catch (err) {
    console.warn(`[hh-invoice-index] index write failed for HH#${job.hh_job_number} (non-fatal):`, err instanceof Error ? err.message : err);
  }
}

/**
 * Read one job's billing fresh from HireHop and re-index it (the invoice webhooks).
 * Returns how many numbered invoices it holds, or null when the job isn't in OP or
 * the read failed.
 */
export async function refreshInvoiceIndexForHhJob(hhJobNumber: number): Promise<number | null> {
  try {
    const j = await query(`SELECT id, hh_job_number FROM jobs WHERE hh_job_number = $1 LIMIT 1`, [hhJobNumber]);
    const job = j.rows[0] as { id: string; hh_job_number: number } | undefined;
    if (!job) return null;
    const billing = await hhBroker.get<any>(
      '/php_functions/billing_list.php',
      { main_id: hhJobNumber, type: 1 },
      { priority: 'low', skipCache: true, cacheTTL: 60 },
    );
    const rows = billing.success ? (billing.data as any)?.rows : undefined;
    if (!Array.isArray(rows)) return null;
    await indexJobInvoices(job, rows);
    return invoicesFromBillingRows(rows).length;
  } catch (err) {
    console.warn(`[hh-invoice-index] refresh failed for HH#${hhJobNumber}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** The indexed invoices whose number matches any of these (digits only, e.g. 12347). */
export async function findIndexedInvoices(numbers: number[]): Promise<IndexedInvoice[]> {
  const digits = [...new Set(numbers.map(n => invoiceDigits(String(n))).filter(Boolean))];
  if (digits.length === 0) return [];
  const r = await query(
    `SELECT hh_invoice_id, invoice_number, job_id, hh_job_number, owing
       FROM hh_invoice_index
      WHERE invoice_digits = ANY($1::text[])`,
    [digits],
  );
  return r.rows.map((x: any) => ({
    hh_invoice_id: x.hh_invoice_id,
    invoice_number: x.invoice_number,
    job_id: x.job_id,
    hh_job_number: x.hh_job_number,
    owing: x.owing === null ? null : parseFloat(x.owing),
  }));
}
