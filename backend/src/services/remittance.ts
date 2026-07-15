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

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export type RemittanceMode = 'supplier' | 'reimbursement';

export interface RemittanceContact {
  email: string | null;
  name: string | null;
  mode: RemittanceMode;
  /** Where the address came from — drives the modal's pre-fill note. */
  source: 'reimbursement_staff' | 'freelancer_assignment' | 'supplier_org' | 'none';
}

interface CostForRemittance {
  id: string;
  payment_method: string | null;
  uploaded_by: string | null;
  quote_assignment_id: string | null;
  xero_contact_id: string | null;
  supplier_name: string | null;
  invoice_number?: string | null;
  description?: string | null;
  amount_gross?: string | number | null;
  paid_method?: string | null;
  paid_value_date?: string | Date | null;
  job_id?: string | null;
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

/** Load the fields the resolver + send need in one go. */
export async function getCostForRemittance(costId: string): Promise<(CostForRemittance & { uploaded_by_name: string | null }) | null> {
  const r = await query(
    `SELECT c.id, c.payment_method, c.uploaded_by, c.quote_assignment_id, c.xero_contact_id,
            c.supplier_name, c.invoice_number, c.description, c.amount_gross,
            c.paid_method, c.paid_value_date, c.job_id,
            CONCAT(up.first_name, ' ', up.last_name) AS uploaded_by_name
       FROM costs c
       LEFT JOIN users u ON u.id = c.uploaded_by
       LEFT JOIN people up ON up.id = u.person_id
      WHERE c.id = $1`,
    [costId],
  );
  return r.rows[0] || null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Build the remittance email body. Handles supplier vs reimbursement wording
 *  and past ("has been") vs future ("is scheduled") tense. */
function buildBody(cost: CostForRemittance & { uploaded_by_name: string | null }, contact: RemittanceContact) {
  const payeeName = contact.name || (contact.mode === 'reimbursement' ? cost.uploaded_by_name : cost.supplier_name) || 'there';
  const firstName = payeeName.trim().split(/\s+/)[0] || 'there';
  const amount = gbp(cost.amount_gross);
  const method = remittanceMethodLabel(cost.paid_method);
  const payIso = cost.paid_value_date ? new Date(cost.paid_value_date).toISOString().slice(0, 10) : null;
  const todayIso = new Date().toISOString().slice(0, 10);
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

  const subject = contact.mode === 'reimbursement'
    ? `Remittance advice — expense reimbursement ${amount}${invoiceRef ? ` (${invoiceRef})` : ''}`
    : `Remittance advice — ${amount}${invoiceRef ? ` (invoice ${invoiceRef})` : ''}`;

  const body = `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Remittance Advice</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">${lead}</p>
      ${scheduledNote}
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        No action is needed — this is just for your records. If anything looks wrong, reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
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
  const email = (toEmail || '').trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'A valid recipient email is required' };
  }
  const cost = await getCostForRemittance(costId);
  if (!cost) return { ok: false, error: 'Cost not found' };

  const contact = await resolveRemittanceContact(cost);
  const { subject, body } = buildBody(cost, contact);

  const result = await emailService.send('remittance_advice', {
    to: email,
    subjectOverride: subject,
    bodyHtmlOverride: body,
  });

  if (!result.success) {
    return { ok: false, error: result.error || 'Email send failed' };
  }

  await query(
    `UPDATE costs SET remittance_sent_at = NOW(), remittance_email = $2, updated_at = NOW() WHERE id = $1`,
    [costId, email.slice(0, 200)],
  );

  if (cost.job_id) {
    try {
      await query(
        `INSERT INTO interactions (job_id, type, content, created_by, source)
         VALUES ($1, 'email', $2, $3, 'system')`,
        [cost.job_id, `📧 Remittance advice sent to ${email}`, SYSTEM_USER_ID],
      );
    } catch (err) {
      console.warn('[remittance] timeline log failed (non-fatal):', err);
    }
  }

  return { ok: true };
}
