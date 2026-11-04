/**
 * Cash forecast — shapes and small helpers for the page (docs/CASHFLOW-FORECAST-SPEC.md).
 * The figures are all computed by the backend (services/cashflow-forecast.ts);
 * this file only describes them and formats them.
 */

export type RowKey =
  | 'hire_balance' | 'excess_in' | 'stripe_pending' | 'stripe_payout' | 'planned_in'
  | 'xero_bill' | 'overheads' | 'payroll' | 'vat_tax' | 'instalments' | 'one_off' | 'other_out'
  | 'van_hp' | 'excess_refund' | 'refund_owed' | 'stripe_fee' | 'youlend' | 'card_payment' | 'freelancers'
  | 'pipeline_likely' | 'pipeline_possible';

export interface FlowItem {
  date: string;
  amount: number;
  row: RowKey;
  label: string;
  detail?: string;
  windowFrom?: string;
  windowTo?: string;
  clientMoney?: boolean;
  link?: { type: 'job' | 'vehicle' | 'planned' | 'xero_bill' | 'card' | 'settings'; id?: string };
  /** Weighted enquiry money only. */
  tier?: 'likely' | 'possible';
}

export interface FixAction {
  key: 'chase_overdue' | 'ask_early' | 'nudge_enquiries' | 'move_bills' | 'card_headroom' | 'bank_transfer';
  title: string;
  detail: string;
  amount: number | null;
  links: Array<{ label: string; jobId?: string; billId?: string }>;
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
  likelyIn: number;
  possibleIn: number;
  closingLikely: number;
  closingPossible: number;
}

export interface CashflowSettings {
  targetFloor: number;
  overdraftLimit: number;
  youlendRate: number;
  youlendRemaining: number;
  youlendAsOf: string | null;
  stripeShare: number;
  stripeFeeRate: number;
  stripePayoutDays: number;
  excessRefundDays: number;
  countOverdueBills: boolean;
  countOverdueBalances: boolean;
  suggestBankTransfer: boolean;
  weightProvisional: number;
  weightHot: number;
  weightWarm: number;
  weightCold: number;
  weightUnset: number;
  likelyThreshold: number;
}

export interface Forecast {
  today: string;
  firstMonday: string;
  horizonEnd: string;
  checkIn: { asOf: string | null; ageDays: number | null; stale: boolean; missing: string[] };
  opening: {
    total: number;
    mainAccount: number | null;
    accounts: Array<{ id: string; name: string; kind: string; balance: number | null; asOf: string | null; source: 'check_in' | 'stripe_live' | 'missing' }>;
  };
  yours: { total: number; excessHeld: number; refundsOwed: number; vatOwed: number; vatDue: string | null; depositsOnFutureJobs: number };
  settings: CashflowSettings;
  rows: Array<{ key: RowKey; label: string; direction: 'in' | 'out'; clientMoney?: boolean }>;
  weeks: Period[];
  days: Period[];
  items: FlowItem[];
  interest: Array<{ date: string; amount: number; card: string }>;
  lowest: { week: { start: string; closing: number } | null; day: { date: string; closing: number } | null };
  piles: { overdueBills: PileItem[]; overdueBalances: PileItem[]; staleExcess: PileItem[]; noDate: PileItem[] };
  cards: Array<{
    id: string; name: string; balance: number | null; asOf: string | null; creditLimit: number | null; headroom: number | null;
    interestThisMonth: number; plan: string; weeklyBalances: Array<number | null>;
    checkInBalance: number | null; loggedSince: number; loggedSinceCount: number;
    typicalMonthlySpend: number | null; spendSource: 'typed' | 'receipts' | 'none';
    receiptsMonthly: number; receiptsCount: number; costPaymentMethod: string | null;
  }>;
  youlend: { rate: number; remaining: number; asOf: string | null; withheldInForecast: number; remainingAtEnd: number; paidOffOn: string | null; estimatedPayoff: string | null };
  stripe: { live: boolean; reason?: string; available: number; feeRate: number; feeRateSource: 'stripe' | 'setting'; payoutDays: number; share: number };
  xero: { ok: boolean; reason?: string; unpaidBills: number };
  planned: Array<{ id: string; label: string; message: string }>;
  dip: { start: string; end: string; closing: number } | null;
  fixList: FixAction[];
  pipeline: {
    enquiries: number;
    likely: number;
    possible: number;
    rates: Array<{ likelihood: string; booked: number; lost: number; rate: number | null }>;
  };
  vanFinanceMissing: Array<{ vehicleId: string; reg: string; lender: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface Account {
  id: string;
  name: string;
  kind: 'bank' | 'savings' | 'cash' | 'stripe';
  isMain: boolean;
  isActive: boolean;
  balance: number | null;
  asOf: string | null;
}

export interface Card {
  id: string;
  name: string;
  monthlyRate: number;
  statementDay: number | null;
  paymentDay: number | null;
  creditLimit: number | null;
  plan: 'full' | 'minimum' | 'fixed';
  minPct: number | null;
  fixedAmount: number | null;
  fixedEvery: 'week' | 'month' | null;
  fixedWeekday: number | null;
  typicalMonthlySpend: number | null;
  costPaymentMethod: CostCardMethod | null;
  isActive: boolean;
  /** Last 90 days of receipts logged in Costs on this card, as a monthly figure (GET /cards only). */
  receiptsMonthly?: number;
  receiptsCount?: number;
  balance: number | null;
  asOf: string | null;
}

/** Costs' payment methods that are a card (costs.payment_method). */
export type CostCardMethod = 'cot_card' | 'amex' | 'lloyds_cc';
export const COST_CARD_METHOD_LABELS: Record<CostCardMethod, string> = {
  cot_card: 'COT card (Capital on Tap)', amex: 'Amex', lloyds_cc: 'Lloyds credit card',
};

export type PlannedCategory = 'overheads' | 'payroll' | 'vat' | 'tax' | 'instalments' | 'one_off' | 'income' | 'other';
export type Frequency = 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export interface PlannedItem {
  id: string;
  label: string;
  category: PlannedCategory;
  direction: 'in' | 'out';
  kind: 'rule' | 'schedule';
  amount: number | null;
  frequency: Frequency | null;
  startDate: string | null;
  endDate: string | null;
  expectedTotal: number | null;
  xeroContactId: string | null;
  xeroContactName: string | null;
  xeroBillId: string | null;
  xeroBillLabel: string | null;
  notes: string | null;
  isActive: boolean;
  dates: Array<{ date: string; amount: number }>;
}

export interface XeroBillRow {
  id: string;
  number: string;
  reference: string;
  contactId: string | null;
  contactName: string;
  date: string | null;
  due: string | null;
  amountDue: number;
  total: number;
  flag: 'paid_xero_behind' | 'paid_by_card' | 'ignore' | null;
  contactExcluded: boolean;
  plannedItemId: string | null;
}

export const CATEGORY_LABELS: Record<PlannedCategory, string> = {
  overheads: 'Rent, rates & direct debits',
  payroll: 'Payroll & PAYE',
  vat: 'VAT',
  tax: 'Corporation tax & other tax',
  instalments: 'Instalment plan',
  one_off: 'One-off',
  income: 'Money in',
  other: 'Other',
};

export const FREQUENCY_LABELS: Record<Frequency, string> = {
  once: 'Once', weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year',
};

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** £1,234 (whole pounds) or £1,234.56; negatives as −£1,234. */
export function gbp(n: number | null | undefined, pence = false): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-GB', {
    minimumFractionDigits: pence ? 2 : 0,
    maximumFractionDigits: pence ? 2 : 0,
  });
  return `${n < -0.004 ? '−' : ''}£${abs}`;
}

/** '2026-11-09' → '9 Nov' (or with the weekday). Never throws on a bad string. */
export function shortDate(iso: string | null | undefined, withWeekday = false): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '—';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}),
  });
}

/** 1 → '1st', 23 → '23rd'. */
export function ordinal(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
  return `${n}${suffix}`;
}

/** '2027-04-11' → 'April 2027'. */
export function monthYear(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}/.test(iso)) return '—';
  const [y, m] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
}

/** Day `day` of a month, pulled back in a short month (31st → 30 Nov). Same rule as the backend. */
function dayInMonth(year: number, month1: number, day: number): string {
  const y = year + Math.floor((month1 - 1) / 12);
  const m = ((((month1 - 1) % 12) + 12) % 12) + 1;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = Math.min(Math.max(day, 1), last);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDaysIso(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The schedule editor's "write it out": `count` payments of `amount`, weekly
 * or monthly from `first`. Every row can then be changed by hand.
 */
export function writeOutSchedule(first: string, every: 'week' | 'month', count: number, amount: number): Array<{ date: string; amount: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || count < 1) return [];
  const [y, m, d] = first.split('-').map(Number);
  const out: Array<{ date: string; amount: number }> = [];
  for (let k = 0; k < Math.min(count, 520); k++) {
    out.push({ date: every === 'week' ? addDaysIso(first, k * 7) : dayInMonth(y, m + k, d), amount });
  }
  return out;
}
