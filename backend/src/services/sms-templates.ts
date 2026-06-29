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
};

export default templates;
