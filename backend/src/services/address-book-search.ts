/**
 * Shared bits of the address book list searches (routes/people.ts, routes/organisations.ts).
 */

/**
 * If a search looks like a phone number, the digits to match against a phone
 * column with its formatting stripped — else null.
 *
 * The UK prefix is dropped ("+44 7700…" / "07700…" → "7700…") so either way of
 * writing a number finds the other. Needs 6+ digits so a short number in a name
 * search ("Studio 2") never turns into a phone match.
 */
export function phoneDigitsForSearch(search: string): string | null {
  const s = search.trim();
  if (!/^[\d\s()+\-.]+$/.test(s)) return null;
  const core = s.replace(/\D/g, '').replace(/^44/, '').replace(/^0+/, '');
  return core.length >= 6 ? core : null;
}
