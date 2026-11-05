/**
 * Cash forecast, Phase 3 — spotting regular payments in Xero's bank history
 * (docs/CASHFLOW-FORECAST-SPEC.md §5.4, §13.3). Pure: no database, no clock,
 * tested in __tests__/cashflow-recurring.test.ts.
 *
 * A suggestion is never counted until jon accepts it as a planned item.
 */
import { addDays, dayInMonth, daysBetween } from './cashflow-schedule';

export interface SpendTxn {
  contactId: string | null;
  contactName: string;
  date: string;        // YYYY-MM-DD
  amount: number;      // positive £ (money out)
}

export interface RecurringSuggestion {
  key: string;                       // contact id, else "name:<normalised name>"
  contactId: string | null;
  contactName: string;
  frequency: 'monthly' | 'quarterly';
  amount: number;                    // the typical (median) payment
  steady: boolean;                   // false = the amount varies; `range` says how much
  range: { min: number; max: number };
  day: number;                       // usual day of the month
  count: number;                     // payments seen in the last 12 months
  lastDate: string;
  nextDate: string;                  // the next expected payment on or after today
  recent: Array<{ date: string; amount: number }>;  // the last few, newest first
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Share of values within ±pct of the middle (and never stricter than ±£5). */
function shareWithin(xs: number[], mid: number, pct: number): number {
  const tol = Math.max(Math.abs(mid) * pct, 5);
  return xs.filter((x) => Math.abs(x - mid) <= tol).length / xs.length;
}

export function normaliseName(name: string): string {
  return name.toLowerCase().replace(/\b(ltd|limited|plc|llp|uk)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Suppliers paid on a pattern over the last 12 months:
 *   monthly   — paid in at least 6 different months, mostly once a month, on
 *               roughly the same day (±5 days for 70% of payments)
 *   quarterly — at least 3 payments, each 75–105 days after the last
 * and still going (paid within the last 45 / 120 days). An amount within ±15%
 * of the usual for 70% of payments is "steady"; within ±40% it is offered as
 * "varies"; anything looser (fuel, parts) is not a regular payment.
 */
export function findRecurring(txns: SpendTxn[], today: string): RecurringSuggestion[] {
  const since = addDays(today, -366);
  const groups = new Map<string, SpendTxn[]>();
  for (const t of txns) {
    if (!(t.amount > 0.005) || t.date < since || t.date > today) continue;
    const key = t.contactId || `name:${normaliseName(t.contactName)}`;
    if (key === 'name:') continue;
    groups.set(key, [...(groups.get(key) || []), t]);
  }

  const out: RecurringSuggestion[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = list.map((t) => t.amount);
    const mid = median(amounts);
    const steady = shareWithin(amounts, mid, 0.15) >= 0.7;
    if (!steady && shareWithin(amounts, mid, 0.4) < 0.7) continue;
    const last = list[list.length - 1];
    const days = list.map((t) => Number(t.date.slice(8, 10)));
    const usualDay = Math.round(median(days));
    const base = {
      key, contactId: list[0].contactId, contactName: last.contactName, amount: round2(mid), steady,
      range: { min: round2(Math.min(...amounts)), max: round2(Math.max(...amounts)) },
      day: usualDay, count: list.length, lastDate: last.date,
      recent: [...list].reverse().slice(0, 4).map((t) => ({ date: t.date, amount: round2(t.amount) })),
    };

    // Monthly?
    const months = new Set(list.map((t) => t.date.slice(0, 7)));
    const oncePerMonth = months.size / list.length >= 0.8;
    const onTheDay = days.filter((dd) => Math.abs(dd - usualDay) <= 5).length / days.length >= 0.7;
    if (months.size >= 6 && oncePerMonth && onTheDay && daysBetween(last.date, today) <= 45) {
      const [y, m] = today.split('-').map(Number);
      let next = dayInMonth(y, m, usualDay);
      if (next < today) next = dayInMonth(y, m + 1, usualDay);
      out.push({ ...base, frequency: 'monthly', nextDate: next });
      continue;
    }

    // Quarterly?
    if (list.length >= 3) {
      const gaps = list.slice(1).map((t, i) => daysBetween(list[i].date, t.date));
      if (gaps.every((g) => g >= 75 && g <= 105) && daysBetween(last.date, today) <= 120) {
        const [ly, lm] = last.date.split('-').map(Number);
        let next = dayInMonth(ly, lm + 3, usualDay);
        while (next < today) {
          const [ny, nm] = next.split('-').map(Number);
          next = dayInMonth(ny, nm + 3, usualDay);
        }
        out.push({ ...base, frequency: 'quarterly', nextDate: next });
      }
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

/** Card repayments are counted from the cards; van HP from Fleet › Finance. Say so rather than double them. */
export function alreadyCountedAs(name: string, hpLenders: string[]): 'card' | 'van_hp' | null {
  const n = normaliseName(name);
  if (/\b(capital on tap|american express|amex|barclaycard)\b/.test(n) || /\bcredit card\b/.test(n)) return 'card';
  if (hpLenders.some((l) => {
    const ln = normaliseName(l);
    return ln.length >= 3 && n.length >= 3 && (n.includes(ln) || ln.includes(n));
  })) return 'van_hp';
  return null;
}
