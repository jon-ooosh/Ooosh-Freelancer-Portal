/**
 * Where an enquiry came from — two separate questions (docs/BUSINESS-FIGURES-SPEC.md §7):
 *
 *   "Came in by" — HOW it reached us: `jobs.enquiry_source` (backend enum in routes/pipeline.ts).
 *   Required on New Enquiry, changeable on the job while it's an enquiry; the website form and
 *   the Leads module set it themselves. Business figures compare reply speed on it.
 *
 *   "Heard about us" — WHERE they found us: `job_marketing_source.heard_about`
 *   (backend services/marketing-source.ts HEARD_ABOUT_LABELS — keep the two lists the same).
 *   Optional everywhere; the website form asks it too.
 *
 * Referral / Returning client / Forum used to sit in the first list; they answer the second
 * question, so they're no longer offered there (old enquiries keep their label). Whether a
 * client is returning is worked out from their history, never asked.
 */
export const ENQUIRY_SOURCE_LABELS: Record<string, string> = {
  phone: 'Phone',
  email: 'Email',
  web_form: 'Website',
  in_person: 'In person',
  referral: 'Referral',
  repeat: 'Returning client',
  forum: 'Forum / social',
  cold_lead: 'Cold lead',
  other: 'Other',
};

/** "Came in by" — what staff pick from. */
export const ENQUIRY_SOURCE_CHOICES: Array<{ value: string; label: string }> =
  ['phone', 'email', 'web_form', 'in_person', 'other'].map((value) => ({ value, label: ENQUIRY_SOURCE_LABELS[value] }));

export const HEARD_ABOUT_LABELS: Record<string, string> = {
  google_search: 'Google search',
  google_ad: 'Google ad',
  social: 'Facebook / Instagram',
  print: 'Magazine / print',
  recommendation: 'Recommendation',
  returning: 'Used us before',
  ai: 'Asked an AI (ChatGPT etc.)',
  saw_at_venue: 'Saw us at a venue',
  other: 'Other',
};

export const HEARD_ABOUT_CHOICES: Array<{ value: string; label: string }> =
  Object.entries(HEARD_ABOUT_LABELS).map(([value, label]) => ({ value, label }));

/** The answers that get a short "who / where?" box. */
export const HEARD_ABOUT_DETAIL_PROMPT: Record<string, string> = {
  recommendation: 'Who recommended us?',
  other: 'Where?',
};
