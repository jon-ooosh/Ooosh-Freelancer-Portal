/**
 * shop-receipts.ts — the customer's receipt for a till sale, by email.
 *
 * Step 11 of `docs/SHOP-SALES-SPEC.md` (§2.10). A shop sale is already paid, so
 * the customer's document is a VAT RECEIPT — proof of payment — never a second
 * invoice: the weekly HireHop invoice stays the one accounting document, and
 * this never goes near Xero. The accountant confirmed that, Sep 2026.
 *
 * It carries what a simplified VAT invoice needs: our name, address and VAT
 * number — from the client email layout's footer (`email-templates/base.ts`),
 * NOT repeated here, so there is one place those details live — plus the time
 * of supply, what was bought, the VAT rate per line and the total.
 *
 * A refund gets a refund receipt, sent against the reversal row.
 *
 * NOT for "put it on their bill" sales: nothing was paid, and their invoice is
 * the document. Staff till and sitter till (jon, Sep 2026). The sitter till
 * gets a typed box only — band contacts' addresses are never sent to a
 * freelancer's phone. A PDF is parked; the email body is the receipt.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { saleRef } from './shop-sale-ref';
import { tenderLabel } from './shop-tenders';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const money = (n: number) => `£${Math.abs(n).toFixed(2)}`;

interface ReceiptData {
  isRefund: boolean;
  ref: string;                 // the SALE's number — a refund refers to the sale it refunds
  when: string;                // the time of supply (or of the refund)
  tender: string | null;
  lines: Array<{ name: string; qty: number; unitGross: number; vatPct: number; lineGross: number }>;
  net: number;
  vat: number;
  gross: number;
}

/** Load what a receipt needs, or say why there can't be one. */
async function loadReceipt(saleId: string): Promise<ReceiptData> {
  const r = await query(
    `SELECT s.id, s.kind, s.status, s.tender, s.sale_number, s.created_at,
            s.net_amount, s.vat_amount, s.gross_amount, s.reverses_sale_id,
            o.sale_number AS orig_number
       FROM shop_sales s
       LEFT JOIN shop_sales o ON o.id = s.reverses_sale_id
      WHERE s.id = $1`,
    [saleId],
  );
  const s = r.rows[0];
  if (!s) throw new Error('Sale not found.');
  if (s.kind === 'consumption') throw new Error('Stock we used ourselves has no receipt.');
  if (s.status === 'cancelled') throw new Error('That was cancelled — there is nothing to give a receipt for.');
  if (s.tender === 'invoice_later') {
    throw new Error("That went on the band's bill, so nothing was paid — their invoice is the document.");
  }

  const isRefund = s.kind === 'reversal';
  // A refund has no lines of its own: it refunds the whole original sale.
  const linesRes = await query(
    `SELECT name_snapshot, qty, line_net, line_vat, line_gross, vat_rate_pct
       FROM shop_sale_lines WHERE sale_id = $1 ORDER BY created_at`,
    [isRefund ? s.reverses_sale_id : s.id],
  );
  const number = isRefund ? s.orig_number : s.sale_number;
  return {
    isRefund,
    ref: number ? saleRef(Number(number)) : 'shop sale',
    when: new Date(s.created_at).toLocaleString('en-GB', {
      timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }),
    tender: s.tender,
    lines: linesRes.rows.map((l: any) => {
      const qty = Number(l.qty);
      const lineGross = Number(l.line_gross);
      return {
        name: l.name_snapshot,
        qty,
        unitGross: qty ? lineGross / qty : lineGross,
        vatPct: Number(l.vat_rate_pct),
        lineGross,
      };
    }),
    net: Number(s.net_amount),
    vat: Number(s.vat_amount),
    gross: Number(s.gross_amount),
  };
}

/** The email body. Exported for its own tests — the VAT fields are the point. */
export function renderReceiptHtml(d: ReceiptData): string {
  const td = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#1e293b;';
  const tdr = `${td}text-align:right;white-space:nowrap;`;
  const rows = d.lines.map((l) => `<tr>
      <td style="${td}">${esc(l.name)}</td>
      <td style="${tdr}">${l.qty}</td>
      <td style="${tdr}">${money(l.unitGross)}</td>
      <td style="${tdr}">${l.vatPct}%</td>
      <td style="${tdr}">${money(l.lineGross)}</td>
    </tr>`).join('');
  const th = 'padding:6px 8px;border-bottom:2px solid #cbd5e1;font-size:12px;color:#64748b;text-align:left;';
  const thr = `${th}text-align:right;`;
  const sum = (label: string, value: string, strong = false) =>
    `<tr><td colspan="4" style="padding:4px 8px;font-size:13px;color:#475569;text-align:right;${strong ? 'font-weight:700;color:#0f172a;' : ''}">${label}</td>
     <td style="padding:4px 8px;font-size:13px;text-align:right;white-space:nowrap;${strong ? 'font-weight:700;color:#0f172a;' : 'color:#1e293b;'}">${value}</td></tr>`;

  const heading = d.isRefund ? 'Refund receipt' : 'VAT receipt';
  const intro = d.isRefund
    ? `This confirms a refund of <strong>${money(d.gross)}</strong> against receipt <strong>${esc(d.ref)}</strong>.`
    : `Thanks for your purchase. This is your VAT receipt, <strong>${esc(d.ref)}</strong>.`;
  const paidLine = d.isRefund
    ? `Refunded to: ${esc(tenderLabel(d.tender))}`
    : `Paid by: ${esc(tenderLabel(d.tender))}`;

  return `
    <h2 style="margin:0 0 8px;font-size:18px;color:#1e293b;">${heading}</h2>
    <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">${intro}</p>
    <p style="margin:0 0 12px;font-size:13px;color:#475569;">
      ${d.isRefund ? 'Refund' : 'Receipt'} no: <strong>${esc(d.ref)}</strong>${d.isRefund ? ' (refund)' : ''}<br>
      Date and time: ${esc(d.when)}
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 12px;">
      <tr>
        <th style="${th}">Item</th><th style="${thr}">Qty</th><th style="${thr}">Each (inc VAT)</th>
        <th style="${thr}">VAT rate</th><th style="${thr}">Total</th>
      </tr>
      ${rows}
      ${sum('Total excluding VAT', money(d.net))}
      ${sum('VAT', money(d.vat))}
      ${sum(d.isRefund ? 'Total refunded' : 'Total paid', money(d.gross), true)}
    </table>
    <p style="margin:0 0 4px;font-size:13px;color:#475569;">${paidLine}</p>
    <p style="margin:12px 0 0;font-size:12px;color:#64748b;">Our company and VAT registration details are at the foot of this email.</p>
  `;
}

/**
 * Email a receipt (or, for a reversal, a refund receipt). Logged whether it
 * went or not, so "did they get one?" has an answer.
 */
export async function sendShopReceipt(
  saleId: string,
  to: string,
  user: { id: string | null; personId?: string | null },
): Promise<{ sent: boolean; error?: string }> {
  const email = String(to || '').trim();
  if (!EMAIL_RE.test(email)) throw new Error("That doesn't look like an email address.");

  const data = await loadReceipt(saleId);
  const result = await emailService.sendRaw({
    to: email,
    subject: data.isRefund ? `Refund receipt — ${data.ref} — Ooosh Tours` : `Your receipt — ${data.ref} — Ooosh Tours`,
    html: renderReceiptHtml(data),
    variant: 'client',   // the client layout's footer carries our name, address and VAT number
  });

  await query(
    `INSERT INTO shop_receipts (sale_id, sent_to, sent_by, status, error, sent_by_person_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [saleId, email, user.id || null, result.success ? 'sent' : 'failed',
      result.success ? null : (result.error || 'unknown'), user.personId || null],
  );
  return result.success ? { sent: true } : { sent: false, error: result.error || 'The email did not send.' };
}

/**
 * Addresses to suggest for a receipt: where this sale's (or, for a refund, the
 * original sale's) receipts went before, then the job's contacts if it went on
 * a band's job — through THE contact pool, `job-contact-candidates.ts`.
 */
export async function receiptSuggestions(saleId: string): Promise<Array<{ email: string; label: string }>> {
  const r = await query(
    `SELECT s.id, s.reverses_sale_id, COALESCE(s.sold_to_job_id, o.sold_to_job_id) AS job_id
       FROM shop_sales s LEFT JOIN shop_sales o ON o.id = s.reverses_sale_id
      WHERE s.id = $1`,
    [saleId],
  );
  const s = r.rows[0];
  if (!s) return [];
  const out: Array<{ email: string; label: string }> = [];
  const seen = new Set<string>();
  const add = (email: string | null | undefined, label: string) => {
    const e = String(email || '').trim();
    if (!e || seen.has(e.toLowerCase())) return;
    seen.add(e.toLowerCase());
    out.push({ email: e, label });
  };

  const prev = await query(
    `SELECT DISTINCT ON (lower(sent_to)) sent_to FROM shop_receipts
      WHERE sale_id = ANY($1::uuid[]) AND status = 'sent'
      ORDER BY lower(sent_to), sent_at DESC`,
    [[s.id, s.reverses_sale_id].filter(Boolean)],
  );
  for (const p of prev.rows) add(p.sent_to, 'sent before');

  if (s.job_id) out.push(...(await jobReceiptContacts(s.job_id)).filter((c) => !seen.has(c.email.toLowerCase())));
  return out;
}

/** A job's contacts that have an email address — for the checkout's receipt box. */
export async function jobReceiptContacts(jobId: string): Promise<Array<{ email: string; label: string }>> {
  const { resolveJobContactCandidates } = await import('./job-contact-candidates');
  const people = await resolveJobContactCandidates(jobId);
  return people
    .filter((p) => p.email)
    .map((p) => ({ email: String(p.email), label: p.source_org_name ? `${p.name} (${p.source_org_name})` : p.name }));
}
