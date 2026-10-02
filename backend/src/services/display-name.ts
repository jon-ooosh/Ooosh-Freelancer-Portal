/**
 * What somebody is CALLED — the backend twin of frontend/src/lib/displayName.ts.
 *
 * `people.preferred_name` arrived with migration 184, the FREELANCER onboarding
 * migration: the application form has always asked what they like to be known
 * as. Staff inherited the field later (mig 213 needed no column, it was already
 * there). So it is one field on `people` for everybody, which is the right shape
 * — a person who applies as a freelancer, does a yard day and later joins staff
 * keeps one answer to "what do I call you".
 *
 * It existed for years and almost nothing read it. The application asked the
 * question and then every email we sent ignored the answer, so a Rob who is
 * legally Robert told us he was Rob and got "Hi Robert" on every job. This
 * module exists so that cannot drift back: one definition, imported.
 *
 * NOT for anything legal or financial. Payroll, the hire agreement, right-to-
 * work records and the carnet all want `first_name last_name` as it appears on
 * the passport, so those build the name themselves and should keep doing so.
 */

export interface NameableRow {
  first_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  email?: string | null;
}

/**
 * "Will" — for the greeting line of an email, or anywhere a first name is used
 * conversationally. Falls back to "there" so "Hi there" is the worst case.
 *
 * Remember to SELECT `preferred_name`: a row that never fetched it silently
 * falls through to the legal name and looks like it is working.
 */
export function greetingName(row: NameableRow | null | undefined, fallback = 'there'): string {
  if (!row) return fallback;
  return row.preferred_name?.trim()
    || row.first_name?.trim()
    || fallback;
}

/** "Will Parish" — preferred first name, real surname. */
export function fullDisplayName(row: NameableRow | null | undefined, fallback = ''): string {
  if (!row) return fallback;
  const first = row.preferred_name?.trim() || row.first_name?.trim() || '';
  const last = row.last_name?.trim() || '';
  return `${first} ${last}`.trim() || row.email?.trim() || fallback;
}

/**
 * The same rule in SQL, for a name built by the query rather than in JS.
 *
 * Expects `people` joined as `p`. CONCAT treats NULL as an empty string, so a
 * row with no names at all yields " " rather than NULL — wrap it in
 * `NULLIF(..., ' ')` where you need to fall back to something else.
 */
export const DISPLAY_NAME_SQL =
  `CONCAT(COALESCE(NULLIF(p.preferred_name, ''), p.first_name), ' ', p.last_name)`;
