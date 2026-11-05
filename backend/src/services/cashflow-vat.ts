/**
 * Cash forecast — VAT by quarter (docs/CASHFLOW-FORECAST-SPEC.md §13.4). Pure maths.
 *
 * jon (Nov 2026): standard VAT accounting, quarters end Mar/Jun/Sep/Dec, paid by
 * direct debit on the 10th of the second month after (or the next working day).
 * The figure is TYPED on the Monday check-in from Xero's VAT return — Xero's own
 * number, adjustments included, which is what HMRC is actually paid. OP adds an
 * estimate for the rest of the quarter at the rate so far and puts it on the
 * payment date. Once the return is filed it goes in as a planned item, and the
 * estimate steps aside.
 *
 * A quarter's VAT can be NEGATIVE (a big purchase — the six vans in April 2027 —
 * leaves HMRC owing us). That is money in, never projected: a refund is counted at
 * what has actually been typed, so a one-off purchase is never multiplied out.
 */
import { Frequency, addDays, daysBetween, dayInMonth, expandRule, isWorkingDay } from './cashflow-schedule';

export interface VatQuarter {
  start: string;   // first day of the quarter
  end: string;     // last day of the quarter
  due: string;     // the direct debit date
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 1, 2 or 3: quarters end in that month and every third month after (3 = Mar/Jun/Sep/Dec). */
export function normaliseEndMonth(n: number): number {
  const m = Math.round(Number(n));
  if (!Number.isFinite(m) || m < 1) return 3;
  return ((m - 1) % 3) + 1;
}

/** The payment day of the month, kept to 1–28 so every month has it. */
export function normaliseDueDay(n: number): number {
  const d = Math.round(Number(n));
  if (!Number.isFinite(d) || d < 1) return 10;
  return Math.min(d, 28);
}

/** The next working day on or after `iso` (a Saturday 10th → Monday 12th). */
export function onOrNextWorkingDay(iso: string): string {
  let d = iso;
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** The VAT quarter that contains `date`. */
export function vatQuarterOf(date: string, endMonth: number, dueDay: number): VatQuarter {
  const em = normaliseEndMonth(endMonth);
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  // The first quarter-end month at or after this month.
  const endM = m + ((((em - m) % 3) + 3) % 3);
  const end = dayInMonth(y, endM, 31);
  const start = dayInMonth(y, endM - 2, 1);
  const due = onOrNextWorkingDay(dayInMonth(y, endM + 2, normaliseDueDay(dueDay)));
  return { start, end, due };
}

export const previousQuarter = (q: VatQuarter, endMonth: number, dueDay: number) => vatQuarterOf(addDays(q.start, -1), endMonth, dueDay);
export const nextQuarter = (q: VatQuarter, endMonth: number, dueDay: number) => vatQuarterOf(addDays(q.end, 1), endMonth, dueDay);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-11-10' → '10 Nov'. */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;
}

/** 'Jul–Sep 2026'. */
export function quarterLabel(q: VatQuarter): string {
  return `${MONTHS[Number(q.start.slice(5, 7)) - 1]}–${MONTHS[Number(q.end.slice(5, 7)) - 1]} ${q.end.slice(0, 4)}`;
}

/** A filed return (a planned VAT payment) within this many days of a quarter's due date is that quarter's. */
export const FILED_WINDOW_DAYS = 10;

/** Has this quarter's return gone in as a planned item? */
export function isFiled(q: VatQuarter, plannedVatDates: string[]): boolean {
  return plannedVatDates.some((d) => Math.abs(daysBetween(q.due, d)) <= FILED_WINDOW_DAYS);
}

/**
 * The quarter the Monday check-in asks about: the one just ended while its return
 * is still to file and pay (its figure is the most important one then), else the
 * one in progress.
 */
export function quarterToType(today: string, endMonth: number, dueDay: number, plannedVatDates: string[]): { quarter: VatQuarter; ended: boolean } {
  const current = vatQuarterOf(today, endMonth, dueDay);
  const prev = previousQuarter(current, endMonth, dueDay);
  if (today <= prev.due && !isFiled(prev, plannedVatDates)) return { quarter: prev, ended: true };
  return { quarter: current, ended: false };
}

/**
 * The whole quarter's VAT from the figure typed so far: plus the same daily rate
 * for the days still to come. Nothing is added once the quarter has ended, or when
 * the figure is zero or negative (a refund is never multiplied out).
 */
export function projectQuarterVat(typed: number, asOf: string, q: VatQuarter): { amount: number; projected: number } {
  if (!(typed > 0) || asOf >= q.end) return { amount: round2(typed), projected: 0 };
  const from = asOf < q.start ? q.start : asOf;
  const elapsed = daysBetween(q.start, from) + 1;
  const remaining = daysBetween(from, q.end);
  const projected = round2((typed / elapsed) * remaining);
  return { amount: round2(typed + projected), projected };
}

/** The fields of a planned item this file reads (cashflow-sources.ts PlannedItemRow). */
export interface PlannedVatLike {
  category: string;
  direction: 'in' | 'out';
  kind: 'rule' | 'schedule';
  amount: number | null;
  frequency: Frequency | null;
  startDate: string | null;
  endDate: string | null;
  dates: Array<{ date: string; amount: number }>;
}

/** Every planned VAT payment between `from` and `to` — a filed return. Out is negative. */
export function plannedVatPayments(planned: PlannedVatLike[], from: string, to: string): Array<{ date: string; amount: number }> {
  const out: Array<{ date: string; amount: number }> = [];
  for (const p of planned) {
    if (p.category !== 'vat') continue;
    const sign = p.direction === 'in' ? 1 : -1;
    if (p.kind === 'rule') {
      if (!p.frequency || !p.startDate || p.amount === null) continue;
      for (const d of expandRule({ frequency: p.frequency, start: p.startDate, end: p.endDate }, from, to)) out.push({ date: d, amount: sign * p.amount });
    } else {
      for (const d of p.dates) if (d.date >= from && d.date <= to) out.push({ date: d.date, amount: sign * d.amount });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
