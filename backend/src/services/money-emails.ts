/**
 * Money Email Helpers - resolves recipients and builds template variables
 * for payment-related emails.
 */
import { query } from '../config/database';
import { emailService } from './email-service';

/** Refund timescale based on payment method */
export function getRefundTimescale(paymentMethod: string): string {
  const timescales: Record<string, string> = {
    worldpay: 'As you paid by card in person, this should take 2 to 3 days to come back.',
    amex: 'As you paid by Amex, this should take 2 to 3 days to come back.',
    stripe_gbp: 'As you paid by card through our online link, this should take 5 to 10 days to come back.',
    wise_bacs: 'As you paid by UK bank transfer, this should be with you within a couple of hours.',
    till_cash: 'As you paid by cash, please contact us to arrange collection of your refund.',
    paypal: 'As you paid by PayPal, this should be instant.',
    lloyds_bank: 'As you paid by bank transfer, this should be with you within 1 to 2 days.',
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
  // Get people associated with the job via job_organisations and direct people links
  const result = await query(
    `SELECT DISTINCT p.email, p.first_name, p.last_name,
       CASE
         WHEN por.role IN ('Tour Manager', 'Manager', 'Accountant', 'Agent') THEN 1
         WHEN por.role = 'General Contact' THEN 2
         ELSE 3
       END AS priority
     FROM people p
     LEFT JOIN person_organisation_roles por ON por.person_id = p.id AND por.status = 'active'
     LEFT JOIN job_organisations jo ON jo.organisation_id = por.organisation_id AND jo.job_id = $1
     WHERE p.email IS NOT NULL AND p.email != ''
       AND (
         jo.job_id IS NOT NULL
         OR p.id IN (SELECT manager1_person_id FROM jobs WHERE id = $1)
         OR p.id IN (SELECT manager2_person_id FROM jobs WHERE id = $1)
       )
     ORDER BY priority ASC, p.first_name ASC
     LIMIT 5`,
    [jobId]
  );

  if (result.rows.length === 0) {
    // Fallback: get client name/email from job itself
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
  return {
    email: row.person_email || row.email || null,
    firstName: row.first_name || row.full_name?.split(' ')[0] || null,
  };
}

/** Send payment confirmation email */
export async function sendPaymentEmail(opts: {
  jobId: string;
  amount: number;
  bankName: string;
  paymentType: string;
  isConfirmingBooking: boolean;
  balanceOutstanding?: number;
  hireDates?: string;
}) {
  const { jobId, amount, bankName, paymentType, isConfirmingBooking, balanceOutstanding, hireDates } = opts;
  const recipients = await getJobEmailRecipients(jobId);
  if (!recipients.primaryEmail) return;

  const templateId = isConfirmingBooking ? 'booking_confirmed_deposit' : 'payment_received';
  const jobResult = await query(
    `SELECT job_name, hh_job_number, job_date, job_end, out_date, return_date FROM jobs WHERE id = $1`,
    [jobId]
  );
  const job = jobResult.rows[0];
  const jobName = job?.job_name || `Job #${job?.hh_job_number || ''}`;

  // Build hire dates string
  let hireDatesStr = hireDates || '';
  if (!hireDatesStr && job) {
    const start = job.job_date || job.out_date;
    const end = job.job_end || job.return_date;
    const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    if (start && end) hireDatesStr = `${fmt(start)} to ${fmt(end)}`;
    else if (start) hireDatesStr = fmt(start);
  }

  const balanceSection = balanceOutstanding && balanceOutstanding > 0
    ? `<p style="margin:8px 0 0;font-size:13px;color:#166534;">Remaining balance</p><p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">&pound;${balanceOutstanding.toFixed(2)}</p>`
    : '';

  const statusMessage = balanceOutstanding != null && balanceOutstanding <= 0
    ? 'Your hire is now fully paid. Thank you!'
    : `Remaining balance: \u00A3${(balanceOutstanding || 0).toFixed(2)}.`;

  await emailService.send(templateId, {
    to: recipients.primaryEmail,
    cc: recipients.ccEmails.length > 0 ? recipients.ccEmails : undefined,
    variables: {
      firstName: recipients.primaryFirstName || 'there',
      amount: `\u00A3${amount.toFixed(2)}`,
      bankName: bankName || 'card',
      jobName,
      hireDates: hireDatesStr,
      balanceSection,
      statusMessage,
    },
  });
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
}) {
  const { templateId, excessId, jobId, amount, paymentMethod, reason, refundAmount, originalAmount, retainedAmount } = opts;

  // Get driver info
  const excessResult = await query(
    `SELECT je.*, vha.driver_id, vha.hire_start, vha.hire_end, d.full_name AS driver_name
     FROM job_excess je
     JOIN vehicle_hire_assignments vha ON vha.id = je.assignment_id
     LEFT JOIN drivers d ON d.id = vha.driver_id
     WHERE je.id = $1`,
    [excessId]
  );
  if (excessResult.rows.length === 0) return;
  const excess = excessResult.rows[0];

  // Get job info
  const jobResult = await query(`SELECT job_name, hh_job_number FROM jobs WHERE id = $1`, [jobId]);
  const job = jobResult.rows[0];
  const jobName = job?.job_name || `Job #${job?.hh_job_number || ''}`;
  const jobNumber = job?.hh_job_number || '';

  // Get driver email from address book
  let driverEmail: string | null = null;
  let driverFirstName: string | null = null;
  if (excess.driver_id) {
    const driver = await getDriverEmail(excess.driver_id);
    driverEmail = driver.email;
    driverFirstName = driver.firstName;
  }

  if (!driverEmail) return;

  // CC the client contact
  const recipients = await getJobEmailRecipients(jobId);
  const ccList = recipients.primaryEmail && recipients.primaryEmail !== driverEmail
    ? [recipients.primaryEmail, ...recipients.ccEmails]
    : recipients.ccEmails;

  const hireStart = excess.hire_start ? new Date(excess.hire_start).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const hireEnd = excess.hire_end ? new Date(excess.hire_end).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';

  const reasonSection = reason
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;"><tr><td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;"><p style="margin:0;font-size:15px;color:#991b1b;">${reason}</p></td></tr></table>`
    : '';

  await emailService.send(templateId, {
    to: driverEmail,
    cc: ccList.length > 0 ? ccList : undefined,
    variables: {
      firstName: driverFirstName || 'there',
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
      claimAmount: `\u00A3${amount.toFixed(2)}`,
    },
  });
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

  const jobUrl = `https://staff.oooshtours.co.uk/jobs/${jobId}`;

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
