/**
 * How an enquiry reached us — `jobs.enquiry_source` (backend enum in routes/pipeline.ts).
 * Asked on New Enquiry (required) and changeable on the job while it's an enquiry;
 * the website form and the Leads module set it themselves. The business figures
 * compare channels on it (docs/BUSINESS-FIGURES-SPEC.md).
 */
export const ENQUIRY_SOURCE_LABELS: Record<string, string> = {
  phone: 'Phone',
  email: 'Email',
  web_form: 'Website',
  referral: 'Referral',
  repeat: 'Returning client',
  forum: 'Forum / social',
  cold_lead: 'Cold lead',
  other: 'Other',
};

/** The choices staff pick from. "Cold lead" is left off — the Leads module sets it. */
export const ENQUIRY_SOURCE_CHOICES: Array<{ value: string; label: string }> =
  ['phone', 'email', 'web_form', 'referral', 'repeat', 'forum', 'other'].map((value) => ({ value, label: ENQUIRY_SOURCE_LABELS[value] }));
