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
};

export default templates;
