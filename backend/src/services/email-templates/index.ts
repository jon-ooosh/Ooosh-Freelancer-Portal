/**
 * Email Template Registry
 *
 * Each template defines:
 * - subject: Subject line template with {{variable}} substitution
 * - body: HTML body template with {{variable}} substitution
 * - variant: 'client' (polished) or 'internal' (simpler)
 * - preheader: Optional email preheader text
 */

export interface EmailTemplate {
  subject: string;
  body: string;
  variant: 'client' | 'internal';
  preheader?: string;
}

const templates: Record<string, EmailTemplate> = {

  // ── Client-facing templates ────────────────────────────────────────────

  booking_confirmation: {
    variant: 'client',
    preheader: 'Your booking with Ooosh Tours has been confirmed',
    subject: 'Booking Confirmed — {{jobNumber}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Booking Confirmed</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Great news — your booking <strong>{{jobNumber}}</strong> has been confirmed.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Job</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{jobName}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email or call us.
      </p>
    `,
  },

  quote_sent: {
    variant: 'client',
    preheader: 'Your quote from Ooosh Tours',
    subject: 'Quote for {{jobName}} — {{jobNumber}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your Quote</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please find below our quote for <strong>{{jobName}}</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Total</p>
            <p style="margin:0;font-size:24px;color:#1e293b;font-weight:700;">{{amount}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        This quote is valid for 30 days. To confirm, just reply to this email.
      </p>
    `,
  },

  // ── Internal / operational templates ───────────────────────────────────

  compliance_reminder: {
    variant: 'internal',
    subject: '{{dueType}} {{urgency}} — {{vehicleReg}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Vehicle Compliance Alert</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        <strong>{{vehicleReg}}</strong> ({{vehicleName}}) has a {{dueType}} {{urgency}}.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">{{dueType}}</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">
              {{daysRemaining}} days remaining
            </p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{vehicleUrl}}" style="color:#f97316;text-decoration:none;font-weight:600;">View vehicle in Ooosh &rarr;</a>
      </p>
    `,
  },

  chase_reminder: {
    variant: 'internal',
    subject: 'Chase Due — {{jobName}} ({{jobNumber}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Chase Reminder</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Job <strong>{{jobNumber}}</strong> — {{jobName}} is due for a follow-up chase.
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#334155;">
        <strong>Client:</strong> {{clientName}}
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        <strong>Last chase:</strong> {{lastChaseDate}}
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#f97316;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `,
  },

  new_enquiry_notification: {
    variant: 'internal',
    subject: 'New Enquiry — {{jobName}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">New Enquiry Received</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        A new enquiry has been created:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
            <p style="margin:0 0 4px;font-size:12px;color:#166534;">{{jobName}}</p>
            <p style="margin:0;font-size:14px;color:#1e293b;">
              {{clientName}} &bull; {{jobDate}}
            </p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#f97316;text-decoration:none;font-weight:600;">View in pipeline &rarr;</a>
      </p>
    `,
  },

  freelancer_assignment: {
    variant: 'internal',
    subject: 'Job Assignment — {{jobName}} ({{jobDate}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">You've Been Assigned</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        You've been assigned to <strong>{{jobName}}</strong> as <strong>{{role}}</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Date</p>
            <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">{{jobDate}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:14px;color:#334155;">
        <strong>Rate:</strong> {{rate}}
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        Please confirm your availability as soon as possible.
      </p>
    `,
  },
  hire_form: {
    variant: 'client' as const,
    preheader: 'Your vehicle hire agreement from Ooosh Tours',
    subject: 'Your vehicle hire agreement for {{vehicleReg}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Vehicle Hire Agreement</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{driverName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please find attached your vehicle hire agreement for your current hire:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Vehicle</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{vehicleReg}} — {{vehicleModel}}</p>
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Hire Period</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{hireStart}} to {{hireEnd}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please retain the attached document for your records.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We hope you have a great tour!
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, please call us on <strong>+44 (0) 1273 911382</strong>
        or email <a href="mailto:info@oooshtours.co.uk" style="color:#f97316;">info@oooshtours.co.uk</a>.
      </p>
    `,
  },

  job_change_notification: {
    variant: 'internal',
    subject: 'Job Update — {{jobName}} ({{jobDate}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Job Details Updated</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        There's been an update to <strong>{{jobName}}</strong> that you're assigned to:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef3c7;border-radius:8px;border:1px solid #fde68a;">
            <p style="margin:0 0 8px;font-size:13px;color:#92400e;font-weight:600;">What changed</p>
            <p style="margin:0;font-size:14px;color:#1e293b;">{{changeDescription}}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Date</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{jobDate}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Venue</p>
            <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">{{venueName}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        Please check the freelancer portal for the latest details.
      </p>
    `,
  },

  referral_alert: {
    variant: 'internal',
    subject: 'Insurer Referral Required — {{driverName}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Insurer Referral Required</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        A driver requires manual referral to insurers before their hire can proceed.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#fff7ed;border-radius:8px;border:1px solid #fed7aa;">
            <p style="margin:0 0 8px;font-size:13px;color:#9a3412;font-weight:600;">Driver</p>
            <p style="margin:0 0 4px;font-size:15px;color:#1e293b;font-weight:600;">{{driverName}}</p>
            <p style="margin:0 0 12px;font-size:13px;color:#64748b;">{{driverEmail}}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#9a3412;font-weight:600;">Referral Reasons</p>
            <p style="margin:0 0 12px;font-size:14px;color:#1e293b;">{{referralReasons}}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#9a3412;font-weight:600;">Linked Jobs</p>
            <p style="margin:0;font-size:14px;color:#1e293b;">{{linkedJobs}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{driverUrl}}" style="color:#f97316;text-decoration:none;font-weight:600;">View driver in Ooosh &rarr;</a>
      </p>
    `,
  },

  // ── Mid-tour driver notification ───────────────────────────────────────

  mid_tour_driver: {
    variant: 'internal',
    preheader: 'A driver has submitted a hire form for a job that is already out',
    subject: 'Mid-tour driver — {{driverName}} on job #{{jobNumber}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#dc2626;">Driver Added Mid-Tour</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{driverName}}</strong> ({{driverEmail}}) has completed their hire form for a job that is <strong>already dispatched / on-hire</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:13px;color:#991b1b;">Job</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">#{{jobNumber}} {{jobName}}</p>
            <p style="margin:8px 0 0;font-size:13px;color:#991b1b;">Vehicle</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{vehicleReg}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;background:#fff7ed;padding:12px;border-radius:6px;border-left:4px solid #f97316;">
        <strong>Action required:</strong> This driver needs processing — their hire form has been linked to the job but they haven't been booked out yet.
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#f97316;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `,
  },

  // ── Excess lifecycle templates ────────────────────────────────────────

  excess_payment_confirmed: {
    variant: 'client',
    preheader: 'Your insurance excess payment has been received',
    subject: 'Insurance Excess Received — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Excess Payment Received</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received your insurance excess payment of <strong>{{amount}}</strong> for your booking <strong>{{jobName}}</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Amount</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{amount}}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;margin-top:8px;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Vehicle</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{vehicleReg}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        This excess is fully refundable after your hire, provided the vehicle is returned in good condition. If you have any questions, just reply to this email.
      </p>
    `,
  },

  excess_preauth_confirmed: {
    variant: 'client',
    preheader: 'Your insurance excess pre-authorisation is confirmed',
    subject: 'Insurance Excess Pre-Authorisation — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Pre-Authorisation Confirmed</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        A pre-authorisation of <strong>{{amount}}</strong> has been placed on your card for your booking <strong>{{jobName}}</strong>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        This is <strong>not a payment</strong> — no money has been taken from your account. The hold will be automatically released after your hire is completed and the vehicle returned in good condition.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email.
      </p>
    `,
  },

  excess_reimbursed: {
    variant: 'client',
    preheader: 'Your insurance excess has been refunded',
    subject: 'Insurance Excess Refund — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Excess Refund</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Your insurance excess of <strong>{{amount}}</strong> for <strong>{{jobName}}</strong> has been refunded via {{method}}.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Please allow 3-5 working days for the refund to appear in your account. If you have any questions, just reply to this email.
      </p>
    `,
  },

  excess_partial_reimbursed: {
    variant: 'client',
    preheader: 'Partial refund of your insurance excess',
    subject: 'Insurance Excess — Partial Refund — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Partial Excess Refund</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{refundAmount}}</strong> of your <strong>{{originalAmount}}</strong> insurance excess for <strong>{{jobName}}</strong> has been refunded via {{method}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{retainedAmount}}</strong> has been retained due to: {{reason}}.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Please allow 3-5 working days for the refund to appear in your account. If you have any questions, just reply to this email.
      </p>
    `,
  },

  excess_claimed: {
    variant: 'client',
    preheader: 'Insurance excess claim notification',
    subject: 'Insurance Excess Claim — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Excess Claim</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We need to let you know that <strong>{{claimAmount}}</strong> of your insurance excess for <strong>{{jobName}}</strong> has been retained due to:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0;font-size:15px;color:#991b1b;">{{reason}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you'd like to discuss this, please reply to this email or call us.
      </p>
    `,
  },

  excess_preauth_released: {
    variant: 'client',
    preheader: 'Your pre-authorisation has been released',
    subject: 'Pre-Authorisation Released — {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Pre-Authorisation Released</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        The pre-authorisation of <strong>{{amount}}</strong> on your card for <strong>{{jobName}}</strong> has been released. No money was taken from your account.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Thanks for hiring with Ooosh Tours — we look forward to seeing you again!
      </p>
    `,
  },
};

export default templates;
