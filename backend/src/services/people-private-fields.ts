/**
 * Private staff fields on `people` — THE list, and THE way to keep them off a
 * general people response.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `people` is the platform's most widely-read table: clients, contacts, band
 * members and employees all live in it, and `routes/people.ts` is gated on
 * STAFF_ROLES — the whole non-freelancer team.
 *
 * Migration 206 added right-to-work and NI columns to that table. They were
 * placed there for good reasons (right to work is a fact about a person, not
 * about one employment record) and read only from the admin-gated staff
 * service. But `GET /api/people` and `GET /api/people/:id` both select `p.*`,
 * so every one of those columns was being handed to every staff member,
 * general assistant and weekend manager who opened any person record:
 *
 *   rtw_document_type   — "Biometric residence permit" tells the whole team
 *                         something about a colleague's immigration status
 *   rtw_expires_on      — the same, with a date attached
 *   ni_number_encrypted — ciphertext, not the number, but it still leaves the
 *                         server, sits in every browser's network tab, and
 *                         says who we hold an NI number for
 *
 * Found while building spec §8 Phase 2 (docs/STAFF-RECORDS-SPEC.md §13.1). The
 * same shape as the Phase 1 finding: data placed sensibly, gated somewhere
 * else, and the gate was wrong.
 *
 * THE FIX, and why it is a redact rather than a column list: `people` has
 * dozens of columns and the frontend reads a moving subset of them, so
 * enumerating the safe ones would break a page every time somebody adds a
 * field. Stripping a short, explicit list of unsafe ones fails in the safe
 * direction — a new sensitive column is the thing you must remember to add
 * here, and that is a much smaller thing to remember.
 *
 * => Anything private added to `people` goes in PRIVATE_PERSON_FIELDS, and is
 *    read through the admin-gated staff surfaces instead.
 */

/**
 * Columns on `people` that must never leave a general people endpoint.
 * The admin-only staff surfaces (services/staff-employment.ts) read them
 * explicitly by name, which is why redacting here costs them nothing.
 */
export const PRIVATE_PERSON_FIELDS = [
  'ni_number_encrypted',
  'rtw_checked_on',
  'rtw_document_type',
  'rtw_expires_on',
  'rtw_checked_by',
  // Migration 238. Nothing computes from it and nobody outside the staff area
  // has a reason to see it.
  'marital_status',
] as const;

/**
 * NOT redacted, and worth saying why so nobody "fixes" it:
 * `date_of_birth`, `home_address`, `phone` and the emergency contacts are also
 * personal, but they have been served by the general people endpoints since
 * migration 001 and the driver/hire-form flows read them there legitimately.
 * Redacting them is a separate, larger decision about the People record — see
 * docs/STAFF-RECORDS-SPEC.md §18.4 — not something to slip into a staff change.
 */

/**
 * Strip the private fields from one row. Returns a new object; the input is
 * left alone so an audit snapshot taken from the same row keeps everything.
 */
export function redactPrivateFields<T extends Record<string, unknown>>(row: T): T {
  const out = { ...row };
  for (const field of PRIVATE_PERSON_FIELDS) delete out[field];
  return out;
}

/** The same, for a list. */
export function redactPrivateFieldsAll<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map(redactPrivateFields);
}
