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
        <a href="{{vehicleUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View vehicle in Ooosh &rarr;</a>
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
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
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
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View in pipeline &rarr;</a>
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
        or email <a href="mailto:info@oooshtours.co.uk" style="color:#7B5EA7;">info@oooshtours.co.uk</a>.
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
        <a href="{{driverUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View driver in Ooosh &rarr;</a>
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
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `,
  },

  // ── Payment lifecycle templates ────────────────────────────────────────

  booking_confirmed_deposit: {
    variant: 'client',
    preheader: 'Your booking with Ooosh Tours is confirmed',
    subject: 'Booking Confirmed - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Booking Confirmed</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Thank you for your payment of <strong>{{amount}}</strong> via {{bankName}} for <strong>{{jobName}}</strong>. Your booking is now confirmed.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
            <p style="margin:0 0 4px;font-size:13px;color:#166534;">Dates</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{hireDates}}</p>
            {{balanceSection}}
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `,
  },

  payment_received: {
    variant: 'client',
    preheader: 'Payment received for your booking',
    subject: 'Payment Received - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Payment Received</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We have received your payment of <strong>{{amount}}</strong> via {{bankName}} for <strong>{{jobName}}</strong>.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        {{statusMessage}}
      </p>
      <p style="margin:16px 0 0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `,
  },

  // ── Excess lifecycle templates ────────────────────────────────────────

  excess_payment_confirmed: {
    variant: 'client',
    preheader: 'Your insurance excess payment has been received',
    subject: 'Insurance Excess Received - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Insurance Excess Received</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We have received your insurance excess payment of <strong>{{amount}}</strong> for job <strong>#{{jobNumber}}</strong>{{hireStart}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        All being well on return, we aim to reimburse your excess within ten days of the end of your hire{{hireEnd}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        {{reimbursementMethod}}
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Full details of our vehicle hire terms can be found <a href="https://www.oooshtours.co.uk/files/Ooosh_vehicle_hire_terms.pdf" style="color:#7B5EA7;text-decoration:none;font-weight:600;">here</a>.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        We hope you have a great hire!
      </p>
    `,
  },

  excess_preauth_confirmed: {
    variant: 'client',
    preheader: 'Your insurance excess pre-authorisation is confirmed',
    subject: 'Insurance Excess Pre-Authorisation - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Pre-Authorisation Confirmed</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        A pre-authorisation of <strong>{{amount}}</strong> has been placed on your card for job <strong>#{{jobNumber}}</strong>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        This is <strong>not a payment</strong>. No money has been taken from your account. The hold will be automatically released after your hire is completed and the vehicle returned according to our <a href="https://www.oooshtours.co.uk/files/Ooosh_vehicle_hire_terms.pdf" style="color:#7B5EA7;text-decoration:none;font-weight:600;">T&amp;Cs</a>.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `,
  },

  excess_reimbursed: {
    variant: 'client',
    preheader: 'Your insurance excess has been refunded',
    subject: 'Insurance Excess Refund - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Insurance Excess Refund</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We have reimbursed your insurance excess of <strong>{{amount}}</strong> for job <strong>#{{jobNumber}}</strong>{{hireEnd}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        {{refundTimescale}}
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please note that these timescales are approximate and may vary by bank and financial institution.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Your VAT invoice for the hire will follow shortly if not already sent. We hope you had a great hire and we look forward to seeing you again soon!
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Best,<br/>Jon Wood
      </p>
    `,
  },

  excess_partial_reimbursed: {
    variant: 'client',
    preheader: 'Your insurance excess has been partially refunded',
    subject: 'Insurance Excess - Partial Refund - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Insurance Excess - Partial Refund</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We have reimbursed <strong>{{refundAmount}}</strong> of your <strong>{{originalAmount}}</strong> insurance excess for job <strong>#{{jobNumber}}</strong>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{retainedAmount}}</strong> has been retained. {{reason}}
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        {{refundTimescale}}
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you would like to discuss this, please reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `,
  },

  excess_claimed: {
    variant: 'client',
    preheader: 'Insurance excess claim notification',
    subject: 'Insurance Excess Claim - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Insurance Excess Claim</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We need to let you know that <strong>{{claimAmount}}</strong> of your insurance excess for job <strong>#{{jobNumber}}</strong> has been retained.
      </p>
      {{reasonSection}}
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        If you would like to discuss this, please reply to this email or call us on <strong>+44 (0) 1273 911382</strong>.
      </p>
    `,
  },

  excess_preauth_released: {
    variant: 'client',
    preheader: 'Your pre-authorisation has been released',
    subject: 'Pre-Authorisation Released - {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Pre-Authorisation Released</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        The pre-authorisation of <strong>{{amount}}</strong> on your card for job <strong>#{{jobNumber}}</strong> has been released. No money was taken from your account.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Thanks for hiring with Ooosh Tours. We look forward to seeing you again!
      </p>
    `,
  },

  // ── Internal alerts ──────────────────────────────────────────────────

  last_minute_booking: {
    variant: 'internal',
    preheader: 'A booking has been confirmed at short notice',
    subject: '{{urgencyEmoji}} {{urgencyLabel}}: Job {{jobNumber}} for {{clientName}} - starts {{startDate}}',
    body: `
      <div style="background-color:#7B5EA7;border-radius:12px 12px 0 0;padding:24px 20px;text-align:center;">
        <h2 style="margin:0 0 4px;font-size:22px;color:#ffffff;font-weight:800;">Last-Minute Booking</h2>
        <p style="margin:0;font-size:15px;color:#ffffff;opacity:0.9;">{{urgencyBadge}}</p>
      </div>
      <div style="padding:20px;">
        <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
          Heads up! Job <strong>{{jobNumber}}</strong> for <strong>{{clientName}}</strong> has just been confirmed, starting on <strong>{{startDate}}</strong>.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
          <tr>
            <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Job</p>
              <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{jobName}}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Job Number</p>
              <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{jobNumber}}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Client</p>
              <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{clientName}}</p>
              <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Hire Date</p>
              <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{startDate}}</p>
            </td>
          </tr>
        </table>
        <p style="margin:0;font-size:14px;color:#334155;text-align:center;">
          <a href="{{jobUrl}}" style="display:inline-block;padding:10px 24px;background-color:#4f46e5;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">View in Ooosh</a>
        </p>
        <p style="margin:16px 0 0;font-size:12px;color:#94a3b8;text-align:center;">(This is an automated alert.)</p>
      </div>
    `,
  },
};

export default templates;
