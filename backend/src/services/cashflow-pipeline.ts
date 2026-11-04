/**
 * Cash forecast, Phase 2 — the pure part: how likely an enquiry is to book,
 * when its weighted money would land, and the "what would fix it" rules
 * (docs/CASHFLOW-FORECAST-SPEC.md §6, §8). No database, no clock — tested in
 * __tests__/cashflow-pipeline.test.ts.
 */
import { addDays, daysBetween } from './cashflow-schedule';
import { requiredDeposit } from './deposit-rule';

// ── How likely is this enquiry to book? ────────────────────────────────────

/** Below this many decided enquiries in a bucket, the history is too thin to trust. */
export const MIN_SAMPLE = 20;

export interface ChanceSettings {
  weightProvisional: number;
  weightHot: number;
  weightWarm: number;
  weightCold: number;
  weightUnset: number;
}

export interface Chance {
  chance: number;          // 0–1
  basis: string;           // said on the page next to the figure
  learned: boolean;
}

/**
 * Provisional enquiries take the Settings figure (OP doesn't record which past
 * jobs were provisional before they booked). Everything else: what actually
 * happened to enquiries with the same likelihood over the last 24 months, when
 * there are at least MIN_SAMPLE of them; otherwise the Settings default.
 */
export function bookingChance(
  status: string,
  likelihood: 'hot' | 'warm' | 'cold' | null,
  history: Array<{ likelihood: string; booked: number; lost: number }>,
  s: ChanceSettings,
): Chance {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  if (status === 'provisional') {
    return { chance: clamp01(s.weightProvisional), basis: `provisional — ${pct(s.weightProvisional)} (Settings)`, learned: false };
  }
  const bucket = likelihood || 'unset';
  const fallback = { hot: s.weightHot, warm: s.weightWarm, cold: s.weightCold, unset: s.weightUnset }[bucket];
  const word = likelihood || 'no likelihood set';
  const h = history.find((x) => x.likelihood === bucket);
  const decided = h ? h.booked + h.lost : 0;
  if (h && decided >= MIN_SAMPLE) {
    const rate = h.booked / decided;
    return { chance: rate, basis: `${word} — ${pct(rate)} of ${decided} like it booked`, learned: true };
  }
  return { chance: clamp01(fallback), basis: `${word} — ${pct(fallback)} (Settings; only ${decided} to learn from)`, learned: false };
}

function clamp01(n: number): number {
  return Math.min(Math.max(Number.isFinite(n) ? n : 0, 0), 1);
}

// ── When would an enquiry's money land? ────────────────────────────────────

export interface EnquiryCash {
  depositDate: string | null;
  deposit: number;          // full, unweighted
  balanceDate: string;
  balance: number;          // full, unweighted
}

/**
 * Starting rules (spec §5.1 — tune after a month): the deposit lands on the
 * earlier of a week after the next chase and a week before the hire, never
 * before tomorrow; the rest is due by the first day. Money already paid comes
 * off the deposit first.
 */
export function enquiryCash(job: { start: string; nextChase: string | null; valueIncVat: number; depositsPaid: number }, today: string): EnquiryCash {
  const deposit = Math.max(0, requiredDeposit(job.valueIncVat) - job.depositsPaid);
  const balance = Math.max(0, job.valueIncVat - Math.max(job.depositsPaid, requiredDeposit(job.valueIncVat)));
  const tomorrow = addDays(today, 1);
  let depositDate: string | null = null;
  if (deposit > 0.005) {
    const byChase = job.nextChase ? addDays(job.nextChase, 7) : addDays(today, 7);
    const byStart = addDays(job.start, -7);
    depositDate = byChase < byStart ? byChase : byStart;
    if (depositDate < tomorrow) depositDate = tomorrow;
    if (depositDate > job.start) depositDate = job.start;
  }
  const balanceDate = job.start < tomorrow ? tomorrow : job.start;
  return { depositDate, deposit, balanceDate, balance };
}

// ── What would fix it ──────────────────────────────────────────────────────

export interface FixAction {
  key: 'chase_overdue' | 'ask_early' | 'nudge_enquiries' | 'move_bills' | 'card_headroom' | 'bank_transfer';
  title: string;
  detail: string;
  amount: number | null;     // what it would lift the dip by; null = information only
  links: Array<{ label: string; jobId?: string; billId?: string }>;
}

export interface FixInput {
  dip: { start: string; end: string; closing: number } | null;
  target: number;
  overdueBalances: Array<{ id: string; label: string; amount: number; jobId?: string }>;
  hireBalances: Array<{ date: string; dueBy: string; label: string; amount: number; jobId?: string }>;
  enquiries: Array<{ jobId: string; label: string; start: string; chance: number; deposit: number; basis: string }>;
  bills: Array<{ id: string; date: string; label: string; amount: number }>;
  cards: Array<{ name: string; headroom: number | null }>;
  bankTransfer: { on: boolean; keep: number };   // keep = share × (YouLend rate + Stripe fee)
}

const money = (n: number) => `£${Math.round(n).toLocaleString('en-GB')}`;
const MAX_LINKS = 5;

/**
 * Rules, not guesses (spec §8): for the first week whose committed close is
 * below the target, the things that would lift it, biggest first. Never
 * suggests delaying an excess refund or money owed to a client.
 */
export function buildFixList(f: FixInput): FixAction[] {
  if (!f.dip) return [];
  const out: FixAction[] = [];
  const dipEnd = f.dip.end;

  if (f.overdueBalances.length) {
    const list = [...f.overdueBalances].sort((a, b) => b.amount - a.amount);
    out.push({
      key: 'chase_overdue',
      title: `Chase ${list.length} overdue balance${list.length === 1 ? '' : 's'}`,
      detail: 'Hires that should already have paid. Not counted in the line until they do.',
      amount: list.reduce((s, x) => s + x.amount, 0),
      links: list.slice(0, MAX_LINKS).map((x) => ({ label: `${x.label} ${money(x.amount)}`, jobId: x.jobId })),
    });
  }

  // Balances due within a fortnight after the dip: asking early pulls them into it.
  const early = f.hireBalances.filter((b) => b.dueBy > dipEnd && daysBetween(dipEnd, b.dueBy) <= 14);
  if (early.length) {
    const list = [...early].sort((a, b) => b.amount - a.amount);
    out.push({
      key: 'ask_early',
      title: `Ask for ${list.length} balance${list.length === 1 ? '' : 's'} early`,
      detail: 'Due in the fortnight after the dip — send the portal link now.',
      amount: list.reduce((s, x) => s + x.amount, 0),
      links: list.slice(0, MAX_LINKS).map((x) => ({ label: `${x.label} ${money(x.amount)}`, jobId: x.jobId })),
    });
  }

  // Enquiries starting before a month after the dip: a booking brings its deposit in.
  const soon = f.enquiries.filter((e) => e.deposit > 0.005 && daysBetween(dipEnd, e.start) <= 28);
  if (soon.length) {
    const list = [...soon].sort((a, b) => b.deposit * b.chance - a.deposit * a.chance);
    out.push({
      key: 'nudge_enquiries',
      title: `Nudge ${list.length} enquir${list.length === 1 ? 'y' : 'ies'} starting soon`,
      detail: 'Ranked by deposit × chance of booking. The figure is the deposits if they all book.',
      amount: list.reduce((s, x) => s + x.deposit, 0),
      links: list.slice(0, MAX_LINKS).map((x) => ({ label: `${x.label} · ${Math.round(x.chance * 100)}%`, jobId: x.jobId })),
    });
  }

  const dipBills = f.bills.filter((b) => b.date >= f.dip!.start && b.date <= dipEnd);
  if (dipBills.length) {
    const list = [...dipBills].sort((a, b) => b.amount - a.amount);
    out.push({
      key: 'move_bills',
      title: `${list.length} Xero bill${list.length === 1 ? '' : 's'} due that week`,
      detail: 'Could any go a week later? Only with the supplier\'s say-so.',
      amount: list.reduce((s, x) => s + x.amount, 0),
      links: list.slice(0, MAX_LINKS).map((x) => ({ label: `${x.label} ${money(x.amount)}`, billId: x.id })),
    });
  }

  if (f.bankTransfer.on && f.bankTransfer.keep > 0.5) {
    out.push({
      key: 'bank_transfer',
      title: 'Ask for bank transfer, not card',
      detail: 'On the balances due up to the dip: keeps YouLend\'s cut and Stripe\'s fee in hand now. It doesn\'t reduce what\'s owed to YouLend — only when.',
      amount: f.bankTransfer.keep,
      links: [],
    });
  }

  for (const a of out) if (a.amount !== null) a.amount = Math.round(a.amount * 100) / 100;
  out.sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  const headroom = f.cards.filter((c) => c.headroom !== null && (c.headroom as number) > 0);
  if (headroom.length) {
    out.push({
      key: 'card_headroom',
      title: 'Card headroom',
      detail: headroom.map((c) => `${c.name}: ${money(c.headroom as number)} free`).join(' · '),
      amount: null,
      links: [],
    });
  }
  return out;
}
