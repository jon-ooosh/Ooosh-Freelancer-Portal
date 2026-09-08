/**
 * Driver document files — THE match, and "is it actually on file".
 *
 * `drivers.files` is a JSONB array of `{ name, url, type, label?, tag?, … }`
 * appended by every upload path: the hire form (`POST
 * /driver-verification/upload`, which sets a `tag`), staff uploads on the
 * driver page (which set a `label`), and the Monday migration (which used yet
 * another spelling).
 *
 * TWO QUESTIONS, ONE SET OF SPELLINGS
 * -----------------------------------
 *   which document is this file?  → `resolveDocumentKey()`, used by the
 *                                    snapshot PDF to pick the image for a page
 *   is this document on file?     → `hasDocumentFor()` / `documentPresence()`,
 *                                    used by the staff cockpit
 *
 * They used to be two independent copies of the same token lists (this map was
 * `DOC_MATCH_TOKENS`, inline in driver-snapshot-pdf.ts). That is the drift this
 * codebase keeps getting bitten by — and this exact list has already caused it
 * once: the snapshot PDF matched on exact strings, so it silently dropped every
 * licence and POA image for months while `passport` and `signature` happened to
 * line up (Adam Coelho / job 16063).
 *
 * WHY THE MATCH IS ON A NORMALISED TOKEN
 * --------------------------------------
 * Lowercase, strip every non-alphanumeric, so British/American spelling and
 * space/underscore/hyphen variants all collapse together:
 *   'Licence Front' | 'licence_front' | 'License Front' | 'licence-front'
 *   'POA 1' | 'poa1' | 'Proof of Address 1'
 * Match on `tag` first, then fall back to `label`.
 *
 * WHY PRESENCE IS A SEPARATE QUESTION FROM VALIDITY
 * -------------------------------------------------
 * Nothing in OP read this index to ask "does this document exist", so the staff
 * cockpit was derived from DATES alone and could say two untrue things:
 *
 *   no file, no date  → "has no date recorded — add the date on the document",
 *                       with an Add-the-date button pointing at an empty slot.
 *                       There is no document to read a date off.
 *   no file, date set → green. The validity window rests on nothing. Steven
 *                       Aldridge / job 16116 (Sep 2026): a DVLA check date,
 *                       code and points written server-side while the evidence
 *                       file was never uploaded, and nothing anywhere said so.
 *
 * Presence changes what staff are TOLD, never a window. The hire-form router is
 * date-based too, so letting a missing file invalidate a window would put OP
 * and the driver's own form back to disagreeing about the same driver.
 *
 * THE ONE REMAINING MIRROR
 * ------------------------
 * `filesForSlot()` in frontend/.../EvidenceGroup.tsx holds these spellings for a
 * third job — which file goes in which thumbnail slot — and needs the file
 * objects, not a boolean or a key. It can't import this module (the backend and
 * frontend don't share runtime code; `shared/` is types-only as far as the
 * backend's `rootDir` is concerned), so **a new spelling goes in both**.
 */

/** Canonical document keys — one per physical document we hold. */
export const DOCUMENT_TOKENS = {
  licenceFront: ['licencefront', 'licensefront'],
  licenceBack: ['licenceback', 'licenseback'],
  /** The iDenfy selfie, stored so staff can compare it against the licence photo. */
  selfie: ['selfie', 'face', 'idenfyface'],
  dvlaCheck: ['dvlacheck', 'dvlacheckcode', 'dvla'],
  poa1: ['poa1', 'proofofaddress1', 'proofofaddress'],
  poa2: ['poa2', 'proofofaddress2'],
  passport: ['passport'],
  signature: ['signature', 'sig'],
} as const;

export type DocumentKey = keyof typeof DOCUMENT_TOKENS;

/**
 * Evidence groups as the staff cockpit groups them — the licence front, back
 * and selfie are three files behind ONE 90-day identity check, which is why
 * they share a group (and a date).
 */
export const SLOT_DOCUMENTS = {
  identity: ['licenceFront', 'licenceBack', 'selfie'],
  poa1: ['poa1'],
  poa2: ['poa2'],
  dvla: ['dvlaCheck'],
  passport: ['passport'],
  signature: ['signature'],
} as const satisfies Record<string, readonly DocumentKey[]>;

export type DocumentSlot = keyof typeof SLOT_DOCUMENTS;

/**
 * token → document key. Built as an exact reverse lookup so 'proofofaddress2'
 * resolves to poa2 and never falls into poa1's 'proofofaddress'.
 */
const TOKEN_TO_KEY: Record<string, DocumentKey> = (() => {
  const out: Record<string, DocumentKey> = {};
  for (const [key, tokens] of Object.entries(DOCUMENT_TOKENS) as Array<[DocumentKey, readonly string[]]>) {
    for (const token of tokens) out[token] = key;
  }
  return out;
})();

/** Lowercase, strip everything that isn't a letter or digit. */
export function normaliseDocToken(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

/** Which document a file is, from its `tag` (preferred) or `label`. */
export function resolveDocumentKey(file: { label?: unknown; tag?: unknown }): DocumentKey | null {
  return TOKEN_TO_KEY[normaliseDocToken(file.tag)]
    ?? TOKEN_TO_KEY[normaliseDocToken(file.label)]
    ?? null;
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
  const wanted = new Set<DocumentKey>(SLOT_DOCUMENTS[slot]);
  return toFileList(files).some(f => {
    const key = resolveDocumentKey(f);
    return !!key && wanted.has(key);
  });
}

/** Presence for every slot at once. */
export function documentPresence(files: unknown): Record<DocumentSlot, boolean> {
  const list = toFileList(files);
  const out = {} as Record<DocumentSlot, boolean>;
  for (const slot of Object.keys(SLOT_DOCUMENTS) as DocumentSlot[]) {
    out[slot] = hasDocumentFor(slot, list);
  }
  return out;
}
