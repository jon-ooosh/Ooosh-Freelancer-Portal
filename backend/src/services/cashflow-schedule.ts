/**
 * Cash forecast — the pure part (docs/CASHFLOW-FORECAST-SPEC.md).
 *
 * Date arithmetic, repeating-payment rules, the card simulation and the
 * YouLend cap. No database, no clock: every function takes the dates it needs,
 * so all of it is unit-tested (__tests__/cashflow-schedule.test.ts). The
 * gathering and assembling lives in services/cashflow-forecast.ts.
 *
 * Every date here is a UK calendar day as 'YYYY-MM-DD'. They are turned into
 * UTC midnights only to count days, so British Summer Time never shifts one.
 */
import { computeBankHolidayDates } from './bank-holidays';

// ── Dates ──────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Is this a real 'YYYY-MM-DD' date? */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  return fromUtc(toUtc(v)) === v;
}

export function addDays(iso: string, n: number): string {
  return fromUtc(toUtc(iso) + n * DAY_MS);
}

/** b − a, in days. */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  const d = new Date(toUtc(iso)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function mondayOf(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Day `day` of the given month, pulled back to the month's last day (31st → 30 Nov). */
export function dayInMonth(year: number, month1: number, day: number): string {
  // Normalise a month that has run past December or before January.
  const y = year + Math.floor((month1 - 1) / 12);
  const m = ((((month1 - 1) % 12) + 12) % 12) + 1;
  const d = Math.min(Math.max(day, 1), daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const holidayCache = new Map<number, Set<string>>();
function bankHolidays(year: number): Set<string> {
  let s = holidayCache.get(year);
  if (!s) {
    s = new Set(computeBankHolidayDates(year));
    holidayCache.set(year, s);
  }
  return s;
}

export function isWorkingDay(iso: string): boolean {
  if (isoWeekday(iso) >= 6) return false;
  return !bankHolidays(Number(iso.slice(0, 4))).has(iso);
}

/** The date `n` working days after `iso` (a Friday payment + 2 → Tuesday). */
export function addWorkingDays(iso: string, n: number): string {
  let d = iso;
  let left = Math.max(0, Math.floor(n));
  while (left > 0) {
    d = addDays(d, 1);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

// ── Repeating payments ─────────────────────────────────────────────────────

export type Frequency = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RepeatRule {
  frequency: Frequency;
  start: string;          // the first payment; its day of the month is the payment day
  end?: string | null;    // the last date a payment may fall on (inclusive)
}

/**
 * Every date a rule falls on between `from` and `to` (inclusive). A monthly
 * rule keeps the start's day of the month, pulled back in short months, so a
 * payment on the 31st lands on 30 Nov and 28 Feb.
 */
export function expandRule(rule: RepeatRule, from: string, to: string): string[] {
  if (!isIsoDate(rule.start)) return [];
  const last = rule.end && isIsoDate(rule.end) && rule.end < to ? rule.end : to;
  if (last < from) return [];
  const out: string[] = [];
  const push = (d: string) => { if (d >= from && d <= last) out.push(d); };

  if (rule.frequency === 'once') {
    push(rule.start);
    return out;
  }
  if (rule.frequency === 'weekly') {
    // Jump straight to the first week at or after `from` instead of walking from a start years ago.
    const skip = rule.start < from ? Math.floor(daysBetween(rule.start, from) / 7) : 0;
    for (let k = skip; ; k++) {
      const d = addDays(rule.start, k * 7);
      if (d > last) break;
      push(d);
    }
    return out;
  }
  const step = rule.frequency === 'monthly' ? 1 : rule.frequency === 'quarterly' ? 3 : 12;
  const sy = Number(rule.start.slice(0, 4));
  const sm = Number(rule.start.slice(5, 7));
  const sd = Number(rule.start.slice(8, 10));
  const monthsToFrom = (Number(from.slice(0, 4)) - sy) * 12 + (Number(from.slice(5, 7)) - sm);
  const skip = monthsToFrom > step ? Math.floor((monthsToFrom - 1) / step) : 0;
  for (let k = skip; ; k++) {
    const d = dayInMonth(sy, sm + k * step, sd);
    if (d > last) break;
    push(d);
  }
  return out;
}

/** The first `count` dates of a rule on or after `from` — the planned-item preview. */
export function nextDates(rule: RepeatRule, from: string, count: number): string[] {
  const out: string[] = [];
  let windowEnd = addDays(from, 400);
  for (let tries = 0; tries < 6 && out.length < count; tries++) {
    const got = expandRule(rule, from, windowEnd);
    if (got.length >= count || rule.frequency === 'once') return got.slice(0, count);
    windowEnd = addDays(windowEnd, 400 * 3);
  }
  return expandRule(rule, from, windowEnd).slice(0, count);
}

// ── Cards ──────────────────────────────────────────────────────────────────

export interface CardInput {
  monthlyRate: number;            // 0.0183 = 1.83% a month
  statementDay: number | null;
  paymentDay: number | null;
  plan: 'full' | 'minimum' | 'fixed';
  minPct: number | null;          // 10 = 10% of the statement balance
  fixedAmount: number | null;
  fixedEvery: 'week' | 'month' | null;
  fixedWeekday: number | null;    // 1 = Monday
  typicalMonthlySpend: number | null;
  balance: number;                // owed, from the last check-in
  balanceAsOf: string;
  /**
   * Typical spend is added only for days AFTER this (normally today). The days
   * before it are already in the balance: the check-in, plus card receipts
   * logged in OP since then. Defaults to the check-in date.
   */
  spendFrom?: string;
}

export interface CardSimulation {
  payments: Array<{ date: string; amount: number; note: string }>;   // cash out (positive £)
  interest: Array<{ date: string; amount: number }>;                 // added to the card (memo)
  balances: Array<{ date: string; balance: number }>;                // end of each day, from the day after the check-in
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function sameDayOfMonth(iso: string, day: number | null): boolean {
  if (!day) return false;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  return iso === dayInMonth(y, m, day);
}

/**
 * Day by day from the day after the check-in to `to`: spending (if a typical
 * monthly spend is set), interest on the statement day, and the plan's
 * payments. Payments are what leave the bank; interest only grows the card.
 *
 *   full    — the last statement balance, on the payment day. Before any
 *             statement has been simulated, the check-in balance stands in.
 *   minimum — min % of the last statement balance, on the payment day.
 *   fixed   — £X every week (on the chosen weekday) or every month (on the
 *             payment day), topped up on the payment day if everything paid
 *             since the last payment day falls short of the minimum. (Counted
 *             over the month, not since the statement: with £1,000 a week and a
 *             statement a week before the due day, "since the statement" would
 *             invent a ~£2,900 top-up jon doesn't make.)
 */
export function simulateCard(card: CardInput, to: string): CardSimulation {
  const res: CardSimulation = { payments: [], interest: [], balances: [] };
  let balance = Math.max(0, card.balance);
  let statementBalance = balance;
  let paidSinceStatement = 0;
  let paidSinceLastDue = 0;
  // Payments made before the check-in are invisible here, so the first payment
  // day can't be judged against the minimum: no top-up until a statement has
  // been simulated.
  let statementSeen = false;
  const dailySpend = card.typicalMonthlySpend && card.typicalMonthlySpend > 0 ? (card.typicalMonthlySpend * 12) / 365 : 0;
  const minFor = (stmt: number) => (card.minPct && card.minPct > 0 ? round2((stmt * card.minPct) / 100) : 0);

  const pay = (date: string, wanted: number, note: string) => {
    const amount = round2(Math.min(Math.max(wanted, 0), balance));
    if (amount <= 0) return;
    balance = round2(balance - amount);
    paidSinceStatement = round2(paidSinceStatement + amount);
    paidSinceLastDue = round2(paidSinceLastDue + amount);
    res.payments.push({ date, amount, note });
  };

  for (let d = addDays(card.balanceAsOf, 1); d <= to; d = addDays(d, 1)) {
    if (d > (card.spendFrom || card.balanceAsOf)) balance = round2(balance + dailySpend);

    if (sameDayOfMonth(d, card.statementDay)) {
      const interest = round2(balance * (card.monthlyRate || 0));
      if (interest > 0) {
        balance = round2(balance + interest);
        res.interest.push({ date: d, amount: interest });
      }
      statementBalance = balance;
      paidSinceStatement = 0;
      statementSeen = true;
    }

    if (card.plan === 'full' && sameDayOfMonth(d, card.paymentDay)) {
      pay(d, statementBalance - paidSinceStatement, 'statement balance in full');
    } else if (card.plan === 'minimum' && sameDayOfMonth(d, card.paymentDay)) {
      pay(d, minFor(statementBalance) - paidSinceStatement, 'minimum payment');
    } else if (card.plan === 'fixed') {
      const amount = card.fixedAmount || 0;
      if (card.fixedEvery === 'week' && isoWeekday(d) === (card.fixedWeekday || 1)) {
        pay(d, amount, 'weekly payment');
      } else if (card.fixedEvery === 'month' && sameDayOfMonth(d, card.paymentDay)) {
        pay(d, amount, 'monthly payment');
      }
      if (statementSeen && sameDayOfMonth(d, card.paymentDay)) {
        const shortfall = minFor(statementBalance) - paidSinceLastDue;
        if (shortfall > 0.005) pay(d, shortfall, 'top-up to the minimum');
      }
    }
    if (sameDayOfMonth(d, card.paymentDay)) paidSinceLastDue = 0;

    res.balances.push({ date: d, balance });
  }
  return res;
}

// ── YouLend ────────────────────────────────────────────────────────────────

export interface YoulendResult {
  withheld: Array<{ date: string; amount: number }>;   // positive £, per date
  remainingAtEnd: number;
  paidOffOn: string | null;                            // inside the forecast, if it gets there
}

/**
 * YouLend keeps `rate` of each Stripe receipt until `remaining` is paid. The
 * receipts must be in date order; the last one may be cut short by the cap.
 */
export function youlendWithholding(
  receipts: Array<{ date: string; amount: number }>,
  rate: number,
  remaining: number,
): YoulendResult {
  let left = Math.max(0, remaining);
  const byDate = new Map<string, number>();
  let paidOffOn: string | null = null;
  for (const r of receipts) {
    if (left <= 0) break;
    if (r.amount <= 0) continue;
    const take = round2(Math.min(r.amount * rate, left));
    left = round2(left - take);
    byDate.set(r.date, round2((byDate.get(r.date) || 0) + take));
    if (left <= 0) paidOffOn = r.date;
  }
  return {
    withheld: [...byDate.entries()].map(([date, amount]) => ({ date, amount })),
    remainingAtEnd: left,
    paidOffOn,
  };
}

/**
 * Past the end of the forecast: at the forecast's average weekly Stripe takings,
 * when would what's left be paid? Null when nothing comes through Stripe.
 */
export function youlendPayoffEstimate(remainingAtEnd: number, rate: number, avgWeeklyStripe: number, horizonEnd: string): string | null {
  if (remainingAtEnd <= 0) return null;
  const perWeek = avgWeeklyStripe * rate;
  if (perWeek <= 0) return null;
  return addDays(horizonEnd, Math.ceil(remainingAtEnd / perWeek) * 7);
}
