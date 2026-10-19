/**
 * Freelancer sign-up documents — which of a person's files the public apply
 * form is allowed to hand back to them.
 *
 * Its own module, and not part of routes/freelancers.ts, for the same reason
 * driver-documents.ts is: the interesting part is a list of spellings and a
 * whitelist, both of which are worth pinning down in a test without standing up
 * an Express router to do it.
 */

/**
 * The document slots the sign-up form offers, and the label spellings each one
 * answers to (normalised — lowercase, letters and digits only).
 *
 * Used to hand a freelancer their OWN documents back when we re-open the form
 * to ask for one more thing. Deliberately a whitelist: a token is not a login,
 * so whoever holds the link sees only the documents this form asked for, never
 * everything staff have since attached to the person.
 *
 * 'dvlasummary' is here because the form used to file its DVLA upload under
 * that label. Same spelling list as REQUIRED_DOCS in FreelancerPanel.tsx and
 * DOCUMENT_TOKENS in services/driver-documents.ts — a new spelling goes in all
 * three, or the three disagree about whether we hold a document.
 */
export const APPLY_DOCUMENT_SLOTS: { label: string; match: string[] }[] = [
  { label: 'Licence Front', match: ['licencefront', 'licensefront'] },
  { label: 'Licence Back', match: ['licenceback', 'licenseback'] },
  { label: 'DVLA Check', match: ['dvlacheck', 'dvlasummary', 'dvlacheckcode', 'dvla'] },
  { label: 'Passport', match: ['passport'] },
  { label: 'Public Liability Insurance', match: ['publicliabilityinsurance', 'publicliability', 'pli'] },
  { label: 'CV', match: ['cv'] },
];

/** Lowercase, strip everything that isn't a letter or digit. */
export function normaliseDocToken(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

export interface PersonFile {
  url?: string;
  name?: string;
  label?: string;
  tag?: string;
  content_type?: string;
  uploaded_at?: string;
}

/** The person's files as a list, whatever shape the column came back in. */
export function toFileList(files: unknown): PersonFile[] {
  let value = files;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value) ? value.filter((f): f is PersonFile => !!f && typeof f === 'object') : [];
}

/**
 * The newest file we hold for each slot the form offers, as the form's own
 * document shape — so a re-opened form can show "already on file" instead of an
 * empty box it demands they fill again.
 */
export function documentsOnFile(files: unknown): Array<{ r2_key: string; label: string; filename: string; content_type?: string }> {
  const list = toFileList(files).filter((f) => typeof f.url === 'string' && f.url);
  const out: Array<{ r2_key: string; label: string; filename: string; content_type?: string }> = [];
  for (const slot of APPLY_DOCUMENT_SLOTS) {
    const wanted = new Set(slot.match);
    const matches = list.filter((f) => wanted.has(normaliseDocToken(f.tag)) || wanted.has(normaliseDocToken(f.label)));
    if (matches.length === 0) continue;
    const newest = matches.reduce((a, b) =>
      new Date(a.uploaded_at || 0) > new Date(b.uploaded_at || 0) ? a : b);
    out.push({
      r2_key: newest.url as string,
      label: slot.label,
      filename: newest.name || slot.label,
      content_type: newest.content_type,
    });
  }
  return out;
}
