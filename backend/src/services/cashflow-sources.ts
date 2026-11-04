/**
 * Cash forecast — where the figures come from (docs/CASHFLOW-FORECAST-SPEC.md §2–§5).
 *
 * Each reader returns plain rows; services/cashflow-forecast.ts decides where
 * they land. Readers that talk to Xero or Stripe never throw: they answer
 * { ok: false, reason } so the page can still show everything else and say
 * what is missing.
 *
 * Money IN is OP's (job_financials, job_excess). Things to PAY are Xero's,
 * except van HP (fleet finance) and planned items. Never both for one thing.
 */
import { query } from '../config/database';
import { isXeroConfigured } from '../config/xero';
import { getStripeClient, isStripeConfigured } from '../config/stripe';
import { xeroBroker } from './xero-broker';
import { xeroDateToISO } from './cost-xero-payment-sync';
import { ukDateOf } from './uk-date';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The statuses whose money is committed: the job is booked. */
export const COMMITTED_STATUSES = ['confirmed', 'prepping', 'prepped', 'dispatched', 'returned_incomplete', 'returned', 'completed'];

// ── Settings ───────────────────────────────────────────────────────────────

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
}

/** key in cashflow_settings → field + how to read it. The ONLY list of settings. */
export const SETTING_FIELDS: Array<{ key: string; field: keyof CashflowSettings; type: 'number' | 'bool' | 'date' }> = [
  { key: 'target_floor', field: 'targetFloor', type: 'number' },
  { key: 'overdraft_limit', field: 'overdraftLimit', type: 'number' },
  { key: 'youlend_rate', field: 'youlendRate', type: 'number' },
  { key: 'youlend_remaining', field: 'youlendRemaining', type: 'number' },
  { key: 'youlend_as_of', field: 'youlendAsOf', type: 'date' },
  { key: 'stripe_share', field: 'stripeShare', type: 'number' },
  { key: 'stripe_fee_rate', field: 'stripeFeeRate', type: 'number' },
  { key: 'stripe_payout_days', field: 'stripePayoutDays', type: 'number' },
  { key: 'excess_refund_days', field: 'excessRefundDays', type: 'number' },
  { key: 'count_overdue_bills', field: 'countOverdueBills', type: 'bool' },
  { key: 'count_overdue_balances', field: 'countOverdueBalances', type: 'bool' },
  { key: 'suggest_bank_transfer', field: 'suggestBankTransfer', type: 'bool' },
];

const DEFAULT_SETTINGS: CashflowSettings = {
  targetFloor: 0, overdraftLimit: 22000, youlendRate: 0.28, youlendRemaining: 0, youlendAsOf: null,
  stripeShare: 0.9, stripeFeeRate: 0.015, stripePayoutDays: 2, excessRefundDays: 7,
  countOverdueBills: false, countOverdueBalances: false, suggestBankTransfer: true,
};

export async function loadSettings(): Promise<CashflowSettings> {
  const r = await query(`SELECT key, value FROM cashflow_settings`);
  const byKey = new Map<string, string | null>(r.rows.map((row: { key: string; value: string | null }) => [row.key, row.value]));
  const out: CashflowSettings = { ...DEFAULT_SETTINGS };
  const target = out as unknown as Record<string, unknown>;
  for (const f of SETTING_FIELDS) {
    const raw = byKey.get(f.key);
    if (raw === undefined || raw === null || raw === '') continue;
    if (f.type === 'number') {
      const n = Number(raw);
      if (Number.isFinite(n)) target[f.field] = n;
    } else if (f.type === 'bool') {
      target[f.field] = raw === 'true';
    } else {
      target[f.field] = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
    }
  }
  return out;
}

// ── Opening balances ───────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  name: string;
  kind: 'bank' | 'savings' | 'cash' | 'stripe';
  isMain: boolean;
  isActive: boolean;
  balance: number | null;    // the latest check-in, null when never typed
  asOf: string | null;
}

export async function loadAccounts(includeInactive = false): Promise<AccountRow[]> {
  const r = await query(
    `SELECT a.id, a.name, a.kind, a.is_main, a.is_active,
            s.balance, to_char(s.as_of, 'YYYY-MM-DD') AS as_of
     FROM cashflow_accounts a
     LEFT JOIN LATERAL (
       SELECT balance, as_of FROM cashflow_balance_snapshots
       WHERE account_id = a.id ORDER BY as_of DESC, created_at DESC LIMIT 1
     ) s ON TRUE
     WHERE a.is_active = TRUE OR $1::boolean
     ORDER BY a.sort_order, a.name`,
    [includeInactive],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), name: String(row.name), kind: row.kind as AccountRow['kind'], isMain: !!row.is_main,
    isActive: !!row.is_active,
    balance: row.balance === null ? null : num(row.balance), asOf: (row.as_of as string) || null,
  }));
}

export interface CardRow {
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
  costPaymentMethod: 'cot_card' | 'amex' | 'lloyds_cc' | null;
  isActive: boolean;
  balance: number | null;
  asOf: string | null;
}

const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

export async function loadCards(includeInactive = false): Promise<CardRow[]> {
  const r = await query(
    `SELECT c.*, s.balance, to_char(s.as_of, 'YYYY-MM-DD') AS as_of
     FROM cashflow_cards c
     LEFT JOIN LATERAL (
       SELECT balance, as_of FROM cashflow_balance_snapshots
       WHERE card_id = c.id ORDER BY as_of DESC, created_at DESC LIMIT 1
     ) s ON TRUE
     WHERE c.is_active = TRUE OR $1::boolean
     ORDER BY c.sort_order, c.name`,
    [includeInactive],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), name: String(row.name), monthlyRate: num(row.monthly_rate),
    statementDay: numOrNull(row.statement_day), paymentDay: numOrNull(row.payment_day),
    creditLimit: numOrNull(row.credit_limit), plan: row.plan as CardRow['plan'],
    minPct: numOrNull(row.min_pct), fixedAmount: numOrNull(row.fixed_amount),
    fixedEvery: (row.fixed_every as CardRow['fixedEvery']) || null, fixedWeekday: numOrNull(row.fixed_weekday),
    typicalMonthlySpend: numOrNull(row.typical_monthly_spend),
    costPaymentMethod: (row.cost_payment_method as CardRow['costPaymentMethod']) || null, isActive: !!row.is_active,
    balance: numOrNull(row.balance), asOf: (row.as_of as string) || null,
  }));
}

// ── Card receipts logged in OP (Costs) ─────────────────────────────────────

/** How many days of receipts make the "typical spend" average. */
export const RECEIPT_SPEND_DAYS = 90;

export interface CardReceiptRow { method: string; date: string; amount: number }

/**
 * Every card purchase logged in Costs since `from` (credits are stored negative,
 * so they net off). By the date on the receipt, not the day it was logged.
 */
export async function loadCardReceipts(from: string): Promise<CardReceiptRow[]> {
  const r = await query(
    `SELECT payment_method, to_char(cost_date, 'YYYY-MM-DD') AS d, amount_gross
     FROM costs
     WHERE payment_method IN ('cot_card', 'amex', 'lloyds_cc')
       AND cost_date IS NOT NULL
       AND cost_date >= $1::date`,
    [from],
  );
  return r.rows.map((row: Record<string, unknown>) => ({ method: String(row.payment_method), date: String(row.d), amount: num(row.amount_gross) }));
}

/** A card's spend from logged receipts: since its check-in, and the 90-day monthly average. */
export function cardReceiptSpend(
  rows: CardReceiptRow[], method: string | null, checkInAsOf: string | null, today: string, windowStart: string,
): { sinceCheckIn: number; sinceCount: number; monthly: number; count: number } {
  const mine = method ? rows.filter((r) => r.method === method) : [];
  const since = checkInAsOf ? mine.filter((r) => r.date > checkInAsOf && r.date <= today) : [];
  const window = mine.filter((r) => r.date >= windowStart && r.date <= today);
  const round2 = (n: number) => Math.round(n * 100) / 100;
  return {
    sinceCheckIn: round2(since.reduce((s, r) => s + r.amount, 0)),
    sinceCount: since.length,
    monthly: round2((window.reduce((s, r) => s + r.amount, 0) * 30.44) / RECEIPT_SPEND_DAYS),
    count: window.length,
  };
}

// ── Money in: confirmed jobs (OP) ──────────────────────────────────────────

export interface JobBalanceRow {
  jobId: string;
  hh: number | null;
  name: string;
  client: string;
  status: string;
  start: string | null;
  end: string | null;
  hireValue: number;
  depositsPaid: number;
  balance: number;
  creditDays: number | null;
}

/**
 * What booked jobs still owe — the Money overview's "Balances Outstanding"
 * (job_financials, refreshed nightly and whenever a Money tab is opened),
 * without the balances an admin has marked resolved.
 */
export async function loadJobBalances(): Promise<JobBalanceRow[]> {
  const r = await query(
    `SELECT jf.job_id, j.hh_job_number, j.job_name,
            COALESCE(j.client_name, j.company_name) AS client_name,
            j.pipeline_status,
            to_char((j.job_date AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS start_date,
            to_char((j.job_end AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS end_date,
            jf.hire_value_inc_vat, jf.total_hire_deposits, jf.balance_outstanding,
            o.working_terms_credit_days
     FROM job_financials jf
     JOIN jobs j ON j.id = jf.job_id
     LEFT JOIN organisations o ON o.id = j.client_id
     LEFT JOIN job_balance_overrides bo ON bo.job_id = jf.job_id
     WHERE jf.balance_outstanding > 0.01
       AND bo.job_id IS NULL
       AND j.pipeline_status = ANY($1::text[])
       AND COALESCE(j.is_internal, false) = false
       AND COALESCE(j.is_deleted, false) = false`,
    [COMMITTED_STATUSES],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    jobId: String(row.job_id), hh: numOrNull(row.hh_job_number), name: String(row.job_name || ''),
    client: String(row.client_name || ''), status: String(row.pipeline_status || ''),
    start: (row.start_date as string) || null, end: (row.end_date as string) || null,
    hireValue: num(row.hire_value_inc_vat), depositsPaid: num(row.total_hire_deposits),
    balance: num(row.balance_outstanding),
    creditDays: row.working_terms_credit_days && num(row.working_terms_credit_days) > 0 ? num(row.working_terms_credit_days) : null,
  }));
}

/** Hire deposits already taken on booked jobs that haven't started — kept, so not subtracted from "yours" (§4). */
export async function loadDepositsOnFutureJobs(today: string): Promise<number> {
  const r = await query(
    `SELECT COALESCE(SUM(jf.total_hire_deposits), 0) AS total
     FROM job_financials jf
     JOIN jobs j ON j.id = jf.job_id
     WHERE j.pipeline_status = ANY($1::text[])
       AND (j.job_date AT TIME ZONE 'Europe/London')::date > $2::date
       AND COALESCE(j.is_internal, false) = false
       AND COALESCE(j.is_deleted, false) = false`,
    [COMMITTED_STATUSES, today],
  );
  return num(r.rows[0]?.total);
}

// ── Excess ─────────────────────────────────────────────────────────────────

export interface ExcessDueRow {
  excessId: string;
  jobId: string;
  hh: number | null;
  client: string;
  start: string;
  startRaw: Date | string | null;
  endRaw: Date | string | null;
  owed: number;
}

/** Excess still to be paid on booked jobs that haven't started. */
export async function loadExcessDue(today: string): Promise<ExcessDueRow[]> {
  const r = await query(
    `SELECT je.id, je.job_id, j.hh_job_number,
            COALESCE(j.client_name, j.company_name) AS client_name,
            to_char((j.job_date AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS start_date,
            j.job_date, j.job_end,
            GREATEST(COALESCE(je.excess_amount_required, 0) - COALESCE(je.excess_amount_taken, 0) - COALESCE(je.amount_held, 0), 0) AS owed
     FROM job_excess je
     JOIN jobs j ON j.id = je.job_id
     WHERE je.excess_status IN ('needed', 'pending', 'partially_paid')
       AND j.pipeline_status = ANY($1::text[])
       AND (j.job_date AT TIME ZONE 'Europe/London')::date >= $2::date
       AND COALESCE(j.is_internal, false) = false
       AND COALESCE(j.is_deleted, false) = false`,
    [COMMITTED_STATUSES, today],
  );
  return r.rows
    .map((row: Record<string, unknown>) => ({
      excessId: String(row.id), jobId: String(row.job_id), hh: numOrNull(row.hh_job_number),
      client: String(row.client_name || ''), start: String(row.start_date),
      startRaw: row.job_date as Date | null, endRaw: row.job_end as Date | null, owed: num(row.owed),
    }))
    .filter((x: ExcessDueRow) => x.owed > 0.01);
}

export interface ExcessHeldRow {
  excessId: string;
  jobId: string | null;
  hh: number | null;
  client: string;
  status: string | null;
  finishedOn: string | null;
  cash: number;
  onAccount: boolean;
}

/**
 * Excess we hold IN CASH — v_excess_held (THE definition of what we hold) less
 * any pre-auth amount, which is a hold on the client's card, not money in the bank.
 */
export async function loadExcessHeld(): Promise<ExcessHeldRow[]> {
  const r = await query(
    `SELECT h.excess_id, je.job_id, j.hh_job_number,
            COALESCE(j.client_name, j.company_name, je.client_name) AS client_name,
            j.pipeline_status,
            to_char((COALESCE(j.return_date, j.job_end) AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') AS finished_on,
            GREATEST(h.held_amount - COALESCE(je.amount_held, 0), 0) AS cash_held,
            COALESCE(je.held_on_account, false) AS on_account
     FROM v_excess_held h
     JOIN job_excess je ON je.id = h.excess_id
     LEFT JOIN jobs j ON j.id = je.job_id
     WHERE h.held_amount > 0.01
       AND (j.id IS NULL OR (COALESCE(j.is_internal, false) = false AND COALESCE(j.is_deleted, false) = false))`,
  );
  return r.rows
    .map((row: Record<string, unknown>) => ({
      excessId: String(row.excess_id), jobId: row.job_id ? String(row.job_id) : null, hh: numOrNull(row.hh_job_number),
      client: String(row.client_name || ''), status: (row.pipeline_status as string) || null,
      finishedOn: (row.finished_on as string) || null, cash: num(row.cash_held), onAccount: !!row.on_account,
    }))
    .filter((x: ExcessHeldRow) => x.cash > 0.01);
}

export interface RefundOwedRow { id: string; jobId: string | null; hh: number | null; client: string; amount: number }

/** Refunds we've decided to make and haven't yet (the Money overview's pending IOUs). */
export async function loadRefundsOwed(): Promise<RefundOwedRow[]> {
  const r = await query(
    `SELECT jp.id, jp.job_id, j.hh_job_number, COALESCE(j.client_name, j.company_name) AS client_name, jp.amount
     FROM job_payments jp
     LEFT JOIN jobs j ON j.id = jp.job_id
     WHERE jp.payment_type = 'refund' AND jp.payment_status = 'pending'`,
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), jobId: row.job_id ? String(row.job_id) : null, hh: numOrNull(row.hh_job_number),
    client: String(row.client_name || ''), amount: Math.abs(num(row.amount)),
  }));
}

// ── Van HP (fleet finance) ─────────────────────────────────────────────────

export interface HpRow { vehicleId: string; reg: string; lender: string; monthly: number | null; start: string | null; ends: string | null }

/** Financed vans still on the fleet. "We own outright" is not finance. */
export async function loadVanFinance(): Promise<HpRow[]> {
  const r = await query(
    `SELECT id, reg, finance_with, monthly_payment,
            to_char(finance_start, 'YYYY-MM-DD') AS finance_start,
            to_char(finance_ends, 'YYYY-MM-DD') AS finance_ends
     FROM fleet_vehicles
     WHERE COALESCE(is_active, true) = true
       AND sold_date IS NULL
       AND NULLIF(TRIM(finance_with), '') IS NOT NULL
       AND finance_with <> 'We own outright'
     ORDER BY reg`,
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    vehicleId: String(row.id), reg: String(row.reg), lender: String(row.finance_with),
    monthly: row.monthly_payment === null ? null : num(row.monthly_payment),
    start: (row.finance_start as string) || null, ends: (row.finance_ends as string) || null,
  }));
}

// ── Planned items ──────────────────────────────────────────────────────────

export interface PlannedItemRow {
  id: string;
  label: string;
  category: 'overheads' | 'payroll' | 'vat' | 'tax' | 'instalments' | 'one_off' | 'income' | 'other';
  direction: 'in' | 'out';
  kind: 'rule' | 'schedule';
  amount: number | null;
  frequency: 'once' | 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
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

export async function loadPlannedItems(includeInactive = false): Promise<PlannedItemRow[]> {
  const r = await query(
    `SELECT p.*, to_char(p.start_date, 'YYYY-MM-DD') AS start_iso, to_char(p.end_date, 'YYYY-MM-DD') AS end_iso,
            COALESCE((
              SELECT json_agg(json_build_object('date', to_char(d.due_date, 'YYYY-MM-DD'), 'amount', d.amount) ORDER BY d.due_date)
              FROM cashflow_planned_item_dates d WHERE d.item_id = p.id
            ), '[]'::json) AS dates
     FROM cashflow_planned_items p
     WHERE p.is_active = TRUE OR $1::boolean
     ORDER BY p.category, p.label`,
    [includeInactive],
  );
  return r.rows.map((row: Record<string, unknown>) => ({
    id: String(row.id), label: String(row.label), category: row.category as PlannedItemRow['category'],
    direction: row.direction as 'in' | 'out', kind: row.kind as 'rule' | 'schedule',
    amount: numOrNull(row.amount), frequency: (row.frequency as PlannedItemRow['frequency']) || null,
    startDate: (row.start_iso as string) || null, endDate: (row.end_iso as string) || null,
    expectedTotal: numOrNull(row.expected_total),
    xeroContactId: (row.xero_contact_id as string) || null, xeroContactName: (row.xero_contact_name as string) || null,
    xeroBillId: (row.xero_bill_id as string) || null, xeroBillLabel: (row.xero_bill_label as string) || null,
    notes: (row.notes as string) || null, isActive: !!row.is_active,
    dates: ((row.dates as Array<{ date: string; amount: unknown }>) || []).map((d) => ({ date: d.date, amount: num(d.amount) })),
  }));
}

// ── Xero bills ─────────────────────────────────────────────────────────────

export interface XeroBill {
  id: string;
  number: string;
  reference: string;
  contactId: string | null;
  contactName: string;
  date: string | null;
  due: string | null;
  amountDue: number;
  total: number;
}

export type XeroBillsResult = { ok: true; bills: XeroBill[] } | { ok: false; reason: string };

let billsCache: { at: number; result: XeroBillsResult } | null = null;
const BILLS_CACHE_MS = 5 * 60 * 1000;

/** Unpaid approved bills, cached for five minutes (the page reloads often while jon works through it). */
export async function loadXeroBills(fresh = false): Promise<XeroBillsResult> {
  if (!fresh && billsCache && Date.now() - billsCache.at < BILLS_CACHE_MS) return billsCache.result;
  let result: XeroBillsResult;
  if (!isXeroConfigured()) {
    result = { ok: false, reason: 'Xero is not connected on this server.' };
  } else {
    try {
      const rows = await xeroBroker.getUnpaidBills();
      const bills = rows
        .filter((b) => String(b.CurrencyCode || 'GBP') === 'GBP')
        .map((b) => {
          const contact = (b.Contact || {}) as Record<string, unknown>;
          return {
            id: String(b.InvoiceID),
            number: String(b.InvoiceNumber || ''),
            reference: String(b.Reference || ''),
            contactId: contact.ContactID ? String(contact.ContactID) : null,
            contactName: String(contact.Name || 'Unknown supplier'),
            date: xeroDateToISO((b.DateString as string) || (b.Date as string)),
            due: xeroDateToISO((b.DueDateString as string) || (b.DueDate as string)),
            amountDue: num(b.AmountDue),
            total: num(b.Total),
          };
        })
        .filter((b) => b.amountDue > 0.01);
      result = { ok: true, bills };
    } catch (err) {
      console.error('[cashflow] Xero bills read failed:', err);
      result = { ok: false, reason: `Xero couldn't be read (${err instanceof Error ? err.message : 'unknown error'}).` };
    }
  }
  billsCache = { at: Date.now(), result };
  return result;
}

export function forgetXeroBillsCache(): void {
  billsCache = null;
}

export interface BillFlags {
  byBill: Map<string, 'paid_xero_behind' | 'paid_by_card' | 'ignore'>;
  excludedContacts: Map<string, string>;   // contact id → name
}

export async function loadBillFlags(): Promise<BillFlags> {
  const [f, c] = await Promise.all([
    query(`SELECT xero_invoice_id, flag FROM cashflow_bill_flags`),
    query(`SELECT xero_contact_id, contact_name FROM cashflow_excluded_contacts`),
  ]);
  return {
    byBill: new Map(f.rows.map((r: { xero_invoice_id: string; flag: 'paid_xero_behind' | 'paid_by_card' | 'ignore' }) => [r.xero_invoice_id, r.flag])),
    excludedContacts: new Map(c.rows.map((r: { xero_contact_id: string; contact_name: string | null }) => [r.xero_contact_id, r.contact_name || ''])),
  };
}

// ── Stripe ─────────────────────────────────────────────────────────────────

export interface StripeSnapshot {
  ok: boolean;
  reason?: string;
  available: number;                                   // spendable now
  pending: Array<{ date: string; amount: number }>;    // in Stripe, spendable on that day
  payouts: Array<{ date: string; amount: number; status: string }>;  // left Stripe, on the way to (or reached) the bank
  feeRate: number | null;                              // fee ÷ amount over recent card payments
}

let stripeCache: { at: number; snap: StripeSnapshot } | null = null;
const STRIPE_CACHE_MS = 5 * 60 * 1000;
let feeCache: { at: number; rate: number | null } | null = null;
const FEE_CACHE_MS = 6 * 60 * 60 * 1000;

const unixToUk = (s: number) => ukDateOf(new Date(s * 1000));

/**
 * The Stripe balance, read live. The restricted key needs "Balance: Read" and
 * "Payouts: Read"; without them this answers ok:false and Stripe becomes a
 * typed figure on the Monday check-in.
 */
export async function readStripe(fresh = false): Promise<StripeSnapshot> {
  if (!fresh && stripeCache && Date.now() - stripeCache.at < STRIPE_CACHE_MS) return stripeCache.snap;
  const empty: StripeSnapshot = { ok: false, available: 0, pending: [], payouts: [], feeRate: null };
  if (!isStripeConfigured()) {
    return { ...empty, reason: 'Stripe is not configured on this server.' };
  }
  let snap: StripeSnapshot;
  try {
    const stripe = getStripeClient();
    const bal = await stripe.balance.retrieve();
    const gbp = (list: Array<{ amount: number; currency: string }>) =>
      list.filter((x) => x.currency === 'gbp').reduce((s, x) => s + x.amount, 0) / 100;
    const available = gbp(bal.available);
    const pendingTotal = gbp(bal.pending);

    // When does the pending money become spendable? The recent balance
    // transactions say, each with its own date. Whatever they don't account
    // for lands on today + the payout delay, decided by the caller.
    const pendingByDate = new Map<string, number>();
    const since = Math.floor(Date.now() / 1000) - 21 * 24 * 60 * 60;
    let seen = 0;
    for await (const t of stripe.balanceTransactions.list({ created: { gte: since }, limit: 100 })) {
      if (++seen > 1000) break;
      if (t.status !== 'pending' || t.currency !== 'gbp') continue;
      const d = unixToUk(t.available_on);
      pendingByDate.set(d, (pendingByDate.get(d) || 0) + t.net / 100);
    }
    const pending = [...pendingByDate.entries()].map(([date, amount]) => ({ date, amount: Math.round(amount * 100) / 100 }));
    const counted = pending.reduce((s, p) => s + p.amount, 0);
    const rest = Math.round((pendingTotal - counted) * 100) / 100;
    if (Math.abs(rest) >= 0.01) pending.push({ date: '', amount: rest });   // '' = "today + payout delay"

    const payouts: StripeSnapshot['payouts'] = [];
    const payoutSince = Math.floor(Date.now() / 1000) - 14 * 24 * 60 * 60;
    for await (const p of stripe.payouts.list({ created: { gte: payoutSince }, limit: 100 })) {
      if (p.currency !== 'gbp' || !['paid', 'in_transit', 'pending'].includes(p.status)) continue;
      payouts.push({ date: unixToUk(p.arrival_date), amount: p.amount / 100, status: p.status });
    }

    snap = { ok: true, available, pending, payouts, feeRate: await readStripeFeeRate() };
  } catch (err) {
    console.error('[cashflow] Stripe read failed:', err);
    const msg = err instanceof Error ? err.message : 'unknown error';
    snap = { ...empty, reason: `Stripe couldn't be read (${msg}). The key may need "Balance: Read" and "Payouts: Read".` };
  }
  stripeCache = { at: Date.now(), snap };
  return snap;
}

/** Stripe's effective fee over the last 90 days of card payments (fee ÷ amount). Cached for six hours. */
async function readStripeFeeRate(): Promise<number | null> {
  if (feeCache && Date.now() - feeCache.at < FEE_CACHE_MS) return feeCache.rate;
  let rate: number | null = null;
  try {
    const stripe = getStripeClient();
    const since = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
    let amount = 0;
    let fee = 0;
    let seen = 0;
    for await (const t of stripe.balanceTransactions.list({ created: { gte: since }, limit: 100 })) {
      if (++seen > 2000) break;
      if ((t.type !== 'charge' && t.type !== 'payment') || t.currency !== 'gbp' || t.amount <= 0) continue;
      amount += t.amount;
      fee += t.fee;
    }
    rate = amount > 0 ? fee / amount : null;
  } catch (err) {
    console.error('[cashflow] Stripe fee read failed:', err);
  }
  feeCache = { at: Date.now(), rate };
  return rate;
}

/** What share of money in (hire + excess, last 90 days) came through Stripe — shown beside the setting. */
export async function measureStripeShare(): Promise<{ share: number | null; payments: number }> {
  const r = await query(
    `SELECT COUNT(*)::int AS n,
            COALESCE(SUM(ABS(amount)), 0) AS total,
            COALESCE(SUM(ABS(amount)) FILTER (WHERE payment_method ILIKE 'stripe%' OR payment_method = 'paypal'), 0) AS stripe
     FROM job_payments
     WHERE payment_type <> 'refund' AND payment_status = 'completed'
       AND payment_date >= NOW() - INTERVAL '90 days'`,
  );
  const total = num(r.rows[0]?.total);
  return { share: total > 0 ? num(r.rows[0]?.stripe) / total : null, payments: Number(r.rows[0]?.n || 0) };
}
