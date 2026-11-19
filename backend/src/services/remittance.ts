/**
 * Remittance advice — confirm to a payee that their invoice/expense has been
 * (or will be) paid.
 *
 * Fired optionally from the Bills-to-Pay "mark paid" flow. Scoped deliberately
 * narrow: freelancers (who invoice us and wait) and staff reimbursements are
 * the target cases, with a best-effort supplier-org fallback. The recipient is
 * always resolved for pre-fill but staff confirm/edit the address before send
 * (never send blind). Decoupled from the money action — a bad email can never
 * block or unwind a payment.
 *
 * Not a legal document (unlike an invoice): no PDF, no VAT breakdown, no
 * sequential numbering. A branded email note IS a valid remittance advice.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { ukToday } from './uk-date';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export type RemittanceMode = 'supplier' | 'reimbursement';

export interface RemittanceContact {
  email: string | null;
  name: string | null;
  mode: RemittanceMode;
  /** Where the address came from - drives the modal's pre-fill note. */
  source: 'reimbursement_staff' | 'freelancer_linked' | 'freelancer_assignment' | 'remembered' | 'person_match' | 'supplier_org' | 'none';
}

interface CostForRemittance {
  id: string;
  payment_method: string | null;
  uploaded_by: string | null;
  quote_assignment_id: string | null;
  /** The freelancer a freelancer invoice is linked to (FREELANCER-PORTAL-SPEC §5). */
  person_id?: string | null;
  cost_type?: string | null;
  xero_contact_id: string | null;
  supplier_name: string | null;
  invoice_number?: string | null;
  description?: string | null;
  amount_gross?: string | number | null;
  paid_method?: string | null;
  paid_value_date?: string | Date | null;
  job_id?: string | null;
  payment_status?: string | null;
  cost_date?: string | Date | null;
}

function gbp(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? parseFloat(v) : (v ?? 0);
  return `£${(Number.isFinite(n) ? n : 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Collapse the bank instrument the payment went out from into client-friendly
 * wording. Payees don't care which of our accounts it left — "bank transfer"
 * covers Lloyds + Wise (the overwhelming majority), with cash/PayPal/card for
 * the rest. Defaults to "bank transfer" — the safe common case.
 */
export function remittanceMethodLabel(paidMethod?: string | null): string {
  const m = (paidMethod || '').toLowerCase();
  if (m.includes('paypal')) return 'PayPal';
  if (m.includes('cash') || m === 'petty_cash' || m.includes('till')) return 'cash';
  if (m === 'amex' || m === 'cot_card' || m === 'lloyds_cc' || m.includes('card')) return 'card payment';
  return 'bank transfer';
}

function cleanName(s?: string | null): string | null {
  const t = (s || '').trim();
  return t || null;
}

/**
 * Resolve who a remittance for this cost should go to, and how to word it.
 *  - reimbursement (`reimburse_me`) → the staff member who fronted it
 *  - freelancer invoice → the crew person on the linked quote assignment
 *  - otherwise → best-effort supplier org match (Xero contact id, then name)
 * Always returns a mode; email may be null (staff types it in the modal).
 */
export async function resolveRemittanceContact(cost: CostForRemittance): Promise<RemittanceContact> {
  const isReimburse = cost.payment_method === 'reimburse_me';
  const mode: RemittanceMode = isReimburse ? 'reimbursement' : 'supplier';

  if (isReimburse) {
    if (cost.uploaded_by) {
      const r = await query(
        `SELECT p.email, CONCAT(p.first_name, ' ', p.last_name) AS name
           FROM users u JOIN people p ON p.id = u.person_id
          WHERE u.id = $1`,
        [cost.uploaded_by],
      );
      const row = r.rows[0];
      return { email: cleanName(row?.email), name: cleanName(row?.name), mode, source: 'reimbursement_staff' };
    }
    return { email: null, name: null, mode, source: 'reimbursement_staff' };
  }

  // The freelancer the office linked this invoice to: the surest answer.
  if (cost.person_id) {
    const r = await query(
      `SELECT email, CONCAT(first_name, ' ', last_name) AS name FROM people WHERE id = $1`,
      [cost.person_id],
    );
    const row = r.rows[0];
    if (row?.email) return { email: cleanName(row.email), name: cleanName(row.name), mode, source: 'freelancer_linked' };
  }

  if (cost.quote_assignment_id) {
    const r = await query(
      `SELECT p.email, CONCAT(p.first_name, ' ', p.last_name) AS name
         FROM quote_assignments qa JOIN people p ON p.id = qa.person_id
        WHERE qa.id = $1`,
      [cost.quote_assignment_id],
    );
    const row = r.rows[0];
    if (row?.email) return { email: cleanName(row.email), name: cleanName(row.name), mode, source: 'freelancer_assignment' };
  }

  // Remembered: an address staff manually chose on a previous remittance for
  // this same supplier. An explicit human decision - honour it over guesses.
  if (cost.supplier_name) {
    const r = await query(
      `SELECT remittance_email FROM costs
        WHERE remittance_email IS NOT NULL
          AND LOWER(COALESCE(supplier_name, '')) = LOWER($1)
          AND id <> $2
        ORDER BY remittance_sent_at DESC NULLS LAST
        LIMIT 1`,
      [cost.supplier_name, cost.id],
    );
    const email = cleanName(r.rows[0]?.remittance_email);
    if (email) return { email, name: cleanName(cost.supplier_name), mode, source: 'remembered' };
  }

  // Freelancers are people, not orgs - match the supplier name against the
  // address book (freelancers first). Only auto-fill on a UNIQUE match; the
  // modal's person picker covers ambiguous / no-match cases.
  if (cost.supplier_name) {
    const r = await query(
      `SELECT email, CONCAT(first_name, ' ', last_name) AS name
         FROM people
        WHERE COALESCE(is_deleted, false) = false AND email IS NOT NULL
          AND LOWER(CONCAT(first_name, ' ', last_name)) = LOWER($1)
        ORDER BY is_freelancer DESC
        LIMIT 2`,
      [cost.supplier_name],
    );
    if (r.rows.length === 1 && r.rows[0].email) {
      return { email: cleanName(r.rows[0].email), name: cleanName(r.rows[0].name), mode, source: 'person_match' };
    }
  }

  if (cost.xero_contact_id) {
    const r = await query(
      `SELECT name, email FROM organisations
        WHERE xero_contact_id = $1 AND COALESCE(is_deleted, false) = false AND email IS NOT NULL
        LIMIT 1`,
      [cost.xero_contact_id],
    );
    const row = r.rows[0];
    if (row?.email) return { email: cleanName(row.email), name: cleanName(row.name) || cost.supplier_name || null, mode, source: 'supplier_org' };
  }

  if (cost.supplier_name) {
    const r = await query(
      `SELECT name, email FROM organisations
        WHERE LOWER(name) = LOWER($1) AND COALESCE(is_deleted, false) = false AND email IS NOT NULL
        LIMIT 1`,
      [cost.supplier_name],
    );
    const row = r.rows[0];
    if (row?.email) return { email: cleanName(row.email), name: cleanName(row.name), mode, source: 'supplier_org' };
  }

  return { email: null, name: isReimburse ? null : cleanName(cost.supplier_name), mode, source: 'none' };
}

type LoadedCost = CostForRemittance & { uploaded_by_name: string | null };

/** The fields the resolver + send need, for one cost or several. */
const REMITTANCE_COST_SELECT = `
  SELECT c.id, c.payment_method, c.uploaded_by, c.quote_assignment_id, c.person_id, c.cost_type, c.xero_contact_id,
         c.supplier_name, c.invoice_number, c.description, c.amount_gross,
         c.paid_method, c.paid_value_date, c.job_id, c.payment_status, c.cost_date,
         CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name
    FROM costs c
    LEFT JOIN users u ON u.id = c.uploaded_by
    LEFT JOIN people up ON up.id = u.person_id`;

/** Load the fields the resolver + send need in one go. */
export async function getCostForRemittance(costId: string): Promise<LoadedCost | null> {
  const r = await query(`${REMITTANCE_COST_SELECT} WHERE c.id = $1`, [costId]);
  return r.rows[0] || null;
}

/** The same, for several costs, in the order the ids were given. */
async function getCostsForRemittance(costIds: string[]): Promise<LoadedCost[]> {
  const ids = [...new Set(costIds)].filter(Boolean);
  if (!ids.length) return [];
  const r = await query(`${REMITTANCE_COST_SELECT} WHERE c.id = ANY($1::uuid[])`, [ids]);
  const byId = new Map((r.rows as LoadedCost[]).map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean) as LoadedCost[];
}

/**
 * Who is being paid, as one key — the unit a remittance goes to. A bulk payment
 * run sends ONE email per payee listing every bill paid to them, not one per
 * bill: twenty invoices in one bank transfer is one cover letter, not twenty.
 *  - a reimbursement → the staff member who fronted it
 *  - a bill → its Xero contact, else its supplier name (case and spacing ignored)
 * Two bills from the same garage keyed under different names make two emails:
 * untidy, never wrong.
 */
export function remittancePayeeKey(cost: Pick<CostForRemittance, 'id' | 'payment_method' | 'uploaded_by' | 'xero_contact_id' | 'supplier_name'>): string {
  if (cost.payment_method === 'reimburse_me') return `r:${cost.uploaded_by || cost.id}`;
  if (cost.xero_contact_id) return `x:${cost.xero_contact_id}`;
  const name = (cost.supplier_name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return name ? `n:${name}` : `c:${cost.id}`;
}

export interface RemittanceGroup {
  key: string;
  payee_name: string | null;
  mode: RemittanceMode;
  cost_ids: string[];
  invoices: Array<{ id: string; invoice_number: string | null; description: string | null; amount_gross: number }>;
  total: number;
  /** Pre-fill only — staff confirm or change it before anything is sent. */
  email: string | null;
  source: RemittanceContact['source'];
}

/**
 * The bulk-pay modal's remittance list: the selected bills grouped by payee,
 * each with an address to pre-fill (the first bill in the group that resolves
 * to one). Read-only — nothing is sent from here.
 */
export async function buildRemittanceGroups(costIds: string[]): Promise<RemittanceGroup[]> {
  const costs = await getCostsForRemittance(costIds);
  const groups = new Map<string, RemittanceGroup>();
  for (const cost of costs) {
    const key = remittancePayeeKey(cost);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        payee_name: null,
        mode: cost.payment_method === 'reimburse_me' ? 'reimbursement' : 'supplier',
        cost_ids: [], invoices: [], total: 0, email: null, source: 'none',
      };
      groups.set(key, g);
    }
    const amount = Number(cost.amount_gross) || 0;
    g.cost_ids.push(cost.id);
    g.invoices.push({ id: cost.id, invoice_number: cleanName(cost.invoice_number), description: cleanName(cost.description), amount_gross: amount });
    g.total = Math.round((g.total + amount) * 100) / 100;
    if (!g.email) {
      const contact = await resolveRemittanceContact(cost);
      if (contact.email) { g.email = contact.email; g.source = contact.source; }
      if (!g.payee_name) g.payee_name = contact.name;
    }
    if (!g.payee_name) {
      g.payee_name = g.mode === 'reimbursement' ? cleanName(cost.uploaded_by_name) : cleanName(cost.supplier_name);
    }
  }
  return [...groups.values()];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build the remittance email body. Handles supplier vs reimbursement wording
 *  and past ("has been") vs future ("is scheduled") tense. */
function buildBody(cost: LoadedCost, contact: RemittanceContact, reference?: string | null) {
  const payeeName = contact.name || (contact.mode === 'reimbursement' ? cost.uploaded_by_name : cost.supplier_name) || 'there';
  const firstName = payeeName.trim().split(/\s+/)[0] || 'there';
  const amount = gbp(cost.amount_gross);
  const method = remittanceMethodLabel(cost.paid_method);
  const payIso = cost.paid_value_date ? new Date(cost.paid_value_date).toISOString().slice(0, 10) : null;
  const todayIso = ukToday();
  const isFuture = payIso ? payIso > todayIso : false;
  const payDate = payIso
    ? new Date(`${payIso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : 'the scheduled date';

  const invoiceRef = (cost.invoice_number || '').trim();
  const desc = (cost.description || '').trim();

  let lead: string;
  if (contact.mode === 'reimbursement') {
    const ref = invoiceRef
      ? `expense claim <strong>${escapeHtml(invoiceRef)}</strong>`
      : desc ? `your expense${desc ? ` (${escapeHtml(desc)})` : ''}` : 'your expense';
    const verb = isFuture ? 'is scheduled to be reimbursed' : 'has been reimbursed';
    lead = `This is to confirm that ${ref} for <strong>${amount}</strong> ${verb} on <strong>${payDate}</strong> by ${escapeHtml(method)}.`;
  } else {
    const ref = invoiceRef
      ? `your invoice <strong>${escapeHtml(invoiceRef)}</strong>`
      : desc ? `your invoice${desc ? ` (${escapeHtml(desc)})` : ''}` : 'your invoice';
    const verb = isFuture ? 'is scheduled to be paid' : 'has been paid';
    lead = `This is to confirm that ${ref} for <strong>${amount}</strong> ${verb} on <strong>${payDate}</strong> by ${escapeHtml(method)}.`;
  }

  const scheduledNote = isFuture
    ? `<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">Please allow a little time for the payment to clear into your account after that date.</p>`
    : '';
  const referenceNote = referenceLine(reference);

  const subject = contact.mode === 'reimbursement'
    ? `Remittance advice - expense reimbursement ${amount}${invoiceRef ? ` (${invoiceRef})` : ''}`
    : `Remittance advice - ${amount}${invoiceRef ? ` (invoice ${invoiceRef})` : ''}`;

  const multiNote = contact.mode === 'reimbursement'
    ? 'If you have other expenses due back to you, you will receive a separate remittance for each.'
    : 'If you have other invoices with us, you will receive a separate remittance for each.';

  const body = `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Remittance Advice</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${lead}</p>
      ${referenceNote}
      ${scheduledNote}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${multiNote}</p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        No action is needed - this is just for your records. If anything looks wrong, reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `;

  return { subject, body };
}

/** The payment reference, for the payee to match against their bank line. */
function referenceLine(reference?: string | null): string {
  const ref = (reference || '').trim();
  if (!ref) return '';
  return `<p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">Payment reference: <strong>${escapeHtml(ref)}</strong></p>`;
}

function isoDate(v: string | Date | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function longDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Several bills paid to one payee in one payment: one email listing them all,
 * with the total and the payment reference. Same wording rules as buildBody
 * (supplier vs reimbursement, paid vs scheduled).
 */
function buildGroupBody(costs: LoadedCost[], contact: RemittanceContact, reference?: string | null) {
  const first = costs[0];
  const isReimburse = contact.mode === 'reimbursement';
  const payeeName = contact.name || (isReimburse ? first.uploaded_by_name : first.supplier_name) || 'there';
  const firstName = payeeName.trim().split(/\s+/)[0] || 'there';
  const totalPence = costs.reduce((t, c) => t + Math.round((Number(c.amount_gross) || 0) * 100), 0);
  const total = gbp(totalPence / 100);
  const method = remittanceMethodLabel(first.paid_method);
  const noun = isReimburse ? 'expenses' : 'invoices';

  // A bulk payment has one date. Should these ever differ, each line says its own.
  const dates = [...new Set(costs.map((c) => isoDate(c.paid_value_date)).filter(Boolean) as string[])];
  const oneDate = dates.length === 1 ? dates[0] : null;
  const todayIso = ukToday();
  const isFuture = dates.some((d) => d > todayIso);
  const verb = isReimburse
    ? (isFuture ? 'are scheduled to be reimbursed' : 'have been reimbursed')
    : (isFuture ? 'are scheduled to be paid' : 'have been paid');
  const when = oneDate ? ` on <strong>${longDate(oneDate)}</strong>` : '';
  const lead = `This is to confirm that the ${costs.length} ${noun} below, totalling <strong>${total}</strong>, ${verb}${when} by ${escapeHtml(method)}, as one payment.`;

  const cell = 'padding:6px 8px;border-bottom:1px solid #e2e8f0;font-size:14px;color:#334155;';
  const rows = costs.map((c) => {
    const ref = (c.invoice_number || '').trim();
    const desc = (c.description || '').trim();
    const label = ref
      ? escapeHtml(ref)
      : desc ? escapeHtml(desc.length > 60 ? `${desc.slice(0, 57)}...` : desc) : (isReimburse ? 'Expense' : 'Invoice');
    const d = isoDate(c.paid_value_date);
    const dateCell = oneDate ? '' : `<td style="${cell}">${d ? longDate(d) : ''}</td>`;
    return `<tr><td style="${cell}">${label}</td>${dateCell}<td style="${cell}text-align:right;white-space:nowrap;">${gbp(c.amount_gross)}</td></tr>`;
  }).join('');
  const dateHead = oneDate ? '' : `<th style="${cell}text-align:left;">Paid</th>`;
  const table = `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
        <tr><th style="${cell}text-align:left;">${isReimburse ? 'Expense' : 'Invoice'}</th>${dateHead}<th style="${cell}text-align:right;">Amount</th></tr>
        ${rows}
        <tr><td style="${cell}font-weight:bold;" colspan="${oneDate ? 1 : 2}">Total</td><td style="${cell}text-align:right;font-weight:bold;white-space:nowrap;">${total}</td></tr>
      </table>`;

  const scheduledNote = isFuture
    ? `<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">Please allow a little time for the payment to clear into your account after that date.</p>`
    : '';

  const subject = isReimburse
    ? `Remittance advice - expense reimbursement ${total} (${costs.length} expenses)`
    : `Remittance advice - ${total} (${costs.length} invoices)`;

  const body = `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Remittance Advice</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${lead}</p>
      ${table}
      ${referenceLine(reference)}
      ${scheduledNote}
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        No action is needed - this is just for your records. If anything looks wrong, reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `;

  return { subject, body };
}

/**
 * Send a remittance advice for a paid cost to `toEmail`, stamp the tracking
 * columns, and log a job-timeline interaction where the cost has a job. Loud
 * on failure — returns { ok: false, error } and leaves the columns untouched
 * so the caller can surface it and staff can retry.
 */
export async function sendRemittance(costId: string, toEmail: string): Promise<{ ok: boolean; error?: string }> {
  return sendRemittanceForCosts([costId], toEmail);
}

/**
 * One remittance email for one or more PAID bills to the same payee — the
 * single-bill email for one, a listed one for several. Refuses (sends nothing)
 * if any bill isn't paid ("has been paid" would be untrue) or if the bills are
 * for different payees (one email is one payee). Stamps every bill on success.
 */
export async function sendRemittanceForCosts(
  costIds: string[], toEmail: string, reference?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const email = (toEmail || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'A valid recipient email is required' };
  }
  const ids = [...new Set(costIds)].filter(Boolean);
  const costs = await getCostsForRemittance(ids);
  if (!costs.length || costs.length !== ids.length) return { ok: false, error: 'Cost not found' };
  const unpaid = costs.filter((c) => c.payment_status !== 'paid');
  if (unpaid.length) {
    return { ok: false, error: `Not sent - ${unpaid.length === 1 ? 'this bill is' : `${unpaid.length} of these bills are`} not marked paid yet.` };
  }
  if (new Set(costs.map(remittancePayeeKey)).size > 1) {
    return { ok: false, error: 'Not sent - these bills are for different payees.' };
  }

  const cost = costs[0];
  const contact = await resolveRemittanceContact(cost);
  const { subject, body } = costs.length === 1
    ? buildBody(cost, contact, reference)
    : buildGroupBody(costs, contact, reference);

  const result = await emailService.send('remittance_advice', {
    to: email,
    subjectOverride: subject,
    bodyHtmlOverride: body,
  });

  if (!result.success) {
    return { ok: false, error: result.error || 'Email send failed' };
  }

  await query(
    `UPDATE costs SET remittance_sent_at = NOW(), remittance_email = $2, updated_at = NOW() WHERE id = ANY($1::uuid[])`,
    [costs.map((c) => c.id), email.slice(0, 200)],
  );

  // One timeline line per job, however many of its bills were in the email.
  const jobIds = [...new Set(costs.map((c) => c.job_id).filter(Boolean) as string[])];
  for (const jobId of jobIds) {
    try {
      await query(
        `INSERT INTO interactions (job_id, type, content, created_by, source)
         VALUES ($1, 'email', $2, $3, 'system')`,
        [jobId, `📧 Remittance advice sent to ${email}`, SYSTEM_USER_ID],
      );
    } catch (err) {
      console.warn('[remittance] timeline log failed (non-fatal):', err);
    }
  }

  return { ok: true };
}
