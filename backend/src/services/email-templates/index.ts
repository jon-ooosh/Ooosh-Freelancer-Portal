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

  holding_received: {
    variant: 'client',
    preheader: 'Your items have arrived with us',
    subject: 'Your items have arrived - {{jobName}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your items have arrived</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Just to let you know your delivery for <strong>{{jobName}}</strong>
        (job <strong>#{{jobNumber}}</strong>) has arrived safely with us{{receivedSummary}}.{{#if photoNote}} See the attached photo(s) for details.{{/if}}
        We'll have it ready for your hire.
      </p>
      {{#if itemDescription}}<p style="margin:0 0 16px;padding:12px 14px;background-color:#f8fafc;border-radius:8px;font-size:15px;color:#1e293b;line-height:1.6;"><strong>{{itemDescription}}</strong></p>{{/if}}
      {{#if message}}<p style="margin:0 0 16px;font-size:14px;color:#475569;line-height:1.6;">{{message}}</p>{{/if}}
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any questions, just reply to this email.</p>
    `,
  },

  holding_lost_property_found: {
    variant: 'client',
    preheader: 'We found some lost property after your hire',
    subject: 'Lost property found after your hire{{#if jobNumber}} (#{{jobNumber}}){{/if}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">We found some lost property</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        While {{foundContext}}, we found some lost property - see the attached photo(s) for details.
      </p>
      {{#if itemDescription}}<p style="margin:0 0 16px;padding:12px 14px;background-color:#f8fafc;border-radius:8px;font-size:15px;color:#1e293b;line-height:1.6;"><strong>{{itemDescription}}</strong></p>{{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We can hold lost property for up to 14 days{{#if disposeAfterDate}} (until <strong>{{disposeAfterDate}}</strong>){{/if}}, after which it
        may be disposed of. We're happy to arrange shipping if that's easier - this is usually chargeable.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        To sort out collection or shipping, please get in touch as soon as you can:<br>
        ✉ <a href="mailto:info@oooshtours.co.uk" style="color:#7B5EA7;text-decoration:none;">info@oooshtours.co.uk</a>
        &nbsp;&nbsp;☎ +44 1273 911382
      </p>
      {{#if message}}<p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">{{message}}</p>{{/if}}
    `,
  },

  // ── Lost-property chase ladder (only ever sent via the human-gated review queue) ──
  holding_chase_1: {
    variant: 'client',
    preheader: "We've still got your lost property",
    subject: "We've still got your {{itemDescription}}{{#if jobNumber}} (#{{jobNumber}}){{/if}}",
    body: `
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Just a reminder that we've still got your <strong>{{itemDescription}}</strong> left {{foundPlace}}.
      </p>
      {{#if jobNumber}}<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">This is re job #{{jobNumber}}.</p>{{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've held the item(s){{#if foundDate}} since {{foundDate}}{{/if}}. Please make arrangements to come and collect as soon as you can, or they may be disposed of{{#if disposeAfterDate}} after <strong>{{disposeAfterDate}}</strong>{{else}} in about a week's time{{/if}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you'd rather we disposed of them on your behalf, just let us know. If you'd like us to arrange a delivery, that may be possible - please get in touch.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">Thanks,<br>{{staffName}}<br>Ooosh! Tours Ltd</p>
    `,
  },

  holding_chase_2: {
    variant: 'client',
    preheader: 'Second reminder - please collect your lost property',
    subject: 'Reminder: please collect your {{itemDescription}}{{#if jobNumber}} (#{{jobNumber}}){{/if}}',
    body: `
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        This is a second reminder that we've still got your <strong>{{itemDescription}}</strong> left {{foundPlace}}{{#if foundDate}} on {{foundDate}}{{/if}}.
      </p>
      {{#if jobNumber}}<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">This is re job #{{jobNumber}}.</p>{{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've already held the item(s) for around 14 days, which is the maximum we can usually hold lost property for. Please make arrangements to collect as soon as you can, or they may be disposed of.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you'd rather we disposed of them on your behalf, just let us know. If you'd like us to arrange a delivery, that may be possible - please get in touch.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">Thanks,<br>{{staffName}}<br>Ooosh! Tours Ltd</p>
    `,
  },

  holding_chase_3: {
    variant: 'client',
    preheader: "Final notice - we're going to dispose of your lost property",
    subject: "We're going to dispose of your {{itemDescription}}{{#if jobNumber}} (#{{jobNumber}}){{/if}}",
    body: `
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Despite previous emails, we've still got your <strong>{{itemDescription}}</strong> from {{foundPlace}}.
      </p>
      {{#if jobNumber}}<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">This is re job #{{jobNumber}}.</p>{{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've now held the item(s){{#if foundDate}} since {{foundDate}}{{/if}}, which is more than the maximum we can usually hold lost property for. Please <strong>urgently</strong> make arrangements to collect, or they will be disposed of in the next few days.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you'd rather we disposed of them on your behalf, just let us know. If you'd like us to arrange a delivery, that may still be possible - please contact us as soon as you can.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">Thanks,<br>{{staffName}}<br>Ooosh! Tours Ltd</p>
    `,
  },

  holding_shipped_back: {
    variant: 'client',
    preheader: 'Your items are on their way back to you',
    subject: 'Your items have been sent back{{#if jobNumber}} (#{{jobNumber}}){{/if}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your items are on their way</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've sent your items back to you{{#if itemDescription}} ({{itemDescription}}){{/if}}.
      </p>
      <p style="margin:0 0 16px;padding:12px 14px;background-color:#f8fafc;border-radius:8px;font-size:15px;color:#1e293b;line-height:1.6;">
        <strong>Sent via:</strong> {{returnMethod}}{{#if trackingNumber}}<br><strong>Tracking #:</strong> {{trackingNumber}}{{/if}}
      </p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any questions, just reply to this email.</p>
    `,
  },

  merch_form_request: {
    variant: 'client',
    preheader: 'Sending items to Ooosh ahead of your hire?',
    subject: 'Sending us merch / equipment? - {{jobName}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Sending items to us?</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you're sending merch, instruments or equipment to us ahead of
        <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>), please let us know what's
        coming using the short form below. We'll email you back printable labels to attach to each box —
        <strong>we can't accept items without a label</strong>.
      </p>
      <p style="margin:0 0 24px;">
        <a href="{{formUrl}}" style="display:inline-block;background-color:#7B5EA7;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-size:15px;font-weight:600;">Tell us what you're sending →</a>
      </p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">{{message}}</p>
    `,
  },

  merch_label: {
    variant: 'client',
    preheader: 'Your delivery labels are attached',
    subject: 'Your Ooosh delivery labels - {{jobName}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Your delivery labels</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Hi {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Thanks for letting us know. Your labels for <strong>{{jobName}}</strong>
        (job <strong>#{{jobNumber}}</strong>) are attached as a PDF — please print and attach
        <strong>one per box</strong> ({{boxCount}} expected). Items received without a label may be
        delayed or subject to storage charges.
      </p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
        We'll let you know when your items arrive with us.
      </p>
    `,
  },

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

  /**
   * Pre-hire briefing — internal email to info@ for each confirmed job
   * approaching its hire date. Sender renders the full HTML body via
   * `renderBriefingHtml(briefing)` from email-templates/pre-hire-briefing.ts
   * and passes it as `bodyHtmlOverride` on the send call (bypasses
   * variable substitution which would HTML-escape the rendered HTML).
   * Subject is computed by `buildSubject()` and passed via
   * `subjectOverride`. Template registration here exists for variant +
   * EMAIL_LIVE_TEMPLATES allowlist semantics + audit logging.
   */
  pre_hire_briefing: {
    variant: 'internal',
    subject: 'Pre-Hire Briefing',
    body: `<p>This template should be sent with bodyHtmlOverride. If you're seeing this, the caller forgot.</p>`,
  },

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
    subject: 'New Enquiry — {{jobName}} (#{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">New Enquiry Received</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        A new enquiry has been created (job <strong>#{{jobNumber}}</strong>):
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0;">
            <p style="margin:0 0 4px;font-size:12px;color:#166534;">{{jobName}} (#{{jobNumber}})</p>
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
    subject: 'Job Assignment — {{jobName}} (#{{jobNumber}}) ({{jobDate}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">You've Been Assigned</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        You've been assigned to <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>) as <strong>{{role}}</strong>.
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
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        Please confirm your availability as soon as possible. Latest details
        are always on the freelancer portal:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0;">
        <tr>
          <td style="background-color:#7B5EA7;border-radius:6px;">
            <a href="{{portalUrl}}" style="display:inline-block;padding:10px 20px;font-size:14px;color:#ffffff;text-decoration:none;font-weight:600;">Open in freelancer portal &rarr;</a>
          </td>
        </tr>
      </table>
    `,
  },
  hire_form: {
    variant: 'client' as const,
    preheader: 'Your vehicle hire agreement from Ooosh Tours',
    subject: 'Your vehicle hire agreement for {{vehicleReg}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Vehicle Hire Agreement</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{driverName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please find attached your vehicle hire agreement for your current hire (job <strong>#{{jobNumber}}</strong>):
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
    subject: 'Job Update — {{jobName}} (#{{jobNumber}}) ({{jobDate}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Job Details Updated</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        There's been an update to <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>) that you're assigned to:
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
      <p style="margin:0 0 16px;font-size:14px;color:#334155;">
        For full details, head to the freelancer portal:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0;">
        <tr>
          <td style="background-color:#7B5EA7;border-radius:6px;">
            <a href="{{portalUrl}}" style="display:inline-block;padding:10px 20px;font-size:14px;color:#ffffff;text-decoration:none;font-weight:600;">Open in freelancer portal &rarr;</a>
          </td>
        </tr>
      </table>
    `,
  },

  referral_alert: {
    variant: 'internal',
    subject: 'Insurer Referral Required — {{driverName}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Insurer Referral Required</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        A driver requires manual referral to insurers before their hire can proceed (triggered on job <strong>#{{jobNumber}}</strong>).
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
    subject: 'Booking Confirmed — {{jobName}} (#{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Booking Confirmed</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Thank you for your payment of <strong>{{amount}}</strong> via {{bankName}} for <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>). Your booking is now confirmed.
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
    subject: 'Payment Received — {{jobName}} (#{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Payment Received</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We have received your payment of <strong>{{amount}}</strong> via {{bankName}} on <strong>{{paymentDate}}</strong> for <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>).
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
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

  excess_rolled_over_applied: {
    variant: 'client',
    preheader: 'Your insurance excess has been rolled over to this hire',
    subject: 'Insurance Excess Rolled Over — {{jobName}} (#{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Insurance Excess Rolled Over</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{firstName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've applied <strong>{{amount}}</strong> from your previous hire{{previousJobRef}} to your upcoming hire <strong>#{{jobNumber}}</strong>{{hireStart}}.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        No further action needed — your insurance excess for this hire is covered. No new payment has been taken.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        All being well on return, we aim to reimburse your excess within ten days of the end of your hire{{hireEnd}}, unless you'd like us to roll it over again.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        We hope you have a great hire!
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

  // ── Hire Form emails ──────────────────────────────────────────────────

  hire_form_request: {
    variant: 'client',
    preheader: 'Please complete your driver hire form before your upcoming hire',
    subject: 'Driver hire form for {{jobNumber}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Driver Hire Form</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        You have an upcoming vehicle hire (job <strong>#{{jobNumber}}</strong>) booked through Ooosh Tours, starting <strong>{{startDay}} {{startDate}}</strong>.
      </p>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Each driver must complete and sign a hire agreement, which must be filled out online through the link at the bottom of this email.
      </p>
      <p style="margin:0 0 8px;font-size:15px;color:#334155;line-height:1.6;">
        The form is best completed using a smartphone or tablet, and will ask for the following documents to be uploaded:
      </p>
      <ul style="margin:0 0 16px;padding-left:24px;font-size:15px;color:#334155;line-height:1.8;">
        <li>Front and back of your driving licence</li>
        <li>2 x Proof of addresses dated within past 3 months (Utility/phone bill, bank statement etc) - can be downloaded PDFs or paper copies</li>
      </ul>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        It will also ask for a DVLA Check Code (UK Drivers only). This is obtainable here:
        <a href="https://www.gov.uk/view-driving-licence" style="color:#7B5EA7;text-decoration:none;font-weight:600;">gov.uk/view-driving-licence</a>.<br/>
        Please see our guide on how to use the Gov site here:
        <a href="https://www.oooshtours.co.uk/how-to-get-a-dvla-check-code" style="color:#7B5EA7;text-decoration:none;font-weight:600;">How to get a DVLA check code</a>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Non-UK licence holders will need to upload a photo of their passport instead.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Your hire form link</p>
            <a href="{{hireFormUrl}}" style="display:inline-block;padding:12px 28px;background-color:#7B5EA7;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Complete Hire Form</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you have recently hired through us, you can easily revalidate your documents through the same link.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Any questions or problems, please be in touch.
      </p>
    `,
  },

  hire_form_chase: {
    variant: 'client',
    preheader: 'Reminder: Please complete your driver hire form',
    subject: 'Reminder: Driver hire form for {{jobNumber}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Hire Form Reminder</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        A reminder that you have an upcoming vehicle hire (job <strong>#{{jobNumber}}</strong>) booked through Ooosh Tours, starting <strong>{{startDay}} {{startDate}}</strong> and we haven't yet received any hire forms for you.
      </p>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Each driver must complete and sign a hire agreement, which must be filled out online through the link at the bottom of this email.
      </p>
      <p style="margin:0 0 8px;font-size:15px;color:#334155;line-height:1.6;">
        The form is best completed using a smartphone or tablet, and will ask for the following documents to be uploaded:
      </p>
      <ul style="margin:0 0 16px;padding-left:24px;font-size:15px;color:#334155;line-height:1.8;">
        <li>Front and back of your driving licence</li>
        <li>2 x Proof of addresses dated within past 3 months (Utility/phone bill, bank statement etc) - can be downloaded PDFs or paper copies</li>
      </ul>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        It will also ask for a DVLA Check Code (UK Drivers only). This is obtainable here:
        <a href="https://www.gov.uk/view-driving-licence" style="color:#7B5EA7;text-decoration:none;font-weight:600;">gov.uk/view-driving-licence</a>.<br/>
        Please see our guide on how to use the Gov site here:
        <a href="https://www.oooshtours.co.uk/how-to-get-a-dvla-check-code" style="color:#7B5EA7;text-decoration:none;font-weight:600;">How to get a DVLA check code</a>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Non-UK licence holders will need to upload a photo of their passport instead.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;text-align:center;">
            <p style="margin:0 0 8px;font-size:13px;color:#64748b;">Your hire form link</p>
            <a href="{{hireFormUrl}}" style="display:inline-block;padding:12px 28px;background-color:#7B5EA7;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Complete Hire Form</a>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you have recently hired through us, you can easily revalidate your documents through the same link.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Any questions or problems, please be in touch.
      </p>
    `,
  },

  // ── Cancellation templates ──────────────────────────────────────────────

  job_cancelled_client: {
    variant: 'client',
    preheader: 'Your booking with Ooosh Tours has been cancelled',
    subject: 'Booking Cancelled — {{jobNumber}} {{jobName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Booking Cancelled</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        {{clientIntro}}
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Booking</p>
            <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{jobNumber}} — {{jobName}}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Original dates</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{jobDates}}</p>
          </td>
        </tr>
      </table>
      {{#if refundAmount}}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#ecfdf5;border-radius:8px;border:1px solid #a7f3d0;">
            <p style="margin:0 0 4px;font-size:13px;color:#065f46;">Refund</p>
            <p style="margin:0 0 4px;font-size:18px;color:#065f46;font-weight:700;">£{{refundAmount}}</p>
            <p style="margin:0;font-size:13px;color:#065f46;">To be refunded to you within 10 working days.</p>
          </td>
        </tr>
      </table>
      {{/if}}
      {{#if outstandingBalance}}
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef3c7;border-radius:8px;border:1px solid #fcd34d;">
            <p style="margin:0 0 4px;font-size:13px;color:#92400e;">Outstanding balance</p>
            <p style="margin:0 0 4px;font-size:18px;color:#92400e;font-weight:700;">£{{outstandingBalance}}</p>
            <p style="margin:0;font-size:13px;color:#92400e;">An invoice will follow shortly.</p>
          </td>
        </tr>
      </table>
      {{/if}}
      {{#if showAllSquare}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Your deposit covers the cancellation fee, so no further action is needed on your part.
      </p>
      {{/if}}
      {{#if feeAmount}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        A cancellation fee of £{{feeAmount}} + VAT (£{{feeIncVat}} inc-VAT) applies per our <a href="https://www.oooshtours.co.uk/files/Ooosh_vehicle_hire_terms.pdf" style="color:#7B5EA7;text-decoration:none;font-weight:600;">hire terms</a>.
      </p>
      {{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If you have any questions about the cancellation or would like to rebook, please don't hesitate to get in touch.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Best regards,<br/>Ooosh Tours
      </p>
    `,
  },

  arranging_reminder: {
    variant: 'internal',
    subject: '{{jobTypeLabel}}: {{jobName}} (#{{jobNumber}}) — {{levelHeadline}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">{{levelHeadline}}</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
        Morning,
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
        <strong>{{jobTypeSummary}}</strong> for <strong>{{jobName}}</strong>
        ({{jobLabel}}) on <strong>{{jobDateFormatted}}</strong> is still in
        the "To Be Arranged" column — that's
        <strong>{{daysUntilLabel}}</strong> away and needs picking up.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef3c7;border-radius:8px;border:1px solid #fcd34d;">
            <p style="margin:0 0 4px;font-size:12px;color:#92400e;">Venue</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{venue}}</p>
            <p style="margin:8px 0 0;font-size:12px;color:#92400e;">{{clientLine}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 12px;">
        <a href="{{opLink}}" style="display:inline-block;padding:12px 24px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Open the job</a>
        &nbsp;
        <a href="{{transportOpsLink}}" style="display:inline-block;padding:12px 24px;background-color:#ffffff;color:#7B5EA7;text-decoration:none;border:1px solid #7B5EA7;border-radius:6px;font-weight:600;font-size:15px;">Transport Ops</a>
      </p>
      <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">
        Whoever gets to it first — assign a driver / update the time, address
        and any key points, and move the job out of To Be Arranged. Reminders
        stop automatically once that happens.
      </p>
    `,
  },

  job_cancelled_crew: {
    variant: 'internal',
    subject: 'Job Cancelled — {{jobName}} ({{jobNumber}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Job Cancelled</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{crewName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Unfortunately, job <strong>{{jobName}}</strong> ({{jobNumber}}) has been cancelled.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Dates</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{jobDates}}</p>
            <p style="margin:4px 0 0;font-size:12px;color:#991b1b;">Your role</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{crewRole}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Please do not attend. We apologise for any inconvenience.
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        If you have any questions, please reply to this email.
      </p>
    `,
  },

  // ── Freelancer portal auth ─────────────────────────────────────────────

  portal_verification_code: {
    variant: 'internal',
    subject: 'Your Ooosh freelancer verification code',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Verify your email</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Enter this code on the registration page to verify your email address:
      </p>
      <div style="margin:0 0 20px;padding:20px;text-align:center;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
        <p style="margin:0;font-size:32px;font-weight:700;letter-spacing:6px;color:#7B5EA7;font-family:monospace;">{{code}}</p>
      </div>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.5;">
        This code expires in 15 minutes. If you didn't request this, please ignore.
      </p>
    `,
  },

  portal_password_reset: {
    variant: 'internal',
    subject: 'Reset your Ooosh freelancer password',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Reset your password</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Hi {{freelancerName}},
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        Click the button below to set a new password for your freelancer portal account.
        The link is valid for 1 hour.
      </p>
      <p style="margin:0 0 20px;">
        <a href="{{resetUrl}}" style="display:inline-block;padding:12px 24px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:15px;">Reset password</a>
      </p>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.5;">
        If the button doesn't work, paste this URL into your browser:<br>
        <span style="word-break:break-all;">{{resetUrl}}</span>
      </p>
      <p style="margin:16px 0 0;font-size:13px;color:#64748b;line-height:1.5;">
        Didn't request this? Ignore this email — your password stays unchanged.
      </p>
    `,
  },

  // ── Completion emails (client + staff) ─────────────────────────────────

  delivery_note: {
    variant: 'client',
    preheader: 'Your Ooosh Tours delivery note is attached',
    subject: 'Delivery note — {{jobName}} (#{{jobNumber}}) ({{deliveryDate}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Delivery Complete</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Your Ooosh delivery for <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>) has been completed. Please find your delivery note attached.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Job</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{jobName}} (#{{jobNumber}})</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Venue</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{venueName}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Delivered by</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{driverName}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Completed at</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{completedAt}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        If you spot anything missing or damaged, let us know as soon as possible on
        <a href="mailto:info@oooshtours.co.uk" style="color:#7B5EA7;">info@oooshtours.co.uk</a>
        or call <strong>+44 (0) 1273 911382</strong>.
      </p>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        Have a great show!
      </p>
    `,
  },

  collection_confirmation: {
    variant: 'client',
    preheader: 'Your Ooosh Tours collection is complete',
    subject: 'Collection complete — {{jobName}} (#{{jobNumber}}) ({{completedDate}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Collection Complete</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{clientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Our team has collected your gear from <strong>{{venueName}}</strong> for <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>).
        It's now on its way back to our warehouse.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Job</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{jobName}} (#{{jobNumber}})</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Collected by</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{driverName}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Completed at</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{completedAt}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:15px;color:#334155;line-height:1.6;">
        We'll be in touch if anything needs your attention. Thanks for hiring with Ooosh!
      </p>
    `,
  },

  completion_driver_notes: {
    variant: 'internal',
    subject: 'Driver notes — {{jobName}} (#{{jobNumber}}) ({{completedDate}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Driver notes logged</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        <strong>{{driverName}}</strong> completed <strong>{{jobType}}</strong> for
        <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>) and left notes for the team:
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:14px 16px;background-color:#fef3c7;border-radius:8px;border:1px solid #fde68a;">
            <p style="margin:0;font-size:14px;color:#78350f;line-height:1.6;white-space:pre-wrap;">{{notes}}</p>
          </td>
        </tr>
      </table>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Venue</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{venueName}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Customer present?</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{customerPresent}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Completed at</p>
            <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">{{completedAt}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `,
  },

  // ── Internal ops alerts ────────────────────────────────────────────────

  hire_form_fallback_alert: {
    variant: 'internal',
    subject: '[Hire form fallback] {{operation}} fell back to Monday',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Driver hire form app fell back to Monday.com</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        The standalone driver hire form app tried to use the OP backend for <strong>{{operation}}</strong>
        but errored — it's now serving from Monday.com. Investigate before this becomes a trend.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fee2e2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Operation</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{operation}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Error</p>
            <p style="margin:0 0 8px;font-size:13px;color:#1e293b;font-family:monospace;white-space:pre-wrap;">{{errorMessage}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Driver email</p>
            <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">{{email}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.5;">
        Further identical events in the next hour are suppressed to avoid inbox flooding.
        Check server logs or the hire_form_fallback_events table for full history.
      </p>
    `,
  },

  monday_fallback_alert: {
    variant: 'internal',
    subject: '[Portal fallback] {{operation}} fell back to Monday',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#b91c1c;">Freelancer portal fell back to Monday.com</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        The Next.js freelancer portal tried to use the OP backend for <strong>{{operation}}</strong>
        but errored — it's now serving from Monday.com. Investigate before this becomes a trend.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fee2e2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Operation</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{operation}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Error</p>
            <p style="margin:0 0 8px;font-size:13px;color:#1e293b;font-family:monospace;white-space:pre-wrap;">{{errorMessage}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Freelancer email</p>
            <p style="margin:0;font-size:14px;color:#1e293b;font-weight:600;">{{email}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.5;">
        Further identical events in the next hour are suppressed to avoid inbox flooding.
        Check server logs or the portal_fallback_events table for full history.
      </p>
    `,
  },

  job_cancelled_internal: {
    variant: 'internal',
    subject: 'Cancellation Processed — {{jobName}} ({{jobNumber}})',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Job Cancelled</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        <strong>{{cancelledBy}}</strong> has cancelled job <strong>{{jobName}}</strong> ({{jobNumber}}).
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Reason</p>
            <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{reason}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Cancellation fee</p>
            <p style="margin:0 0 8px;font-size:15px;color:#1e293b;font-weight:600;">{{fee}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Refund due</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{refund}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View job in Ooosh &rarr;</a>
      </p>
    `,
  },

  platform_issue_reported: {
    variant: 'internal',
    subject: '[OP Issue] {{severityLabel}}{{categoryLabel}}: {{title}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">New Issue Logged</h2>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.5;">
        <strong>{{reporterName}}</strong> has logged a new issue on the Operations Platform.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Title</p>
            <p style="margin:0 0 12px;font-size:15px;color:#1e293b;font-weight:600;">{{title}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Category / Severity</p>
            <p style="margin:0 0 12px;font-size:14px;color:#1e293b;">{{categoryLabel}} &bull; {{severityLabel}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Area</p>
            <p style="margin:0 0 12px;font-size:14px;color:#1e293b;">{{area}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Page / Context</p>
            <p style="margin:0 0 12px;font-size:13px;color:#1e293b;word-break:break-all;">{{pageUrl}}</p>
            <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Description</p>
            <p style="margin:0;font-size:14px;color:#1e293b;line-height:1.5;white-space:pre-wrap;">{{description}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{issueUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">View issue in Ooosh &rarr;</a>
      </p>
    `,
  },

  job_returned_vans_still_out: {
    variant: 'internal',
    subject: 'Job #{{jobNumber}} marked Returned — {{vanCount}} van(s) still booked out',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Job marked Returned — vans still booked out</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Job <strong>#{{jobNumber}}</strong> ({{jobName}}) has just flipped to <strong>Returned</strong>,
        but {{vanCount}} vehicle hire assignment(s) are still <strong>booked out</strong> in the OP.
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.5;">
        Either the vans still need physically checking in, or the job's status was flipped too early.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:12px;color:#991b1b;">Still booked out</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{vanList}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 12px;font-size:13px;color:#64748b;">
        Triggered by: {{triggerSource}}
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in Ooosh &rarr;</a>
      </p>
    `,
  },

  // ── Out-of-hours return ───────────────────────────────────────────────
  // Sent at book-out (or ad-hoc later) when the driver has indicated they
  // intend to return the van outside our usual office hours. Includes the
  // gate code, yard address/photos, and a link to the parking-confirmation
  // form (which dual-purposes as both "tell us where you parked it if the
  // yard is full" and as the receipt of return).

  ooh_return_info: {
    variant: 'client',
    preheader: 'Returning your van out of hours — gate code and instructions inside',
    subject: 'Out-of-hours van return — {{vehicleReg}} ({{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Returning your van overnight</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{driverName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Hope you have a great trip in <strong>{{vehicleReg}}</strong>.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        You've told us you may be returning <strong>outside our office hours</strong> (we close at 5pm
        and reopen at 9am). Please follow the instructions below — you may want to pin this email
        or pop a reminder in your calendar. We'll also send you a reminder the day before, with a
        one-tap link to confirm where you've parked.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Yard gate code</p>
            <p style="margin:0;font-size:28px;color:#1e293b;font-weight:700;letter-spacing:2px;font-family:monospace;">{{gateCode}}</p>
            <p style="margin:8px 0 0;font-size:13px;color:#64748b;">Yard: {{yardAddress}}</p>
            {{#if yardMapsUrl}}<p style="margin:8px 0 0;font-size:13px;"><a href="{{yardMapsUrl}}" style="color:#7B5EA7;text-decoration:none;">Open in Google Maps →</a></p>{{/if}}
            {{#if what3words}}<p style="margin:4px 0 0;font-size:13px;color:#64748b;">what3words: <strong>{{what3words}}</strong></p>{{/if}}
          </td>
        </tr>
      </table>

      <h3 style="margin:24px 0 8px;font-size:16px;color:#1e293b;">When you arrive</h3>
      <ul style="margin:0 0 16px;padding-left:20px;font-size:14px;color:#334155;line-height:1.7;">
        <li>Let yourself into the yard — line up the padlock numbers and pull the black knob to open.</li>
        <li>Drive as far in to the yard as possible and as far over to the left as you can. Leave room for other vehicles to enter behind you.</li>
        <li>Double-check you haven't left anything in the van.</li>
        <li>Close all windows / sunroofs and lock all doors.</li>
        <li>Close the gates behind you and refit the padlock through the gate chain. Roll the numbers to scramble the code.</li>
      </ul>

      <h3 style="margin:24px 0 8px;font-size:16px;color:#1e293b;">Where the key drop is</h3>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        Once the van is parked, place the keys in the secure key drop under the first window on our building.
        <strong>Do not</strong> put the keys through the letterbox on the glass door.
      </p>
      {{#if keydropPhotoUrl}}<p style="margin:0 0 16px;"><a href="{{keydropPhotoUrl}}" style="color:#7B5EA7;text-decoration:none;font-size:14px;">View photo of the key drop →</a></p>{{/if}}

      <h3 style="margin:24px 0 8px;font-size:16px;color:#1e293b;">If the yard is full</h3>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        Please <strong>do not</strong> park outside our gates, in front of our neighbour's gates, or
        on any double-yellow lines. Parking illegally or inconsiderately may incur additional costs.
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        The nearest safe legal parking is usually the seafront.
      </p>
      <p style="margin:0 0 16px;font-size:14px;color:#334155;line-height:1.6;">
        <strong>Wherever you park, please tell us where</strong> using the link below — it pre-fills
        the van's GPS location, you just confirm or drag the marker to where you actually parked.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td align="center" style="padding:8px;">
            <a href="{{parkingFormUrl}}" style="display:inline-block;padding:14px 28px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
              Confirm parking location →
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 12px;font-size:13px;color:#64748b;line-height:1.6;">
        Remember: the out-of-hours return facility is offered as a courtesy by pre-arrangement.
        You remain legally responsible for the vehicle until we open and check it in
        (usually the next working day).
      </p>
    `,
  },

  ooh_return_reminder: {
    variant: 'client',
    preheader: 'Reminder: returning your van overnight tomorrow',
    subject: 'Reminder: out-of-hours van return tomorrow — {{vehicleReg}} (job #{{jobNumber}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Returning your van tomorrow</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{driverName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Quick reminder — you're due to return <strong>{{vehicleReg}}</strong> (job <strong>#{{jobNumber}}</strong>) overnight tonight or
        tomorrow morning, before 9am.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:14px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Gate code</p>
            <p style="margin:0;font-size:24px;color:#1e293b;font-weight:700;letter-spacing:2px;font-family:monospace;">{{gateCode}}</p>
            <p style="margin:8px 0 0;font-size:13px;color:#64748b;">Yard: {{yardAddress}}</p>
          </td>
        </tr>
      </table>

      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        When you've parked up, please tap the button below and confirm where you left the van.
        It pre-fills from GPS — you just check the marker is right and submit.
      </p>

      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td align="center" style="padding:8px;">
            <a href="{{parkingFormUrl}}" style="display:inline-block;padding:14px 28px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">
              Confirm parking location →
            </a>
          </td>
        </tr>
      </table>

      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
        Full instructions are in the email we sent earlier in the week. If you've lost it, just reply and we'll resend.
      </p>
    `,
  },

  under_dispatched_warning: {
    variant: 'internal',
    subject: 'Sanity check: {{jobName}} (#{{jobNumber}}) marked On Hire but HH not fully dispatched',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#92400e;">⚠️ Under-dispatched warning</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        Job <strong>{{jobName}}</strong> (job <strong>#{{jobNumber}}</strong>) has just been marked
        <strong>On Hire</strong> in OP via <strong>{{source}}</strong> by
        <strong>{{actorLabel}}</strong>, but HireHop status is still
        <strong>{{hhStatusLabel}}</strong> — not all items appear to be
        dispatched in HH.
      </p>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        OP has gone ahead and pushed the HH status to Dispatched. Please
        confirm the items are correct, or flip back in HireHop if needed.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fffbeb;border-radius:8px;border:1px solid #fde68a;">
            <p style="margin:0 0 8px;font-size:13px;color:#92400e;">
              <a href="{{opJobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in OP →</a>
            </p>
            {{#if hhJobUrl}}<p style="margin:0;font-size:13px;color:#92400e;">
              <a href="{{hhJobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in HireHop →</a>
            </p>{{/if}}
          </td>
        </tr>
      </table>
    `,
  },

  vehicle_damage_logged: {
    variant: 'internal',
    subject: '🚐 Vehicle issue logged: {{vehicleReg}} — {{summary}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#991b1b;">⚠️ Vehicle issue logged</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        A <strong>{{category}}</strong> issue ({{severity}}) has been {{eventVerb}} on
        <strong>{{vehicleReg}}</strong>{{#if jobRef}} during job <strong>{{jobRef}}</strong>{{/if}}.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#fef2f2;border-radius:8px;border:1px solid #fecaca;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Issue</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{summary}}</p>
            {{#if description}}<p style="margin:0 0 8px;font-size:13px;color:#334155;line-height:1.5;">{{description}}</p>{{/if}}
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Reported by</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;">{{reportedBy}}</p>
            {{#if photoLine}}<p style="margin:0;font-size:13px;color:#334155;">{{photoLine}}</p>{{/if}}
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{issueUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open issue in Ooosh →</a>
      </p>
    `,
  },

  ooh_return_received_internal: {
    variant: 'internal',
    subject: 'OOH return logged: {{vehicleReg}} — job #{{jobNumber}}',
    body: `
      <h2 style="margin:0 0 12px;font-size:18px;color:#1e293b;">Out-of-hours return logged</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#334155;line-height:1.6;">
        <strong>{{driverName}}</strong> has just confirmed where they parked
        <strong>{{vehicleReg}}</strong> for job <strong>#{{jobNumber}}</strong>.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Submitted at</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;font-weight:600;">{{submittedAt}}</p>
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Location</p>
            <p style="margin:0 0 8px;font-size:14px;color:#1e293b;">
              <a href="{{mapsLink}}" style="color:#7B5EA7;text-decoration:none;">{{coordsLine}}</a>
            </p>
            {{#if notes}}<p style="margin:0 0 4px;font-size:13px;color:#64748b;">Notes</p><p style="margin:0 0 8px;font-size:14px;color:#1e293b;">{{notes}}</p>{{/if}}
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        <a href="{{jobUrl}}" style="color:#7B5EA7;text-decoration:none;font-weight:600;">Open job in Ooosh →</a>
      </p>
    `,
  },

  // ── Generic file resend ───────────────────────────────────────────────
  // Used by the Files tab "Email" action — staff sends an arbitrary
  // attachment (delivery note, hire agreement, condition report, jpg
  // photo, anything) to a chosen recipient. Body adapts to whether
  // staff supplied a custom message.

  /**
   * Damage repair quote request to TTS360 (or whichever engineering contact
   * is configured in system_settings). Sent from the check-in flow when
   * staff tick "Also send damage photos to TTS360 for repair quote", or
   * later from the issue detail page when staff missed the tick.
   *
   * Sender renders the photo grid + damage descriptions via
   * bodyHtmlOverride (variable substitution would HTML-escape the grid).
   */
  damage_repair_quote_request: {
    variant: 'internal',
    subject: 'Damage repair quote request — {{vanRegistration}} (job #{{hhJobNumber}})',
    body: `<p>This template should be sent with bodyHtmlOverride. If you're seeing this, the caller forgot.</p>`,
  },

  file_resend: {
    variant: 'client',
    preheader: 'Document from Ooosh Tours',
    subject: '{{subjectLine}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Document attached</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{recipientName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;white-space:pre-wrap;">{{leadParagraph}}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Document</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{fileName}}</p>
            <p style="margin:6px 0 0;font-size:13px;color:#64748b;">{{jobRefLine}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0;font-size:14px;color:#334155;">
        Sent by {{senderName}}. Reply to this email or call us if you have any questions.
      </p>
    `,
  },

  storage_tcs_request: {
    variant: 'client',
    preheader: 'Please review and accept your storage terms',
    subject: 'Your Ooosh storage terms — {{roomName}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Storage Terms &amp; Conditions</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        Hi {{contactName}},
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Please take a moment to review and accept the terms &amp; conditions for your
        storage with us{{orgSuffix}}.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;width:100%;">
        <tr>
          <td style="padding:12px 16px;background-color:#f8fafc;border-radius:8px;border:1px solid #e2e8f0;">
            <p style="margin:0 0 4px;font-size:13px;color:#64748b;">Storage unit</p>
            <p style="margin:0;font-size:15px;color:#1e293b;font-weight:600;">{{roomName}}</p>
          </td>
        </tr>
      </table>
      <p style="margin:0 0 20px;">
        <a href="{{link}}" style="display:inline-block;padding:12px 22px;background-color:#7B5EA7;color:#ffffff;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">Review &amp; accept terms</a>
      </p>
      <p style="margin:0;font-size:14px;color:#334155;line-height:1.6;">
        If you have any questions, just reply to this email or call us.
      </p>
    `,
  },

  // ── PCN module (penalty charge notices) ──────────────────────────────────

  pcn_transfer_liability: {
    variant: 'client',
    preheader: 'Action required — parking/traffic charge notice',
    subject: 'Parking/Traffic Charge Notice — {{vehicleReg}} ({{jobRef}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Parking / Traffic Charge Notice</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Dear {{driverName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received a charge notice for a vehicle that was hired to you at the time of the alleged offence{{jobRefSentence}}. Details below:
      </p>
      <table role="presentation" width="100%" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1e293b;">
        <tr><td style="padding:4px 0;color:#64748b;">Reference</td><td style="padding:4px 0;font-weight:600;">{{pcnReference}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Issuing authority</td><td style="padding:4px 0;">{{issuer}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Vehicle</td><td style="padding:4px 0;">{{vehicleReg}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Date / time</td><td style="padding:4px 0;">{{offenceDateTime}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Location</td><td style="padding:4px 0;">{{location}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Fine</td><td style="padding:4px 0;">{{fineLine}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Final deadline</td><td style="padding:4px 0;">{{finalDeadline}}</td></tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        As the driver at the time, liability for this notice rests with you. Please either pay the issuing authority directly using the reference above, or appeal directly with them if you believe it was issued in error. {{handlingSentence}}
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">A copy of the notice is attached — please refer to it for the issuing authority's accepted payment methods and options.</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any queries, reply to this email or call {{oooshPhone}}.</p>
    `,
  },

  pcn_pay_direct: {
    variant: 'client',
    preheader: 'Please pay this charge directly within 48 hours',
    subject: 'Parking/Traffic Charge Notice — {{vehicleReg}} — please action ({{jobRef}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Parking / Traffic Charge Notice</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Dear {{driverName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received a charge notice for a vehicle hired to you at the time of the alleged offence{{jobRefSentence}}:
      </p>
      <table role="presentation" width="100%" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1e293b;">
        <tr><td style="padding:4px 0;color:#64748b;">Reference</td><td style="padding:4px 0;font-weight:600;">{{pcnReference}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Issuing authority</td><td style="padding:4px 0;">{{issuer}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Vehicle</td><td style="padding:4px 0;">{{vehicleReg}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Date / time</td><td style="padding:4px 0;">{{offenceDateTime}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Location</td><td style="padding:4px 0;">{{location}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Fine</td><td style="padding:4px 0;">{{fineLine}}</td></tr>
      </table>
      <p style="margin:0 0 16px;padding:12px 14px;background-color:#fef3c7;border-radius:8px;font-size:15px;color:#92400e;line-height:1.6;">
        <strong>If you wish to pay the fine directly</strong>, please do so within <strong>48 hours</strong> and forward us a receipt as proof for our records. <strong>If you wish to appeal</strong>, or we don't receive proof of payment, we'll transfer liability into your name with an administration fee of <strong>{{handlingFee}}+VAT</strong>.
      </p>
      {{#if receiptUploadUrl}}
      <table role="presentation" width="100%" style="margin:0 0 16px;"><tr><td align="center">
        <a href="{{receiptUploadUrl}}" style="display:inline-block;padding:12px 28px;background-color:#7B5EA7;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:8px;">Upload proof of payment</a>
      </td></tr></table>
      <p style="margin:0 0 16px;font-size:13px;color:#64748b;line-height:1.6;text-align:center;">Tap the button to upload your receipt — quickest way to keep this off your account.</p>
      {{/if}}
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">You can also reply with your receipt or send it to <a href="mailto:{{oooshEmail}}" style="color:#7B5EA7;text-decoration:none;">{{oooshEmail}}</a>. A copy of the notice is attached — please refer to it for the issuer's payment options.</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any queries, reply to this email or call {{oooshPhone}}.</p>
    `,
  },

  pcn_receipt_received_alert: {
    variant: 'internal',
    subject: 'PCN proof of payment received — {{vehicleReg}} ({{pcnReference}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:18px;color:#1e293b;">Driver uploaded proof of payment</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{driverName}}</strong> has uploaded a receipt for PCN <strong>{{pcnReference}}</strong> (vehicle {{vehicleReg}}{{#if jobNumber}}, job #{{jobNumber}}{{/if}}).
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        The PCN is now marked <strong>Paid by Driver</strong>. Please verify the receipt and close it off.
      </p>
      <p style="margin:0;font-size:14px;"><a href="{{pcnUrl}}" style="color:#7B5EA7;">Open the PCN →</a></p>
    `,
  },

  pcn_chase_alert: {
    variant: 'internal',
    subject: '{{subjectLine}}',
    body: `
      <h2 style="margin:0 0 16px;font-size:18px;color:#1e293b;">Pay-direct chase {{level}} of {{total}} sent</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">
        <strong>{{driverName}}</strong> still hasn't sent proof of payment for PCN <strong>{{pcnReference}}</strong> (vehicle {{vehicleReg}}) — now <strong>{{daysPast}} days</strong> past the pay-direct deadline. Reminder #{{level}} has just been re-sent.
      </p>
      {{#if escalate}}
      <p style="margin:0 0 16px;padding:12px 14px;background-color:#fee2e2;border-radius:8px;font-size:15px;color:#991b1b;line-height:1.6;">
        <strong>This was the final chase.</strong> Consider transferring liability into the driver's name (adds the handling fee) — open the PCN and use the "Transfer liability" action.
      </p>
      {{/if}}
      <p style="margin:0;font-size:14px;"><a href="{{pcnUrl}}" style="color:#7B5EA7;">Open the PCN →</a></p>
    `,
  },

  pcn_request_driver_id: {
    variant: 'client',
    preheader: 'Driver identification required',
    subject: 'Driver Identification Required — {{vehicleReg}} — {{offenceDate}} ({{jobRef}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Driver Identification Required</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Dear {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received a charge notice for vehicle <strong>{{vehicleReg}}</strong>, which was on hire to you at the time{{jobRefSentence}}.
      </p>
      <table role="presentation" width="100%" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1e293b;">
        <tr><td style="padding:4px 0;color:#64748b;">Date / time</td><td style="padding:4px 0;">{{offenceDateTime}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Location</td><td style="padding:4px 0;">{{location}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Reference</td><td style="padding:4px 0;">{{pcnReference}}</td></tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        Our records show more than one driver was authorised on this hire{{driverListSentence}}. To transfer liability to the issuing authority, we need to confirm who was driving at the above time. Please reply with the full name and contact details of the driver.
      </p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        If we don't hear from you within 7 days, we may be unable to transfer liability and the charge (plus an administration fee) will be applied to your account.
      </p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any queries, reply to this email or call {{oooshPhone}}.</p>
    `,
  },

  pcn_police_nip_urgent: {
    variant: 'client',
    preheader: 'URGENT — police notice, driver details required',
    subject: 'URGENT: Police Notice — Driver Identification Required — {{vehicleReg}} ({{jobRef}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#b91c1c;">URGENT — Notice of Intended Prosecution</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Dear {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received a Notice of Intended Prosecution (NIP) from the police for vehicle <strong>{{vehicleReg}}</strong>, which was on hire to you at the time of the alleged offence{{jobRefSentence}}.
      </p>
      <table role="presentation" width="100%" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1e293b;">
        <tr><td style="padding:4px 0;color:#64748b;">Date / time</td><td style="padding:4px 0;">{{offenceDateTime}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Location</td><td style="padding:4px 0;">{{location}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Reference</td><td style="padding:4px 0;">{{pcnReference}}</td></tr>
      </table>
      <p style="margin:0 0 16px;padding:12px 14px;background-color:#fee2e2;border-radius:8px;font-size:15px;color:#991b1b;line-height:1.6;">
        We're legally required to provide driver details to the police within <strong>28 days</strong> of the offence. Failure to do so is a criminal offence. Please reply <strong>URGENTLY</strong> with the full name, address and date of birth of the person driving at the above time.
      </p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">If you have any questions, call us immediately on {{oooshPhone}}.</p>
    `,
  },

  pcn_pay_recharge: {
    variant: 'client',
    preheader: 'Charge notice paid on your behalf',
    subject: 'Charge Notice — {{vehicleReg}} — Paid on Your Behalf ({{jobRef}})',
    body: `
      <h2 style="margin:0 0 16px;font-size:20px;color:#1e293b;">Charge Notice — Paid on Your Behalf</h2>
      <p style="margin:0 0 12px;font-size:15px;color:#334155;line-height:1.6;">Dear {{clientName}},</p>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">
        We've received a charge notice for vehicle <strong>{{vehicleReg}}</strong>, on hire to you at the time{{jobRefSentence}}. To avoid the charge escalating, we've paid it on your behalf and will recharge it to your account.
      </p>
      <table role="presentation" width="100%" style="margin:0 0 16px;border-collapse:collapse;font-size:14px;color:#1e293b;">
        <tr><td style="padding:4px 0;color:#64748b;">Reference</td><td style="padding:4px 0;font-weight:600;">{{pcnReference}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Issuing authority</td><td style="padding:4px 0;">{{issuer}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Date / time</td><td style="padding:4px 0;">{{offenceDateTime}}</td></tr>
        <tr><td style="padding:4px 0;color:#64748b;">Fine paid</td><td style="padding:4px 0;">{{fineLine}}</td></tr>
      </table>
      <p style="margin:0 0 16px;font-size:15px;color:#334155;line-height:1.6;">{{handlingSentence}} A copy of the notice is attached.</p>
      <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">Any queries, reply to this email or call {{oooshPhone}}.</p>
    `,
  },

};

export default templates;
