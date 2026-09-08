/**
 * Which driver documents are actually ON FILE.
 *
 * `drivers.files` is a JSONB array of `{ name, url, type, label?, tag?, … }`
 * appended by every upload path — the hire form (`POST
 * /driver-verification/upload`, which sets a `tag`) and staff uploads on the
 * driver page (which set a `label`). Nothing in OP read it to answer "does this
 * document exist", so the whole staff cockpit was derived from DATES alone and
 * could say two untrue things:
 *
 *   no file, no date  → "has no date recorded — add the date on the document",
 *                       with an Add-the-date button pointing at an empty slot.
 *                       There is no document to read a date off.
 *   no file, date set → green. The validity window rests on nothing. This is
 *                       not hypothetical: Steven Aldridge / job 16116 (Sep 2026)
 *                       had a DVLA check date, code and points written
 *                       server-side while the DVLA evidence file was never
 *                       uploaded, and nothing anywhere said so.
 *
 * WHY THE MATCH IS ON A NORMALISED TOKEN
 * --------------------------------------
 * Upload paths spell the same document several ways — `licence_front`,
 * `license_front`, `Licence Front` — which is how the driver snapshot PDF
 * silently dropped licence and POA images for months. Matching a lowercase
 * alphanumeric token rather than an exact string means a new variant doesn't
 * break the group.
 *
 * WHY THIS IS THE ONE THAT DECIDES
 * --------------------------------
 * `filesForSlot()` on the frontend answers a different question — WHICH file
 * goes in which thumbnail slot — and needs the file objects, not a boolean. It
 * keeps its own copy of these spellings for that. This module is the one that
 * decides what staff are TOLD, and its answer is served through
 * /verification-state so the two can't tell staff different things: if a file
 * exists under a spelling neither recognises, the slot on screen already reads
 * "Not uploaded" and this line agrees with it.
 */

/** Evidence groups that have a document behind them, as the cockpit groups them. */
export type DocumentSlot = 'identity' | 'poa1' | 'poa2' | 'dvla' | 'passport' | 'signature';

/**
 * Accepted label/tag spellings per slot — the same lists the cockpit's evidence
 * groups use. Compared after `normaliseTag()`, so punctuation and case here are
 * only for readability.
 */
const SLOT_TAGS: Record<DocumentSlot, string[]> = {
  identity: [
    'Licence Front', 'licence_front', 'License Front', 'license_front',
    'Licence Back', 'licence_back', 'License Back', 'license_back',
    'Selfie', 'selfie', 'face', 'idenfy_face',
  ],
  poa1: ['Proof of Address', 'POA 1', 'poa1', 'Proof of Address 1'],
  poa2: ['POA 2', 'poa2', 'Proof of Address 2'],
  dvla: ['DVLA Check Code', 'DVLA Check', 'dvla_check', 'dvla'],
  passport: ['Passport', 'passport'],
  signature: ['Signature', 'signature', 'sig'],
};

/** Lowercase, strip everything that isn't a letter or digit. */
export function normaliseTag(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/**
 * Coerce whatever the driver row carries in `files` into a list of records.
 *
 * node-postgres parses a JSONB column for us, but the column is nullable and a
 * caller that fetched the row some other way may hand us the raw JSON text —
 * so both are accepted, and anything else yields an empty list rather than
 * throwing inside a page render.
 */
function toFileList(files: unknown): Array<Record<string, unknown>> {
  let value = files;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object');
}

/** Is there at least one file on this driver row for `slot`? */
export function hasDocumentFor(slot: DocumentSlot, files: unknown): boolean {
  const wanted = new Set(SLOT_TAGS[slot].map(normaliseTag));
  return toFileList(files).some(f => {
    const tag = normaliseTag(f.tag);
    const label = normaliseTag(f.label);
    return (!!tag && wanted.has(tag)) || (!!label && wanted.has(label));
  });
}

/** Presence for every slot at once — one pass over the file list per slot. */
export function documentPresence(files: unknown): Record<DocumentSlot, boolean> {
  const list = toFileList(files);
  const out = {} as Record<DocumentSlot, boolean>;
  for (const slot of Object.keys(SLOT_TAGS) as DocumentSlot[]) {
    out[slot] = hasDocumentFor(slot, list);
  }
  return out;
}
