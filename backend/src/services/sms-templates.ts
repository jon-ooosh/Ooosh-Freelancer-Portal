/**
 * SMS Template Registry
 *
 * Plain-text only (SMS has no HTML). Keep bodies tight — ideally one GSM
 * segment (160 chars). {{variable}} substitution, no {{#if}} blocks.
 */

export interface SmsTemplate {
  body: string;
}

const templates: Record<string, SmsTemplate> = {
  // Fired when an OOH-flagged van comes within the geofence radius of base.
  ooh_return_approach: {
    body:
      `Hi {{driverName}}, you're nearly back at Ooosh with {{vehicleReg}}. ` +
      `Please park considerately and do NOT block the neighbours' gates. ` +
      `Full instructions for how to return are: {{parkingFormUrl}}`,
  },

  // Possible insurance claim (docs/INCIDENT-CLAIMS-SPEC.md §21): sent with the
  // first email of a client's form link, when we have their mobile. GSM
  // characters only (no dashes / curly quotes) so it stays one 160-char segment.
  claim_form_link: {
    body:
      `Ooosh! Tours: please fill in our incident form for van {{vehicleReg}}{{jobRef}}: {{formUrl}}`,
  },

  // Sent alongside the 3rd email reminder (services/claim-chase.ts).
  claim_form_reminder: {
    body:
      `Ooosh! Tours: reminder to finish our incident form for van {{vehicleReg}}{{jobRef}} ` +
      `({{done}}/{{total}} done): {{formUrl}}`,
  },
};

export default templates;
