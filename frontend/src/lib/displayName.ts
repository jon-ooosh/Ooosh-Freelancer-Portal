/**
 * What somebody is CALLED — THE definition, per CLAUDE.md's helper rule.
 *
 * `people.preferred_name` was added so staff could record what they actually go
 * by, and then only the Staff page used it: the avatar, the @mention list and
 * every "Posting as …" still read the legal first name. A preferred name that
 * only appears on the screen where you typed it is not a preferred name.
 *
 * The rule is simply preferred, then first, then email, then a placeholder —
 * and it is one function so the answer cannot drift between surfaces.
 *
 * NOT for anything legal or financial. Payroll, the hire agreement, right-to-
 * work records and the carnet all want `first_name last_name` as it appears on
 * the passport, so those build the name themselves and should keep doing so.
 */

export interface NameableUser {
  first_name?: string | null;
  last_name?: string | null;
  preferred_name?: string | null;
  email?: string | null;
}

/** "Will" — the short form, for an avatar, a greeting or an @mention. */
export function displayFirstName(u: NameableUser | null | undefined, fallback = 'there'): string {
  if (!u) return fallback;
  return u.preferred_name?.trim()
    || u.first_name?.trim()
    || u.email?.split('@')[0]
    || fallback;
}

/** "Will Parish" — preferred first name with the real surname kept. */
export function displayFullName(u: NameableUser | null | undefined, fallback = 'Unknown'): string {
  if (!u) return fallback;
  const first = u.preferred_name?.trim() || u.first_name?.trim() || '';
  const last = u.last_name?.trim() || '';
  const both = `${first} ${last}`.trim();
  return both || u.email || fallback;
}

/**
 * Initials for an avatar.
 *
 * Deliberately from the PREFERRED first name: if someone goes by Will rather
 * than William the initial is the same, but a Bob who is legally Robert should
 * not see an R in the circle when everything else says Bob.
 */
export function displayInitials(u: NameableUser | null | undefined): string {
  if (!u) return '';
  const first = u.preferred_name?.trim() || u.first_name?.trim() || u.email?.trim() || '';
  const last = u.last_name?.trim() || '';
  return `${first[0] ?? ''}${last[0] ?? ''}`.toUpperCase();
}

/**
 * The name shown next to an @ in the mention picker, e.g. "will".
 *
 * Lower-cased and space-stripped so it reads like a handle rather than a name,
 * which is what tells people it is a token they are inserting.
 */
export function mentionHandle(u: NameableUser | null | undefined): string {
  return displayFirstName(u, 'someone').replace(/\s+/g, '').toLowerCase();
}

/** Free-text haystack for filtering a people list — matches either name. */
export function nameSearchText(u: NameableUser | null | undefined): string {
  if (!u) return '';
  return [u.preferred_name, u.first_name, u.last_name, u.email]
    .filter(Boolean).join(' ').toLowerCase();
}
