/**
 * Cash forecast — the builder (docs/CASHFLOW-FORECAST-SPEC.md). Phase 1: the
 * committed line, by week for 13 weeks and by day for the next 14.
 *
 * Rules it keeps (spec §1):
 *   - money in lands on the LATEST day it is due, money out on the EARLIEST;
 *   - Stripe money is spendable a few working days after it is paid, and loses
 *     Stripe's fee and YouLend's cut on the way — both shown as their own lines;
 *   - anything overdue (client balances, Xero bills) sits in its own pile, out of
 *     the line, until jon says to count it;
 *   - a scheduled payment (planned item, van HP, card) dated after the last
 *     check-in but before today has already left the bank, so it lands today;
 *   - card interest grows the card, it is not cash out: it is a memo row.
 *
 * Code computes every number here; nothing is learned or guessed by an AI.
 */
import { preauthEligibility } from './excess-preauth';
import { ukToday } from './uk-date';
import {
  addDays, addWorkingDays, daysBetween, expandRule, mondayOf, simulateCard,
  youlendPayoffEstimate, youlendWithholding,
} from './cashflow-schedule';
import {
  CashflowSettings, CardRow, PlannedItemRow, XeroBill,
  RECEIPT_SPEND_DAYS, cardReceiptSpend, loadCardReceipts,
  loadAccounts, loadBillFlags, loadCards, loadDepositsOnFutureJobs, loadExcessDue, loadExcessHeld,
  loadJobBalances, loadPlannedItems, loadRefundsOwed, loadSettings, loadVanFinance, loadXeroBills, readStripe,
} from './cashflow-sources';

export const WEEKS = 13;
export const DAYS = 14;
/** A finished hire whose excess is still held after this long is a "check" item, not next week's refund. */
const STALE_EXCESS_DAYS = 30;

export type RowKey =
  | 'hire_balance' | 'excess_in' | 'stripe_pending' | 'stripe_payout' | 'planned_in'
  | 'xero_bill' | 'overheads' | 'payroll' | 'vat_tax' | 'instalments' | 'one_off' | 'other_out'
  | 'van_hp' | 'excess_refund' | 'refund_owed' | 'stripe_fee' | 'youlend' | 'card_payment';

/** The table's rows, top to bottom. THE list — the page draws exactly these. */
export const ROWS: Array<{ key: RowKey; label: string; direction: 'in' | 'out'; clientMoney?: boolean }> = [
  { key: 'hire_balance', label: 'Hire balances', direction: 'in' },
  { key: 'excess_in', label: 'Excess in', direction: 'in', clientMoney: true },
  { key: 'stripe_pending', label: 'Already in Stripe', direction: 'in' },
  { key: 'stripe_payout', label: 'Stripe payouts on the way', direction: 'in' },
  { key: 'planned_in', label: 'Planned income', direction: 'in' },
  { key: 'xero_bill', label: 'Xero bills', direction: 'out' },
  { key: 'overheads', label: 'Rent, rates & direct debits', direction: 'out' },
  { key: 'payroll', label: 'Payroll & PAYE', direction: 'out' },
  { key: 'vat_tax', label: 'VAT & tax', direction: 'out' },
  { key: 'instalments', label: 'Instalment plans', direction: 'out' },
  { key: 'van_hp', label: 'Van HP', direction: 'out' },
  { key: 'one_off', label: 'One-offs', direction: 'out' },
  { key: 'other_out', label: 'Other planned', direction: 'out' },
  { key: 'excess_refund', label: 'Excess refunds', direction: 'out', clientMoney: true },
  { key: 'refund_owed', label: 'Refunds owed', direction: 'out' },
  { key: 'stripe_fee', label: 'Stripe fees', direction: 'out' },
  { key: 'youlend', label: 'YouLend', direction: 'out' },
  { key: 'card_payment', label: 'Card payments', direction: 'out' },
];

export interface FlowItem {
  date: string;                 // where the forecast puts it
  amount: number;               // + in, − out
  row: RowKey;
  label: string;
  detail?: string;
  windowFrom?: string;
  windowTo?: string;
  clientMoney?: boolean;
  link?: { type: 'job' | 'vehicle' | 'planned' | 'xero_bill' | 'card' | 'settings'; id?: string };
}

export interface PileItem {
  id: string;
  label: string;
  detail: string;
  amount: number;
  date: string | null;
  link?: FlowItem['link'];
  contactId?: string | null;
  contactName?: string;
}

export interface Period {
  start: string;
  end: string;
  opening: number;
  closing: number;
  totalIn: number;
  totalOut: number;
  byRow: Partial<Record<RowKey, number>>;
  interestMemo: number;
}

export interface Warning { code: string; message: string }

export interface Forecast {
  today: string;
  firstMonday: string;
  horizonEnd: string;
  checkIn: { asOf: string | null; ageDays: number | null; stale: boolean; missing: string[] };
  opening: { total: number; mainAccount: number | null; accounts: Array<{ id: string; name: string; kind: string; balance: number | null; asOf: string | null; source: 'check_in' | 'stripe_live' | 'missing' }> };
  yours: { total: number; excessHeld: number; refundsOwed: number; vatOwed: number; vatDue: string | null; depositsOnFutureJobs: number };
  settings: CashflowSettings;
  rows: typeof ROWS;
  weeks: Period[];
  days: Period[];
  items: FlowItem[];
  interest: Array<{ date: string; amount: number; card: string }>;
  lowest: { week: { start: string; closing: number } | null; day: { date: string; closing: number } | null };
  piles: { overdueBills: PileItem[]; overdueBalances: PileItem[]; staleExcess: PileItem[]; noDate: PileItem[] };
  cards: Array<{
    id: string; name: string; balance: number | null; asOf: string | null; creditLimit: number | null; headroom: number | null;
    interestThisMonth: number; plan: string; weeklyBalances: Array<number | null>;
    /** The Monday figure, before receipts logged since. */
    checkInBalance: number | null;
    /** Card receipts logged in Costs dated after the check-in — already added to `balance`. */
    loggedSince: number;
    loggedSinceCount: number;
    /** The typical monthly spend the line uses, and where it came from. */
    typicalMonthlySpend: number | null;
    spendSource: 'typed' | 'receipts' | 'none';
    /** The last 90 days of logged receipts, as a monthly figure (shown even when a figure is typed). */
    receiptsMonthly: number;
    receiptsCount: number;
    costPaymentMethod: string | null;
  }>;
  youlend: { rate: number; remaining: number; asOf: string | null; withheldInForecast: number; remainingAtEnd: number; paidOffOn: string | null; estimatedPayoff: string | null };
  stripe: { live: boolean; reason?: string; available: number; feeRate: number; feeRateSource: 'stripe' | 'setting'; payoutDays: number; share: number };
  xero: { ok: boolean; reason?: string; unpaidBills: number };
  planned: Array<{ id: string; label: string; message: string }>;
  vanFinanceMissing: Array<{ vehicleId: string; reg: string; lender: string }>;
  warnings: Warning[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const gbp = (n: number) => `£${Math.abs(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const later = (a: string, b: string) => (a > b ? a : b);

const PLANNED_ROW: Record<PlannedItemRow['category'], RowKey> = {
  overheads: 'overheads', payroll: 'payroll', vat: 'vat_tax', tax: 'vat_tax',
  instalments: 'instalments', one_off: 'one_off', income: 'planned_in', other: 'other_out',
};

/** A Xero bill near a planned date, for a similar amount, replaces that occurrence (§5.4). */
function findMatchingBill(bills: XeroBill[], used: Set<string>, contactId: string, date: string, amount: number): XeroBill | null {
  for (const b of bills) {
    if (used.has(b.id) || b.contactId !== contactId) continue;
    const when = b.due || b.date;
    if (!when || Math.abs(daysBetween(date, when)) > 7) continue;
    if (Math.abs(b.amountDue - amount) > Math.abs(amount) * 0.1) continue;
    return b;
  }
  return null;
}

export async function buildForecast(opts: { fresh?: boolean } = {}): Promise<Forecast> {
  const today = ukToday();
  const firstMonday = mondayOf(today);
  const horizonEnd = addDays(firstMonday, WEEKS * 7 - 1);
  const nextMonday = addDays(firstMonday, 7);
  const warnings: Warning[] = [];

  const [settings, accounts, cards, jobs, excessDue, excessHeld, refunds, vans, planned, flags, xero, stripe, depositsFuture] =
    await Promise.all([
      loadSettings(), loadAccounts(), loadCards(), loadJobBalances(), loadExcessDue(today), loadExcessHeld(),
      loadRefundsOwed(), loadVanFinance(), loadPlannedItems(), loadBillFlags(), loadXeroBills(!!opts.fresh),
      readStripe(!!opts.fresh), loadDepositsOnFutureJobs(today),
    ]);

  const items: FlowItem[] = [];
  const piles: Forecast['piles'] = { overdueBills: [], overdueBalances: [], staleExcess: [], noDate: [] };

  // ── Opening balance ───────────────────────────────────────────────────────
  const stripeLive = stripe.ok;
  const openingAccounts: Forecast['opening']['accounts'] = [];
  const missing: string[] = [];
  let openingTotal = 0;
  let mainAccount: number | null = null;
  let checkInAsOf: string | null = null;
  for (const a of accounts) {
    if (a.kind === 'stripe' && stripeLive) {
      openingAccounts.push({ id: a.id, name: a.name, kind: a.kind, balance: round2(stripe.available), asOf: today, source: 'stripe_live' });
      openingTotal += stripe.available;
      continue;
    }
    if (a.balance === null) {
      missing.push(a.name);
      openingAccounts.push({ id: a.id, name: a.name, kind: a.kind, balance: null, asOf: null, source: 'missing' });
      continue;
    }
    openingAccounts.push({ id: a.id, name: a.name, kind: a.kind, balance: a.balance, asOf: a.asOf, source: 'check_in' });
    openingTotal += a.balance;
    if (a.isMain) mainAccount = a.balance;
    if (a.asOf && (!checkInAsOf || a.asOf > checkInAsOf)) checkInAsOf = a.asOf;
  }
  const checkInAge = checkInAsOf ? daysBetween(checkInAsOf, today) : null;
  const checkInStale = checkInAge === null || checkInAge > 7;
  // Scheduled payments after the check-in have left the bank since; on or before it, they're in the balance.
  const scheduledFrom = checkInAsOf ? addDays(checkInAsOf, 1) : today;
  if (!checkInAsOf) warnings.push({ code: 'no_check_in', message: 'No balances yet — do the Monday check-in so the forecast has somewhere to start.' });
  else if (checkInStale) warnings.push({ code: 'stale_check_in', message: `The forecast starts from balances confirmed on ${checkInAsOf}, ${checkInAge} days ago.` });
  if (missing.length && checkInAsOf) warnings.push({ code: 'missing_balance', message: `No balance yet for: ${missing.join(', ')}.` });
  if (!stripeLive) warnings.push({ code: 'stripe_unavailable', message: `${stripe.reason || 'Stripe could not be read.'} Stripe is taken from the check-in instead.` });

  /** A scheduled payment: before the check-in it's already in the balance; after it but before today, it went today. */
  const placeScheduled = (date: string): string | null => {
    if (date < scheduledFrom) return null;
    return later(date, today);
  };

  // Stripe money: spendable a few working days after it is paid.
  const payoutDays = Math.max(0, Math.round(settings.stripePayoutDays));
  const spendable = (date: string) => addWorkingDays(date, payoutDays);
  const stripeInflows: Array<{ date: string; amount: number }> = [];

  // ── Money in: booked jobs' balances ───────────────────────────────────────
  for (const j of jobs) {
    const due = j.creditDays ? (j.end || j.start ? addDays((j.end || j.start) as string, j.creditDays) : null) : j.start;
    const label = `${j.hh ? `#${j.hh} ` : ''}${j.client || j.name}`;
    const link = { type: 'job' as const, id: j.jobId };
    const detail = [
      j.name,
      j.depositsPaid > 0.01 ? `${gbp(j.depositsPaid)} paid of ${gbp(j.hireValue)}` : 'no deposit yet',
      j.creditDays ? `${j.creditDays} days credit` : null,
    ].filter(Boolean).join(' · ');
    if (!due) {
      piles.noDate.push({ id: j.jobId, label, detail: `${detail} · no hire dates`, amount: j.balance, date: null, link });
      continue;
    }
    if (due < today) {
      piles.overdueBalances.push({ id: j.jobId, label, detail: `${detail} · was due ${due}`, amount: j.balance, date: due, link });
      if (!settings.countOverdueBalances) continue;
      const when = spendable(nextMonday);
      items.push({ date: when, amount: j.balance, row: 'hire_balance', label, detail: `${detail} · overdue since ${due}, counted from next week`, link });
      stripeInflows.push({ date: when, amount: j.balance });
      continue;
    }
    const when = spendable(due);
    items.push({ date: when, amount: j.balance, row: 'hire_balance', label, detail, windowFrom: today, windowTo: due, link });
    stripeInflows.push({ date: when, amount: j.balance });
  }

  // ── Money in: excess on hires about to start (client money) ───────────────
  // Hires of 4 days or fewer take a pre-auth — a hold, not cash — so they're left out.
  for (const e of excessDue) {
    if (preauthEligibility(e.startRaw, e.endRaw, e.startRaw ? new Date(e.startRaw) : undefined).allowed) continue;
    const when = spendable(e.start);
    items.push({
      date: when, amount: e.owed, row: 'excess_in', clientMoney: true,
      label: `${e.hh ? `#${e.hh} ` : ''}${e.client}`, detail: 'excess due on the first day', windowTo: e.start,
      link: e.jobId ? { type: 'job', id: e.jobId } : undefined,
    });
    stripeInflows.push({ date: when, amount: e.owed });
  }

  // ── Money in: already in Stripe, and payouts on their way ─────────────────
  if (stripeLive) {
    for (const p of stripe.pending) {
      const date = p.date ? later(p.date, today) : spendable(today);
      items.push({ date, amount: p.amount, row: 'stripe_pending', label: 'Stripe balance becoming available', detail: 'after Stripe\'s fees' });
    }
    // A payout that reached the bank after the main account was checked isn't in either figure yet.
    const mainAsOf = accounts.find((a) => a.isMain)?.asOf || checkInAsOf;
    for (const p of stripe.payouts) {
      if (mainAsOf && p.date <= mainAsOf) continue;
      items.push({
        date: later(p.date, today), amount: p.amount, row: 'stripe_payout', label: 'Stripe payout',
        detail: p.status === 'paid' ? `arrived ${p.date}, after the check-in` : `arriving ${p.date}`,
      });
    }
  }

  // ── Money out: Xero bills ─────────────────────────────────────────────────
  const instalmentBillIds = new Set(planned.filter((p) => p.xeroBillId).map((p) => p.xeroBillId as string));
  const xeroBills = xero.ok ? xero.bills : [];
  const billsInPlay = xeroBills.filter((b) =>
    !flags.byBill.has(b.id) && !(b.contactId && flags.excludedContacts.has(b.contactId)) && !instalmentBillIds.has(b.id));
  if (!xero.ok) warnings.push({ code: 'xero_unavailable', message: `${xero.reason} Bills from Xero are missing from the forecast.` });

  // Planned items linked to a supplier give way to that supplier's real bills.
  const matchedBills = new Set<string>();
  const plannedNotes: Forecast['planned'] = [];

  for (const p of planned) {
    const sign = p.direction === 'in' ? 1 : -1;
    const row = PLANNED_ROW[p.category];
    const link = { type: 'planned' as const, id: p.id };

    if (p.kind === 'rule') {
      if (!p.frequency || !p.startDate || p.amount === null) continue;
      for (const d of expandRule({ frequency: p.frequency, start: p.startDate, end: p.endDate }, scheduledFrom, horizonEnd)) {
        if (p.xeroContactId) {
          const bill = findMatchingBill(billsInPlay, matchedBills, p.xeroContactId, d, p.amount);
          if (bill) { matchedBills.add(bill.id); continue; }
        }
        const when = placeScheduled(d);
        if (!when) continue;
        items.push({ date: when, amount: sign * p.amount, row, label: p.label, detail: when !== d ? `due ${d}, since the check-in` : undefined, link });
      }
      continue;
    }

    // A schedule — every payment typed out.
    let future = 0;
    for (const row2 of p.dates) {
      const when = placeScheduled(row2.date);
      if (!when || row2.date > horizonEnd) {
        if (row2.date > horizonEnd) future += row2.amount;
        continue;
      }
      future += row2.amount;
      items.push({ date: when, amount: sign * row2.amount, row, label: p.label, detail: when !== row2.date ? `due ${row2.date}, since the check-in` : undefined, link });
    }
    if (p.xeroBillId && xero.ok) {
      const bill = xeroBills.find((b) => b.id === p.xeroBillId);
      if (!bill) {
        plannedNotes.push({ id: p.id, label: p.label, message: 'Xero shows this bill as paid (or gone) — its remaining payments may not be needed.' });
      } else if (Math.abs(bill.amountDue - future) > 0.5) {
        const diff = round2(bill.amountDue - future);
        plannedNotes.push({
          id: p.id, label: p.label,
          message: `Payments still to come total ${gbp(future)}; Xero says ${gbp(bill.amountDue)} is owed (${diff > 0 ? `${gbp(diff)} more` : `${gbp(diff)} less`}). If the bookkeeper is behind, this is usually one payment that's gone but isn't recorded yet.`,
        });
      }
    } else if (!p.xeroBillId && p.expectedTotal !== null) {
      const total = p.dates.reduce((s, d) => s + d.amount, 0);
      if (Math.abs(total - p.expectedTotal) > 0.5) {
        plannedNotes.push({ id: p.id, label: p.label, message: `The payments add up to ${gbp(total)}, not the ${gbp(p.expectedTotal)} expected.` });
      }
    }
  }

  for (const b of billsInPlay) {
    const when = b.due || b.date || today;
    const label = b.contactName;
    const detail = [b.number || b.reference, b.amountDue < b.total - 0.01 ? `${gbp(b.amountDue)} left of ${gbp(b.total)}` : null, matchedBills.has(b.id) ? 'replaces a planned payment' : null]
      .filter(Boolean).join(' · ');
    const link = { type: 'xero_bill' as const, id: b.id };
    if (when < today) {
      piles.overdueBills.push({ id: b.id, label, detail: `${detail ? `${detail} · ` : ''}due ${when}`, amount: b.amountDue, date: when, link, contactId: b.contactId, contactName: b.contactName });
      if (!settings.countOverdueBills) continue;
      items.push({ date: nextMonday, amount: -b.amountDue, row: 'xero_bill', label, detail: `${detail ? `${detail} · ` : ''}overdue since ${when}, counted from next week`, link });
      continue;
    }
    items.push({ date: when, amount: -b.amountDue, row: 'xero_bill', label, detail: detail || undefined, link });
  }

  // ── Money out: van HP (fleet finance) ─────────────────────────────────────
  const vanFinanceMissing: Forecast['vanFinanceMissing'] = [];
  for (const v of vans) {
    if (v.ends && v.ends < scheduledFrom) continue;          // paid off
    if (!v.monthly || v.monthly <= 0) {
      vanFinanceMissing.push({ vehicleId: v.vehicleId, reg: v.reg, lender: v.lender });
      continue;
    }
    // The payment day is finance_start's day of the month (the 1st when it isn't set).
    const start = v.start || `${firstMonday.slice(0, 7)}-01`;
    for (const d of expandRule({ frequency: 'monthly', start, end: v.ends }, scheduledFrom, horizonEnd)) {
      const when = placeScheduled(d);
      if (!when) continue;
      items.push({
        date: when, amount: -v.monthly, row: 'van_hp', label: `${v.reg} · ${v.lender}`,
        detail: v.ends ? `last payment ${v.ends.slice(0, 7)}` : 'no end date set', link: { type: 'vehicle', id: v.vehicleId },
      });
    }
  }
  if (vanFinanceMissing.length) {
    warnings.push({ code: 'van_finance_missing', message: `${vanFinanceMissing.length} financed van${vanFinanceMissing.length === 1 ? ' has' : 's have'} no monthly payment set (Fleet › Finance), so ${vanFinanceMissing.length === 1 ? 'it is' : 'they are'} missing from the forecast.` });
  }

  // ── Money out: excess refunds and refunds owed ────────────────────────────
  let excessHeldTotal = 0;
  for (const e of excessHeld) {
    excessHeldTotal += e.cash;
    if (e.onAccount) continue;                               // standing cover, never refunded by the forecast
    const label = `${e.hh ? `#${e.hh} ` : ''}${e.client}`;
    const link = e.jobId ? { type: 'job' as const, id: e.jobId } : undefined;
    if (!e.jobId || (!e.finishedOn && e.status !== 'cancelled' && e.status !== 'lost')) {
      piles.noDate.push({ id: e.excessId, label, detail: 'excess held, no return date', amount: -e.cash, date: null, link });
      continue;
    }
    const deadJob = e.status === 'cancelled' || e.status === 'lost';
    if (!deadJob && e.finishedOn && daysBetween(e.finishedOn, today) > STALE_EXCESS_DAYS) {
      piles.staleExcess.push({ id: e.excessId, label, detail: `hire finished ${e.finishedOn}`, amount: -e.cash, date: e.finishedOn, link });
      continue;
    }
    const due = deadJob || !e.finishedOn ? today : addDays(e.finishedOn, Math.max(0, Math.round(settings.excessRefundDays)));
    items.push({
      date: later(due, today), amount: -e.cash, row: 'excess_refund', clientMoney: true, label,
      detail: deadJob ? `job ${e.status}` : `back ${e.finishedOn}, refunded ${settings.excessRefundDays} days later`, link,
    });
  }
  let refundsOwedTotal = 0;
  for (const r of refunds) {
    refundsOwedTotal += r.amount;
    items.push({
      date: today, amount: -r.amount, row: 'refund_owed', label: `${r.hh ? `#${r.hh} ` : ''}${r.client}`,
      detail: 'refund agreed, not yet paid', link: r.jobId ? { type: 'job', id: r.jobId } : undefined,
    });
  }

  // ── Stripe fees and YouLend, on the Stripe share of what comes in ─────────
  const share = Math.min(Math.max(settings.stripeShare, 0), 1);
  const feeRate = stripe.feeRate ?? settings.stripeFeeRate;
  const feeSource: 'stripe' | 'setting' = stripe.feeRate !== null ? 'stripe' : 'setting';
  const stripeByDate = new Map<string, number>();
  for (const s of stripeInflows) {
    if (s.date > horizonEnd) continue;
    stripeByDate.set(s.date, (stripeByDate.get(s.date) || 0) + s.amount * share);
  }
  const stripeDates = [...stripeByDate.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [date, amount] of stripeDates) {
    const fee = round2(amount * feeRate);
    if (fee > 0) items.push({ date, amount: -fee, row: 'stripe_fee', label: 'Stripe fees', detail: `${(feeRate * 100).toFixed(2)}% of ${gbp(amount)} expected through Stripe` });
  }
  const yl = youlendWithholding(stripeDates.map(([date, amount]) => ({ date, amount })), settings.youlendRate, settings.youlendRemaining);
  for (const w of yl.withheld) {
    items.push({ date: w.date, amount: -w.amount, row: 'youlend', label: 'YouLend', detail: `${Math.round(settings.youlendRate * 100)}% of the Stripe takings` });
  }
  const stripeTotal = stripeDates.reduce((s, [, a]) => s + a, 0);
  const estimatedPayoff = yl.paidOffOn ? null : youlendPayoffEstimate(yl.remainingAtEnd, settings.youlendRate, stripeTotal / WEEKS, horizonEnd);

  // ── Cards ─────────────────────────────────────────────────────────────────
  // The balance is the Monday check-in PLUS card receipts logged in Costs since
  // (jon, Nov 2026: "immediate updates on cards put through OP"). Typical spend
  // is typed, else the last 90 days of logged receipts — and it only accrues
  // from today, because the days before are already in that balance.
  const interest: Forecast['interest'] = [];
  const cardsOut: Forecast['cards'] = [];
  const receiptWindowStart = addDays(today, -RECEIPT_SPEND_DAYS + 1);
  const earliestCardCheckIn = (cards as CardRow[]).reduce<string>((min, c) => (c.asOf && c.asOf < min ? c.asOf : min), receiptWindowStart);
  const cardReceipts = (cards as CardRow[]).some((c) => c.costPaymentMethod) ? await loadCardReceipts(earliestCardCheckIn) : [];
  for (const c of cards as CardRow[]) {
    const spend = cardReceiptSpend(cardReceipts, c.costPaymentMethod, c.asOf, today, receiptWindowStart);
    const typed = c.typicalMonthlySpend !== null && c.typicalMonthlySpend > 0 ? c.typicalMonthlySpend : null;
    const fromReceipts = !typed && spend.count > 0 && spend.monthly > 0 ? spend.monthly : null;
    const typical = typed ?? fromReceipts;
    const spendSource: 'typed' | 'receipts' | 'none' = typed ? 'typed' : fromReceipts ? 'receipts' : 'none';
    const base = {
      id: c.id, name: c.name, creditLimit: c.creditLimit, plan: c.plan,
      typicalMonthlySpend: typical, spendSource, receiptsMonthly: spend.monthly, receiptsCount: spend.count,
      costPaymentMethod: c.costPaymentMethod,
    };
    if (c.balance === null || !c.asOf) {
      cardsOut.push({ ...base, balance: null, asOf: null, headroom: null, interestThisMonth: 0, weeklyBalances: [], checkInBalance: null, loggedSince: 0, loggedSinceCount: 0 });
      continue;
    }
    const balanceNow = round2(c.balance + spend.sinceCheckIn);
    const sim = simulateCard({
      monthlyRate: c.monthlyRate, statementDay: c.statementDay, paymentDay: c.paymentDay, plan: c.plan,
      minPct: c.minPct, fixedAmount: c.fixedAmount, fixedEvery: c.fixedEvery, fixedWeekday: c.fixedWeekday,
      typicalMonthlySpend: typical, balance: balanceNow, balanceAsOf: c.asOf, spendFrom: today,
    }, horizonEnd);
    for (const p of sim.payments) {
      const when = later(p.date, today);
      items.push({ date: when, amount: -p.amount, row: 'card_payment', label: c.name, detail: when !== p.date ? `${p.note}, due ${p.date} (since the check-in)` : p.note, link: { type: 'card', id: c.id } });
    }
    for (const i of sim.interest) interest.push({ date: later(i.date, today), amount: i.amount, card: c.name });
    const weeklyBalances: Array<number | null> = [];
    for (let w = 0; w < WEEKS; w++) {
      const end = addDays(firstMonday, w * 7 + 6);
      const point = [...sim.balances].reverse().find((b) => b.date <= end);
      weeklyBalances.push(point ? point.balance : (end >= c.asOf ? balanceNow : null));
    }
    cardsOut.push({
      ...base, balance: balanceNow, asOf: c.asOf, checkInBalance: c.balance,
      loggedSince: spend.sinceCheckIn, loggedSinceCount: spend.sinceCount,
      headroom: c.creditLimit !== null ? round2(c.creditLimit - balanceNow) : null,
      interestThisMonth: round2(balanceNow * c.monthlyRate), weeklyBalances,
    });
  }

  // ── Into weeks and days ───────────────────────────────────────────────────
  const inRange = items.filter((i) => i.date >= today && i.date <= horizonEnd);
  const bucket = (start: string, end: string, opening: number): Period => {
    const byRow: Partial<Record<RowKey, number>> = {};
    let totalIn = 0;
    let totalOut = 0;
    for (const i of inRange) {
      if (i.date < start || i.date > end) continue;
      byRow[i.row] = round2((byRow[i.row] || 0) + i.amount);
      if (i.amount >= 0) totalIn += i.amount; else totalOut += i.amount;
    }
    const interestMemo = round2(interest.filter((x) => x.date >= start && x.date <= end).reduce((s, x) => s + x.amount, 0));
    return { start, end, opening: round2(opening), closing: round2(opening + totalIn + totalOut), totalIn: round2(totalIn), totalOut: round2(totalOut), byRow, interestMemo };
  };

  const weeks: Period[] = [];
  let running = openingTotal;
  for (let w = 0; w < WEEKS; w++) {
    const p = bucket(addDays(firstMonday, w * 7), addDays(firstMonday, w * 7 + 6), running);
    weeks.push(p);
    running = p.closing;
  }
  const days: Period[] = [];
  running = openingTotal;
  for (let d = 0; d < DAYS; d++) {
    const date = addDays(today, d);
    const p = bucket(date, date, running);
    days.push(p);
    running = p.closing;
  }
  const lowWeek = weeks.reduce<Period | null>((lo, p) => (!lo || p.closing < lo.closing ? p : lo), null);
  const lowDay = days.reduce<Period | null>((lo, p) => (!lo || p.closing < lo.closing ? p : lo), null);

  // ── Cash that's yours (§4) ────────────────────────────────────────────────
  const vatItem = planned.find((p) => p.category === 'vat');
  let vatOwed = 0;
  let vatDue: string | null = null;
  if (vatItem) {
    const next = vatItem.kind === 'rule' && vatItem.frequency && vatItem.startDate && vatItem.amount !== null
      ? expandRule({ frequency: vatItem.frequency, start: vatItem.startDate, end: vatItem.endDate }, today, addDays(today, 400))[0]
      : vatItem.dates.find((d) => d.date >= today)?.date;
    if (next) {
      vatDue = next;
      vatOwed = vatItem.kind === 'rule' ? vatItem.amount || 0 : vatItem.dates.find((d) => d.date === next)?.amount || 0;
    }
  }

  if (piles.overdueBills.length && !settings.countOverdueBills) {
    const t = piles.overdueBills.reduce((s, b) => s + b.amount, 0);
    warnings.push({ code: 'overdue_bills', message: `${gbp(t)} of bills are overdue in Xero (${piles.overdueBills.length}) — not in the forecast until checked.` });
  }
  if (piles.overdueBalances.length && !settings.countOverdueBalances) {
    const t = piles.overdueBalances.reduce((s, b) => s + b.amount, 0);
    warnings.push({ code: 'overdue_balances', message: `${gbp(t)} owed on ${piles.overdueBalances.length} hire${piles.overdueBalances.length === 1 ? '' : 's'} that should already have paid — not counted until chased.` });
  }
  if (piles.staleExcess.length) {
    const t = piles.staleExcess.reduce((s, b) => s + Math.abs(b.amount), 0);
    warnings.push({ code: 'stale_excess', message: `${gbp(t)} of excess is still held on hires that finished over ${STALE_EXCESS_DAYS} days ago — not in the forecast; check whether it's owed back.` });
  }
  if (plannedNotes.length) warnings.push({ code: 'planned_mismatch', message: `${plannedNotes.length} planned item${plannedNotes.length === 1 ? ' needs' : 's need'} a look (see Planned items).` });

  return {
    today, firstMonday, horizonEnd,
    checkIn: { asOf: checkInAsOf, ageDays: checkInAge, stale: checkInStale, missing },
    opening: { total: round2(openingTotal), mainAccount, accounts: openingAccounts },
    yours: {
      total: round2(openingTotal - excessHeldTotal - refundsOwedTotal - vatOwed),
      excessHeld: round2(excessHeldTotal), refundsOwed: round2(refundsOwedTotal), vatOwed: round2(vatOwed), vatDue,
      depositsOnFutureJobs: round2(depositsFuture),
    },
    settings,
    rows: ROWS,
    weeks,
    days,
    items: inRange.sort((a, b) => a.date.localeCompare(b.date) || a.amount - b.amount),
    interest,
    lowest: {
      week: lowWeek ? { start: lowWeek.start, closing: lowWeek.closing } : null,
      day: lowDay ? { date: lowDay.start, closing: lowDay.closing } : null,
    },
    piles,
    cards: cardsOut,
    youlend: {
      rate: settings.youlendRate, remaining: settings.youlendRemaining, asOf: settings.youlendAsOf,
      withheldInForecast: round2(settings.youlendRemaining - yl.remainingAtEnd), remainingAtEnd: yl.remainingAtEnd,
      paidOffOn: yl.paidOffOn, estimatedPayoff,
    },
    stripe: { live: stripeLive, reason: stripe.reason, available: round2(stripe.available), feeRate, feeRateSource: feeSource, payoutDays, share },
    xero: { ok: xero.ok, reason: xero.ok ? undefined : xero.reason, unpaidBills: xeroBills.length },
    planned: plannedNotes,
    vanFinanceMissing,
    warnings,
  };
}
