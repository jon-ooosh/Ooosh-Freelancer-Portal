/**
 * Money Email Helpers - resolves recipients and builds template variables
 * for payment-related emails.
 */
import { query } from '../config/database';
import { emailService } from './email-service';
import { getFrontendUrl } from '../config/app-urls';

/** Refund timescale based on payment method */
export function getRefundTimescale(paymentMethod: string): string {
  const timescales: Record<string, string> = {
    worldpay: 'As you paid by card in person, this should take 2 to 3 working days to come back.',
    amex: 'As you paid by Amex, this should take 2 to 3 working days to come back.',
    stripe_gbp: 'As you paid by card through our online link, this should take 5 to 10 working days to come back.',
    wise_bacs: 'For UK bank transfers this should be with you within an hour. For international transfers, please allow 1 to 2 working days.',
    till_cash: 'As you paid by cash, please contact us to arrange collection of your refund.',
    paypal: 'As you paid by PayPal, this should be instant.',
    lloyds_bank: 'For UK bank transfers this should be with you within an hour. For international transfers, please allow 1 to 2 working days.',
  };
  return timescales[paymentMethod] || 'Please allow 3 to 5 working days for the refund to appear in your account.';
}

/** Reimbursement method instructions for excess receipt email */
export function getReimbursementMethodText(paymentMethod: string): string {
  if (['wise_bacs', 'lloyds_bank'].includes(paymentMethod)) {
    return 'If you paid by bank transfer, please reply to this email with the bank details you would like the excess reimbursed to. We will need your: account name, sort code, account number, and IBAN/SWIFT/BIC code and bank address if international. Even if we have reimbursed your bank before, please confirm the above details so we have the correct information.';
  }
  if (['worldpay', 'amex', 'stripe_gbp'].includes(paymentMethod)) {
    return 'If you paid by card or PayPal then we already have all the details we need for reimbursement.';
  }
  if (paymentMethod === 'paypal') {
    return 'If you paid by card or PayPal then we already have all the details we need for reimbursement.';
  }
  return 'Please reply to this email to let us know how you would like the excess reimbursed.';
}

/** Get job contacts from OP address book for email recipients */
export async function getJobEmailRecipients(jobId: string): Promise<{
  primaryEmail: string | null;
  primaryFirstName: string | null;
  ccEmails: string[];
}> {
  // First pass: per-job contact selection (migration 086). When staff have
  // explicitly ticked who's on THIS hire via the New Enquiry contact picker,
  // those rows ARE the recipient list — primary becomes the `to`, the rest
  // are CCs. Replaces the org-level lookup entirely when present (the whole
  // point of per-job selection is "Sarah's at this org but THIS hire is Tom").
  // Falls through to the org-level logic below when the job has no
  // job_contacts rows (legacy jobs, HH-synced jobs, anything pre-migration-086).
  const jobContactsResult = await query(
    `SELECT p.email, p.first_name, p.last_name, jc.is_primary
     FROM job_contacts jc
     JOIN people p ON p.id = jc.person_id
     WHERE jc.job_id = $1
       AND p.email IS NOT NULL AND p.email <> ''
       AND p.is_deleted = false
     ORDER BY jc.is_primary DESC, p.first_name ASC`,
    [jobId]
  );
  if (jobContactsResult.rows.length > 0) {
    const primary = jobContactsResult.rows[0];
    const ccEmails = jobContactsResult.rows.slice(1).map((r: any) => r.email).filter(Boolean);
    return {
      primaryEmail: primary.email,
      primaryFirstName: primary.first_name || primary.email?.split('@')[0] || null,
      ccEmails,
    };
  }

  // Get people associated with the job's client organisations.
  // Checks both job_organisations links AND the direct client_id on jobs table.
  // NOTE: manager1_person_id / manager2_person_id are INTERNAL Ooosh staff (account managers),
  // not client contacts — they are NOT included here.
  const result = await query(
    `SELECT DISTINCT p.email, p.first_name, p.last_name,
       CASE
         WHEN por.role IN ('Tour Manager', 'Manager', 'Production Manager', 'Accountant', 'Booking Agent') THEN 1
         WHEN por.role = 'General Contact' THEN 2
         ELSE 3
       END AS priority
     FROM people p
     JOIN person_organisation_roles por ON por.person_id = p.id AND por.status = 'active'
     WHERE p.email IS NOT NULL AND p.email != ''
       AND (
         por.organisation_id IN (SELECT organisation_id FROM job_organisations WHERE job_id = $1)
         OR por.organisation_id = (SELECT client_id FROM jobs WHERE id = $1)
       )
     ORDER BY priority ASC, p.first_name ASC
     LIMIT 5`,
    [jobId]
  );

  if (result.rows.length === 0) {
    // Fallback: try the client organisation's email directly, then any other
    // org linked via job_organisations (client role first, then band/promoter/
    // etc.). Priority keeps the "billed to" org ahead of a band with an email.
    const orgResult = await query(
      `SELECT email, name FROM (
         SELECT o.email, o.name, 1 AS priority
         FROM organisations o
         WHERE o.id = (SELECT client_id FROM jobs WHERE id = $1)
           AND o.email IS NOT NULL AND o.email != ''
         UNION ALL
         SELECT o.email, o.name, 2 AS priority
         FROM organisations o
         JOIN job_organisations jo ON jo.organisation_id = o.id
         WHERE jo.job_id = $1 AND jo.role = 'client'
           AND o.email IS NOT NULL AND o.email != ''
         UNION ALL
         SELECT o.email, o.name, 3 AS priority
         FROM organisations o
         JOIN job_organisations jo ON jo.organisation_id = o.id
         WHERE jo.job_id = $1 AND jo.role <> 'client'
           AND o.email IS NOT NULL AND o.email != ''
       ) candidates
       ORDER BY priority ASC
       LIMIT 1`,
      [jobId]
    );

    if (orgResult.rows.length > 0) {
      const org = orgResult.rows[0];
      return {
        primaryEmail: org.email,
        primaryFirstName: org.name?.split(' ')[0] || null,
        ccEmails: [],
      };
    }

    // Fallback: match jobs.client_name as a plain string against the People
    // table. Covers the HireHop "CLIENT set, COMPANY blank" sole-trader case
    // where no org is created at all (jobs.client_id IS NULL) — e.g. job
    // 15617 "Danny Stevens". Only an exact case-insensitive full-name match
    // with a valid email counts; anything fuzzier would risk routing a
    // stranger's confirmation to the wrong person.
    const clientNameMatch = await query(
      `SELECT p.email, p.first_name
       FROM jobs j
       JOIN people p
         ON p.is_deleted = false
        AND p.first_name IS NOT NULL
        AND p.last_name IS NOT NULL
        AND p.email IS NOT NULL AND p.email <> ''
        AND lower(trim(concat(p.first_name, ' ', p.last_name))) = lower(trim(j.client_name))
       WHERE j.id = $1
       LIMIT 1`,
      [jobId]
    );
    if (clientNameMatch.rows.length > 0) {
      const person = clientNameMatch.rows[0];
      return {
        primaryEmail: person.email,
        primaryFirstName: person.first_name,
        ccEmails: [],
      };
    }

    // Last fallback: no email available
    const jobResult = await query(
      `SELECT client_name, company_name FROM jobs WHERE id = $1`,
      [jobId]
    );
    return { primaryEmail: null, primaryFirstName: jobResult.rows[0]?.client_name?.split(' ')[0] || null, ccEmails: [] };
  }

  const primary = result.rows[0];
  const ccEmails = result.rows.slice(1).map((r: any) => r.email).filter(Boolean);

  return {
    primaryEmail: primary.email,
    primaryFirstName: primary.first_name || primary.email?.split('@')[0] || null,
    ccEmails,
  };
}

/** Resolve an email target for a job, falling back to info@oooshtours.co.uk
 *  when no client contact is reachable via the address book.
 *
 *  Callers get a guaranteed recipient and a flag telling them whether the
 *  message is being redirected. Use `buildFallbackBanner` + `logFallbackToTimeline`
 *  to alert staff and leave an audit trail when `isFallback` is true. */
export async function resolveClientEmailTarget(jobId: string): Promise<{
  primaryEmail: string;
  primaryFirstName: string;
  ccEmails: string[];
  isFallback: boolean;
  clientName: string | null;
  jobNumber: string | null;
  jobName: string | null;
}> {
  const recipients = await getJobEmailRecipients(jobId);
  if (recipients.primaryEmail) {
    return {
      primaryEmail: recipients.primaryEmail,
      primaryFirstName: recipients.primaryFirstName || 'there',
      ccEmails: recipients.ccEmails,
      isFallback: false,
      clientName: null,
      jobNumber: null,
      jobName: null,
    };
  }

  const jobResult = await query(
    `SELECT hh_job_number, job_name, client_name, company_name FROM jobs WHERE id = $1`,
    [jobId]
  );
  const job = jobResult.rows[0];
  return {
    primaryEmail: 'info@oooshtours.co.uk',
    primaryFirstName: 'team',
    ccEmails: [],
    isFallback: true,
    clientName: job?.client_name || job?.company_name || null,
    jobNumber: job?.hh_job_number ? String(job.hh_job_number) : null,
    jobName: job?.job_name || null,
  };
}

/** Build the amber "no client email on file" banner that prepends a fallback email body. */
export function buildFallbackBanner(opts: {
  jobId: string;
  clientName: string | null;
  jobNumber: string | null;
  jobName: string | null;
}): string {
  const frontendUrl = getFrontendUrl();
  const jobUrl = `${frontendUrl}/jobs/${opts.jobId}`;
  const ref = [opts.jobNumber ? `Job #${opts.jobNumber}` : null, opts.jobName]
    .filter(Boolean)
    .join(' — ') || 'this job';
  const client = opts.clientName || 'the client';
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
      <tr>
        <td style="padding:14px 16px;background-color:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
          <p style="margin:0 0 6px;font-size:14px;color:#92400e;font-weight:600;">
            &#9888; No client email on file
          </p>
          <p style="margin:0 0 8px;font-size:13px;color:#78350f;line-height:1.5;">
            This automated message could not be addressed to a specific client contact for <strong>${escapeHtml(client)}</strong> (${escapeHtml(ref)}).
            It has been routed to info@ so the team can forward it manually and update the address book.
          </p>
          <p style="margin:0;font-size:13px;">
            <a href="${jobUrl}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in Ooosh &rarr;</a>
          </p>
        </td>
      </tr>
    </table>
  `;
}

/** Log an `email` interaction on the job's timeline recording that an automated
 *  message was redirected to info@ because no client contact was on file. */
export async function logFallbackToTimeline(opts: {
  jobId: string;
  templateId: string;
  amount?: number;
}): Promise<void> {
  const amountPart = opts.amount != null ? ` Amount: £${opts.amount.toFixed(2)}.` : '';
  const content = `Automated email (${opts.templateId}) could not be addressed — no client email on file. Redirected to info@ so the team can forward manually and update the address book.${amountPart}`;
  try {
    await query(
      `INSERT INTO interactions (type, content, job_id) VALUES ('email', $1, $2)`,
      [content, opts.jobId]
    );
  } catch (err) {
    console.error('[money-emails] Failed to log fallback to timeline:', err instanceof Error ? err.message : err);
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Get driver email from OP address book */
export async function getDriverEmail(driverId: string): Promise<{
  email: string | null;
  firstName: string | null;
}> {
  const result = await query(
    `SELECT d.email, d.full_name, p.email AS person_email, p.first_name
     FROM drivers d
     LEFT JOIN people p ON p.id = d.person_id
     WHERE d.id = $1`,
    [driverId]
  );

  if (result.rows.length === 0) return { email: null, firstName: null };

  const row = result.rows[0];
  // Extract first name, skipping common title prefixes (MR, MRS, MS, MISS, DR, etc.)
  let firstName = row.first_name;
  if (!firstName && row.full_name) {
    const titles = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'lady', 'lord']);
    const parts = row.full_name.trim().split(/\s+/);
    const firstNonTitle = parts.find((p: string) => !titles.has(p.toLowerCase()));
    firstName = firstNonTitle || parts[0];
    // Title-case it (JONATHAN → Jonathan)
    if (firstName && firstName === firstName.toUpperCase()) {
      firstName = firstName.charAt(0) + firstName.slice(1).toLowerCase();
    }
  }
  return {
    email: row.person_email || row.email || null,
    firstName: firstName || null,
  };
}

/** Send payment confirmation email.
 *  Returns a result so callers can distinguish "sent" from silent skips
 *  (e.g. no recipient found in OP address book — common for HH-synced jobs
 *  whose client org has no email and no linked people yet). */
export async function sendPaymentEmail(opts: {
  jobId: string;
  amount: number;
  bankName: string;
  paymentType: string;
  /**
   * MUST reflect "did THIS payment confirm the booking?", not "is the booking
   * currently confirmed?". Subsequent payments on an already-confirmed job
   * are receipts and must use the `payment_received` template — see the
   * matching invariant comment in routes/money.ts.
   */
  isConfirmingBooking: boolean;
}): Promise<{ sent: boolean; reason?: 'no_recipient' | 'error'; error?: string; isFallback?: boolean }> {
  const { jobId, amount, bankName, isConfirmingBooking } = opts;
  const target = await resolveClientEmailTarget(jobId);

  const templateId = isConfirmingBooking ? 'booking_confirmed_deposit' : 'payment_received';
  const jobResult = await query(
    `SELECT job_name, hh_job_number, job_date, job_end, out_date, return_date FROM jobs WHERE id = $1`,
    [jobId]
  );
  const job = jobResult.rows[0];
  const jobName = job?.job_name || `Job #${job?.hh_job_number || ''}`;

  // Hire-dates string used by the booking-confirmation template only.
  let hireDatesStr = '';
  if (job) {
    const start = job.job_date || job.out_date;
    const end = job.job_end || job.return_date;
    const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    if (start && end) hireDatesStr = `${fmt(start)} to ${fmt(end)}`;
    else if (start) hireDatesStr = fmt(start);
  }

  // Payment date = now. The email goes out at the moment we record the
  // payment, so "today" is when the client transacted.
  const paymentDate = new Date().toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  });

  try {
    const res = await emailService.send(templateId, {
      to: target.primaryEmail,
      cc: target.ccEmails.length > 0 ? target.ccEmails : undefined,
      prependBanner: target.isFallback
        ? buildFallbackBanner({
            jobId,
            clientName: target.clientName,
            jobNumber: target.jobNumber,
            jobName: target.jobName,
          })
        : undefined,
      variables: {
        firstName: target.primaryFirstName,
        amount: `\u00A3${amount.toFixed(2)}`,
        bankName: bankName || 'card',
        jobName,
        jobNumber: String(job?.hh_job_number || ''),
        hireDates: hireDatesStr,
        paymentDate,
        // Empty by design — the booking-confirmation template references
        // {{balanceSection}}; we intentionally render nothing rather than
        // invent a balance figure (VAT adjustments make any computed figure
        // misleading without a full HH billing read).
        balanceSection: '',
      },
    });
    if (!res.success) return { sent: false, reason: 'error', error: res.error, isFallback: target.isFallback };
    if (target.isFallback) {
      await logFallbackToTimeline({ jobId, templateId, amount });
    }
    return { sent: true, isFallback: target.isFallback };
  } catch (err) {
    return { sent: false, reason: 'error', error: err instanceof Error ? err.message : String(err), isFallback: target.isFallback };
  }
}

/** Send excess lifecycle email */
export async function sendExcessEmail(opts: {
  templateId: string;
  excessId: string;
  jobId: string;
  amount: number;
  paymentMethod?: string;
  reason?: string;
  refundAmount?: number;
  originalAmount?: number;
  retainedAmount?: number;
  previousJobNumber?: string;
}) {
  const { templateId, excessId, jobId, amount, paymentMethod, reason, refundAmount, originalAmount, retainedAmount, previousJobNumber } = opts;

  // Get excess record + optional driver info (LEFT JOIN — assignment may be NULL for Money tab records)
  const excessResult = await query(
    `SELECT je.*, vha.driver_id, vha.hire_start, vha.hire_end, d.full_name AS driver_name
     FROM job_excess je
     LEFT JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE je.id = $1`,
    [excessId]
  );
  if (excessResult.rows.length === 0) return;
  const excess = excessResult.rows[0];

  // Get job info
  const jobResult = await query(`SELECT job_name, hh_job_number, job_date, job_end, out_date, return_date FROM jobs WHERE id = $1`, [jobId]);
  const job = jobResult.rows[0];
  const jobName = job?.job_name || `Job #${job?.hh_job_number || ''}`;
  const jobNumber = job?.hh_job_number || '';

  // Determine recipient: driver email if available, otherwise job contacts
  let recipientEmail: string | null = null;
  let recipientFirstName: string | null = null;

  if (excess.driver_id) {
    const driver = await getDriverEmail(excess.driver_id);
    recipientEmail = driver.email;
    recipientFirstName = driver.firstName;
  }

  // Fall back to job client contacts if no driver email.
  // If nothing is reachable, resolveClientEmailTarget returns info@ with isFallback=true
  // so the message still lands somewhere and staff get an amber banner + timeline entry.
  const target = await resolveClientEmailTarget(jobId);
  let isFallback = false;
  if (!recipientEmail) {
    recipientEmail = target.primaryEmail;
    recipientFirstName = target.primaryFirstName;
    isFallback = target.isFallback;
  }

  // CC list: include job contacts that aren't the primary recipient (only when not falling back)
  const ccList = isFallback
    ? []
    : [
        ...(target.primaryEmail && target.primaryEmail !== recipientEmail ? [target.primaryEmail] : []),
        ...target.ccEmails,
      ].filter(e => e !== recipientEmail);

  // Format dates — use future tense for payment receipt, past tense for reimbursement
  const fmtDate = (d: any) => d ? new Date(d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const startDate = excess.hire_start || job?.job_date || job?.out_date;
  const endDate = excess.hire_end || job?.job_end || job?.return_date;
  const isReimbursement = templateId.includes('reimburs');
  const hireStart = startDate ? ` that starts on ${fmtDate(startDate)}` : '';
  const hireEnd = endDate ? (isReimbursement ? ` that finished on ${fmtDate(endDate)}` : `, which finishes on ${fmtDate(endDate)}`) : '';

  const reasonSection = reason
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;"><tr><td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;"><p style="margin:0;font-size:15px;color:#991b1b;">${reason}</p></td></tr></table>`
    : '';

  await emailService.send(templateId, {
    to: recipientEmail,
    cc: ccList.length > 0 ? ccList : undefined,
    prependBanner: isFallback
      ? buildFallbackBanner({
          jobId,
          clientName: target.clientName,
          jobNumber: target.jobNumber,
          jobName: target.jobName,
        })
      : undefined,
    variables: {
      firstName: recipientFirstName || 'there',
      amount: `\u00A3${amount.toFixed(2)}`,
      jobName,
      jobNumber: String(jobNumber),
      hireStart,
      hireEnd,
      reimbursementMethod: paymentMethod ? getReimbursementMethodText(paymentMethod) : '',
      refundTimescale: paymentMethod ? getRefundTimescale(paymentMethod) : '',
      refundAmount: refundAmount != null ? `\u00A3${refundAmount.toFixed(2)}` : '',
      originalAmount: originalAmount != null ? `\u00A3${originalAmount.toFixed(2)}` : '',
      retainedAmount: retainedAmount != null ? `\u00A3${retainedAmount.toFixed(2)}` : '',
      reason: reason || '',
      reasonSection,
      previousJobNumber: previousJobNumber || '',
      previousJobRef: previousJobNumber ? ` #${previousJobNumber}` : '',
      claimAmount: `\u00A3${amount.toFixed(2)}`,
    },
  });

  if (isFallback) {
    await logFallbackToTimeline({ jobId, templateId, amount });
  }
}

/** Send last-minute booking alert to info@ */
export async function sendLastMinuteAlert(jobId: string) {
  const jobResult = await query(
    `SELECT job_name, hh_job_number, client_name, company_name, job_date, out_date FROM jobs WHERE id = $1`,
    [jobId]
  );
  if (jobResult.rows.length === 0) return;
  const job = jobResult.rows[0];

  const startDate = job.job_date || job.out_date;
  if (!startDate) return;

  const start = new Date(startDate);
  const now = new Date();
  const daysUntil = Math.ceil((start.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

  // Only alert if within 3 days
  if (daysUntil > 3) return;

  const startFormatted = start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const clientName = job.client_name || job.company_name || 'Unknown client';
  const jobNumber = job.hh_job_number || '';
  const jobName = job.job_name || `Job #${jobNumber}`;

  let urgencyEmoji = '⚡';
  let urgencyLabel = 'Last-minute';
  let urgencyBadge = `In ${daysUntil} day${daysUntil !== 1 ? 's' : ''}`;

  if (daysUntil <= 0) {
    urgencyLabel = 'URGENT: Same-day booking';
    urgencyBadge = 'TODAY';
  } else if (daysUntil === 1) {
    urgencyBadge = 'TOMORROW';
  }

  const jobUrl = `${getFrontendUrl()}/jobs/${jobId}`;

  await emailService.send('last_minute_booking', {
    to: 'info@oooshtours.co.uk',
    variables: {
      urgencyEmoji,
      urgencyLabel,
      urgencyBadge,
      jobNumber: String(jobNumber),
      jobName,
      clientName,
      startDate: startFormatted,
      jobUrl,
    },
  });
}
