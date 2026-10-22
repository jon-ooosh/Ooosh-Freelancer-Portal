/**
 * A freelancer's Earnings page in the portal (docs/FREELANCER-PORTAL-SPEC.md
 * §5.2, jon, Oct 2026). Reads ONLY what the office links in Costs (§5.1): the
 * freelancer invoices with `costs.person_id` set, and the work each one covers
 * (`cost_work_items`). Nothing here writes.
 *
 * Money is counted by invoice, because invoices are complete from April 2026
 * and the work links are not (the past invoices were linked to the person, not
 * to their work). For a period:
 *   - Paid:       invoices paid in the period (by the payment's date)
 *   - Invoiced:   invoices dated in the period and not paid yet (a payment
 *                 booked for a future date counts as not paid yet)
 *   - To invoice: finished work in the period that isn't on an invoice, from
 *                 `freelancer_earnings_labels_from` on (22 Oct 2026, when linking
 *                 went live). Earlier work shows its fee with no label, so a
 *                 month of paid work never reads as "To invoice".
 * An invoice still unpaid from before the period is listed apart, so "where is
 * my money?" is answered on every view, and is not added to the period.
 *
 * Fees are personalFee() via listFreelancerWork(): the same figures as the
 * portal's "Your fee" and the office's Costs screen. The expense estimate is
 * the office's guess and is NOT shown to the freelancer.
 */
import { query } from '../config/database';
import { getSystemSetting } from '../routes/system-settings';
import { listFreelancerWork, type FreelancerWorkItem } from './freelancer-work';
import { resolveDueDateForCost } from './supplier-terms';
import { ukDateOf, ukToday } from './uk-date';

/** OP went live around here: no tax year before it is offered. */
const OP_LIVE = '2026-04-06';
/** When "To invoice" labels start, unless the setting says otherwise. */
const DEFAULT_LABELS_FROM = '2026-10-22';

export type EarningsPeriodKey = 'last_month' | 'this_month' | 'tax_year' | 'last_tax_year';

export interface EarningsPeriod {
  key: EarningsPeriodKey;
  /** The card heading: "October", "Tax year 2026/27". */
  label: string;
  /** The segmented control's label. */
  tab: string;
  from: string;
  to: string;
}

export type InvoiceStatus = 'received' | 'queried' | 'approved' | 'scheduled' | 'paid';

export interface EarningsInvoice {
  id: string;
  invoiceNumber: string | null;
  date: string | null;
  amount: number;
  status: InvoiceStatus;
  /** Paid / paying / due date, for the status words. */
  statusDate: string | null;
  /** The office's question, while it's Queried. */
  queryNote: string | null;
  work: { date: string; title: string; jobNumber: number | null }[];
}

export interface EarningsWork {
  key: string;
  kind: FreelancerWorkItem['kind'];
  date: string;
  title: string;
  detail: string | null;
  jobNumber: number | null;
  fee: number;
  /** null: before the labels start and on no invoice. */
  label: 'to_invoice' | 'invoiced' | 'paid' | null;
  paidDate: string | null;
}

export interface Earnings {
  period: EarningsPeriod;
  periods: EarningsPeriod[];
  labelsFrom: string;
  totals: { paid: number; invoiced: number; toInvoice: number; total: number };
  /** How many invoices make up Paid and Invoiced, for the card's second line. */
  counts: { paid: number; waiting: number };
  toInvoiceCount: number;
  nextPayment: { date: string; amount: number } | null;
  invoices: EarningsInvoice[];
  earlierWaiting: EarningsInvoice[];
  work: EarningsWork[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (v == null || v === '' ? 0 : Number(v) || 0);
const pad = (n: number) => String(n).padStart(2, '0');
const isYmd = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The periods on offer today (UK date). Last tax year appears once it is a whole OP year. */
export function earningsPeriods(today: string): EarningsPeriod[] {
  const [y, m] = today.split('-').map(Number);
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  const taxStartYear = today >= `${y}-04-06` ? y : y - 1;
  const taxLabel = (s: number) => `${s}/${String((s + 1) % 100).padStart(2, '0')}`;
  const withLast = `${taxStartYear - 1}-04-06` >= OP_LIVE;
  const monthName = (mm: number, yy: number) => `${MONTHS[mm - 1]}${yy === y ? '' : ` ${yy}`}`;
  const short = (mm: number) => MONTHS[mm - 1].slice(0, 3);
  const periods: EarningsPeriod[] = [
    {
      key: 'last_month', label: monthName(lm, ly), tab: withLast ? short(lm) : MONTHS[lm - 1],
      from: `${ly}-${pad(lm)}-01`, to: `${ly}-${pad(lm)}-${pad(lastDayOfMonth(ly, lm))}`,
    },
    {
      key: 'this_month', label: MONTHS[m - 1], tab: withLast ? short(m) : MONTHS[m - 1],
      from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOfMonth(y, m))}`,
    },
    {
      key: 'tax_year', label: `Tax year ${taxLabel(taxStartYear)}`, tab: withLast ? taxLabel(taxStartYear) : 'Tax year',
      from: `${taxStartYear}-04-06`, to: `${taxStartYear + 1}-04-05`,
    },
  ];
  if (withLast) {
    periods.push({
      key: 'last_tax_year', label: `Tax year ${taxLabel(taxStartYear - 1)}`, tab: taxLabel(taxStartYear - 1),
      from: `${taxStartYear - 1}-04-06`, to: `${taxStartYear}-04-05`,
    });
  }
  return periods;
}

async function labelsFrom(): Promise<string> {
  const v = String((await getSystemSetting('freelancer_earnings_labels_from')) || '').trim();
  return isYmd(v) ? v : DEFAULT_LABELS_FROM;
}

/** The portal's wording for a piece of work (the Completed page's, with " - "). */
function portalTitle(it: FreelancerWorkItem): string {
  if (it.kind === 'sitter') return 'Studio sitter';
  if (it.kind === 'yard') return it.title.replace(/^Yard day/, 'Ooosh yard day');
  if (it.kind === 'run') return it.title.replace(/^Run, /, 'Multi-drop run, ');
  // "Delivery, The Lexington" → "Delivery - The Lexington"
  return it.title.replace(/^([^,]+), /, '$1 - ');
}

export async function getFreelancerEarnings(personId: string, periodKey: string | undefined): Promise<Earnings> {
  const today = ukToday();
  const periods = earningsPeriods(today);
  const period = periods.find((p) => p.key === periodKey) || periods.find((p) => p.key === 'this_month')!;
  const from = await labelsFrom();

  const [invRows, work] = await Promise.all([
    query(
      `SELECT id, invoice_number, cost_date::text AS cost_date, amount_gross, payment_status, approval_state,
              paid_value_date::text AS paid_value_date, paid_at, approved_at, queried_at, query_note,
              due_date_override, cost_type
         FROM costs
        WHERE person_id = $1 AND cost_type = 'freelancer_invoice' AND COALESCE(is_credit, false) = false`,
      [personId],
    ),
    // All their finished work: the period's list, and what each invoice covers.
    listFreelancerWork(personId, { includeInvoiced: true, from: '2000-01-01' }),
  ]);

  // ── Invoices and their status ──
  const invoices = new Map<string, EarningsInvoice & { paidNow: boolean; paidDate: string | null }>();
  for (const r of invRows.rows) {
    const paidMarked = r.payment_status === 'paid' || r.approval_state === 'paid';
    const paidDate = paidMarked
      ? (isYmd(r.paid_value_date) ? r.paid_value_date : r.paid_at ? ukDateOf(new Date(r.paid_at)) : null)
      : null;
    let status: InvoiceStatus;
    let statusDate: string | null = null;
    if (paidMarked && paidDate && paidDate > today) {
      status = 'scheduled'; statusDate = paidDate;
    } else if (paidMarked) {
      status = 'paid'; statusDate = paidDate;
    } else if (r.approval_state === 'approved') {
      status = 'approved';
      statusDate = (await resolveDueDateForCost({
        cost_type: r.cost_type, cost_date: r.cost_date, approved_at: r.approved_at, due_date_override: r.due_date_override,
      })).dueDate;
    } else if (r.queried_at) {
      status = 'queried';
    } else {
      status = 'received';
    }
    invoices.set(r.id, {
      id: r.id,
      invoiceNumber: r.invoice_number || null,
      date: isYmd(r.cost_date) ? r.cost_date : null,
      amount: round2(num(r.amount_gross)),
      status,
      statusDate,
      queryNote: status === 'queried' ? (r.query_note || null) : null,
      work: [],
      paidNow: status === 'paid',
      // Marked paid with no date anywhere (rare): counted by its invoice date.
      paidDate: status === 'paid' ? (paidDate || (isYmd(r.cost_date) ? r.cost_date : null)) : null,
    });
  }

  // What each invoice covers, and what each piece of work is on.
  for (const it of work) {
    for (const on of it.invoicedOn) {
      invoices.get(on.costId)?.work.push({ date: it.date, title: portalTitle(it), jobNumber: it.hhJobNumber });
    }
  }
  for (const inv of invoices.values()) inv.work.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const inPeriod = (d: string | null) => !!d && d >= period.from && d <= period.to;
  const strip = ({ paidNow: _p, paidDate: _d, ...inv }: EarningsInvoice & { paidNow: boolean; paidDate: string | null }) => inv;
  const all = [...invoices.values()];
  const counted = all.filter((i) => (i.paidNow ? inPeriod(i.paidDate) : inPeriod(i.date)));
  const earlierWaiting = all.filter((i) => !i.paidNow && !!i.date && i.date < period.from);
  const byDateDesc = (a: { date: string | null }, b: { date: string | null }) => ((a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : 0);

  // ── Work in the period ──
  const periodWork: EarningsWork[] = work
    .filter((it) => inPeriod(it.date))
    .map((it) => {
      const ons = it.invoicedOn.map((o) => invoices.get(o.costId)).filter(Boolean) as Array<EarningsInvoice & { paidNow: boolean; paidDate: string | null }>;
      let label: EarningsWork['label'] = null;
      let paidDate: string | null = null;
      if (ons.length) {
        // On several invoices (rare): paid only once every one of them is.
        if (ons.every((o) => o.paidNow)) {
          label = 'paid';
          paidDate = ons.map((o) => o.paidDate || '').sort().pop() || null;
        } else {
          label = 'invoiced';
        }
      } else if (it.date >= from) {
        label = 'to_invoice';
      }
      return {
        key: it.key, kind: it.kind, date: it.date, title: portalTitle(it), detail: it.detail,
        jobNumber: it.hhJobNumber, fee: it.fee, label, paidDate,
      };
    });

  const toInvoice = periodWork.filter((w) => w.label === 'to_invoice');
  const paid = round2(counted.filter((i) => i.paidNow).reduce((t, i) => t + i.amount, 0));
  const invoiced = round2(counted.filter((i) => !i.paidNow).reduce((t, i) => t + i.amount, 0));
  const toInvoiceSum = round2(toInvoice.reduce((t, w) => t + w.fee, 0));

  // ── The next money due to arrive, across every invoice ──
  const upcoming = all
    .filter((i) => (i.status === 'scheduled' || i.status === 'approved') && i.statusDate && i.statusDate >= today)
    .sort((a, b) => ((a.statusDate as string) < (b.statusDate as string) ? -1 : 1));
  const nextDate = upcoming[0]?.statusDate || null;
  const nextPayment = nextDate
    ? { date: nextDate, amount: round2(upcoming.filter((i) => i.statusDate === nextDate).reduce((t, i) => t + i.amount, 0)) }
    : null;

  return {
    period,
    periods,
    labelsFrom: from,
    totals: { paid, invoiced, toInvoice: toInvoiceSum, total: round2(paid + invoiced + toInvoiceSum) },
    counts: {
      paid: counted.filter((i) => i.paidNow).length,
      waiting: counted.filter((i) => !i.paidNow).length,
    },
    toInvoiceCount: toInvoice.length,
    nextPayment,
    invoices: counted.sort(byDateDesc).map(strip),
    earlierWaiting: earlierWaiting.sort(byDateDesc).map(strip),
    work: periodWork,
  };
}
