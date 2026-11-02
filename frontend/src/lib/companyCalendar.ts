/**
 * Bank holidays vs company days — THE rule, per CLAUDE.md's helper convention.
 *
 * The two overlap and, left alone, say opposite things about the same date.
 * Adding Christmas Day as a company day left My Time still announcing that
 * 25 December was a normal working day everyone would have to book off, which
 * is exactly backwards.
 *
 * A COMPANY DAY WINS. It is the more specific fact and the one Ooosh decided,
 * where the bank holiday is inherited from the calendar and — under the
 * `use_allowance` policy — is only a marker anyway.
 *
 * Kept here rather than in either page because both the staff calendar and My
 * Time need it, and two places deciding which of two overlapping facts wins is
 * how they end up disagreeing.
 */

export interface CompanyDayOccurrence {
  date: string;
  label: string;
}

export interface BankHolidaySplit {
  /** Still ordinary working days — book them off if you want them. */
  working: string[];
  /** Also company days, so already given and nothing to book. */
  granted: string[];
}

/**
 * Split bank holidays by whether the company has already granted them.
 *
 * `from` narrows to dates on or after it, which is what makes the count
 * actionable rather than trivia — nobody needs telling about August in December.
 */
export function splitBankHolidays(
  bankHolidays: string[],
  companyDays: CompanyDayOccurrence[],
  from?: string
): BankHolidaySplit {
  const granted = new Set(companyDays.map(c => c.date));
  const inScope = from ? bankHolidays.filter(d => d >= from) : bankHolidays;
  return {
    working: inScope.filter(d => !granted.has(d)),
    granted: inScope.filter(d => granted.has(d)),
  };
}

/**
 * What to call a date on a grid: a company day if it is one, otherwise a bank
 * holiday, otherwise nothing. Same precedence, one place.
 */
export function dayMarker(
  date: string,
  bankHolidays: string[],
  companyDays: CompanyDayOccurrence[]
): { kind: 'company'; label: string } | { kind: 'bank' } | null {
  const company = companyDays.find(c => c.date === date);
  if (company) return { kind: 'company', label: company.label };
  return bankHolidays.includes(date) ? { kind: 'bank' } : null;
}
