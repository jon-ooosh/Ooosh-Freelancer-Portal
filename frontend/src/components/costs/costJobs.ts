/**
 * The capture form's "Jobs and who pays", as plain logic (no React, no network),
 * so it can be read and tested on its own. See
 * docs/design/cost-capture-redesign/DECISIONS.md.
 *
 * A cost lands on jobs as JOB CHOICES, one per job, each with its own "who pays"
 * (migration 318). How much of the invoice each job carries comes from:
 *   - a freelancer invoice: the work ticked on that job (a multi-drop run is
 *     spread over its stops' jobs by what was booked); studio evenings and yard
 *     days are on no job, so they stay with overheads;
 *   - any other cost: the amount typed against the job. One job left blank
 *     takes whatever the others don't (so one job = the whole cost).
 *
 * How it is SAVED, by planSplit():
 *   - no job → no job link, no split;
 *   - one job holding the whole cost → costs.job_id, and who pays on the cost
 *     itself (exactly what the form always saved);
 *   - anything else (several jobs, or one job holding only part) → a split, one
 *     share per job, each share carrying its own who pays. costs.job_id is the
 *     job with the biggest share.
 */
import type { FreelancerWorkItem } from './FreelancerInvoiceLinks';
import { ukDateOf } from '../../lib/ukDate';

export type WhoPays = 'quote' | 'charge' | 'ours';

export interface JobChoice {
  jobId: string;
  hhJobNumber: number | null;
  jobName: string | null;
  whoPays: WhoPays;
  /** Charge to client, only part of it: the net £ to recharge. '' = all of it. */
  part: string;
  partOpen: boolean;
  /** This job's share of the invoice (gross £), as typed. Unused while the job has ticked work. */
  amount: string;
  /** The saved share (edit), sent back by id so its recharge survives. */
  allocationId: string | null;
  /** A recharge on this job is already done (its status): who pays can't change here. */
  locked: string | null;
  /** A person chose who pays (or it was saved), so the defaults stop applying. */
  touched: boolean;
  /** Added by hand, so it stays when the ticked work moves off it. */
  manual: boolean;
  /** A saved share read back on edit, not yet compared with the ticked work. */
  seeded?: boolean;
}

/** Fuel, parking, travel: what a "recharge running costs" job recharges. Mirrors RUNNING_COST_CODES in routes/costs.ts. */
export const RUNNING_COST_CODES = new Set(['410', '411', '325']);

/** Recharge statuses that record something that happened. Mirrors TERMINAL_RECHARGE in services/cost-recharges.ts. */
export const DONE_RECHARGE = new Set(['recharged_hh', 'recharged_external', 'absorbed']);

const round2 = (n: number) => Math.round(n * 100) / 100;
const pence = (n: number) => Math.round((Number(n) || 0) * 100);
export const num = (v: string | number | null | undefined) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

export function jobLabel(c: { hhJobNumber: number | null; jobName: string | null }): string {
  if (c.hhJobNumber) return `#${c.hhJobNumber}${c.jobName ? ` ${c.jobName}` : ''}`;
  return c.jobName || 'Job (no HireHop number)';
}

/** A global-search job result ("#16710 - APS / Vodafone") as a number and a name. */
export function parseJobSearchName(name: string): { hhJobNumber: number | null; jobName: string | null } {
  const m = name.match(/^#(\d+)\s*-\s*(.*)$/);
  if (m) return { hhJobNumber: Number(m[1]), jobName: m[2].trim() || null };
  return { hhJobNumber: null, jobName: name || null };
}

export function newChoice(job: { jobId: string; hhJobNumber: number | null; jobName: string | null }, manual: boolean): JobChoice {
  return { ...job, whoPays: 'quote', part: '', partOpen: false, amount: '', allocationId: null, locked: null, touched: false, manual };
}

/**
 * Who pays, before anyone chooses (DECISIONS.md "Who pays"). A freelancer's
 * invoice is mostly their fee, which the quote already charges, so it never
 * defaults to a recharge (the PR #1535 rule); fuel, parking and travel on a job
 * that recharges its running costs default to the client; otherwise a job with
 * a quote has it covered, and a job without one is ours. Unknown (still
 * loading) reads as "has a quote", the form's old default.
 */
export function defaultWhoPays(o: { freelance: boolean; categoryCode: string; rechargesRunningCosts?: boolean; hasQuotes?: boolean }): WhoPays {
  if (o.freelance) return 'quote';
  if (o.rechargesRunningCosts && RUNNING_COST_CODES.has(o.categoryCode)) return 'charge';
  return o.hasQuotes === false ? 'ours' : 'quote';
}

export interface SavedWhoPays {
  cost_intent: 'quote_actual' | 'extra' | null;
  recharge_mode: 'none' | 'full' | 'partial';
  recharge_amount: number | null;
}

/** The saved columns for a who-pays answer (same on the cost and on a share). */
export function whoPaysToSaved(w: WhoPays, part: string): SavedWhoPays {
  if (w === 'quote') return { cost_intent: 'quote_actual', recharge_mode: 'none', recharge_amount: null };
  if (w === 'ours') return { cost_intent: 'extra', recharge_mode: 'none', recharge_amount: null };
  const p = num(part);
  return p > 0
    ? { cost_intent: 'extra', recharge_mode: 'partial', recharge_amount: round2(p) }
    : { cost_intent: 'extra', recharge_mode: 'full', recharge_amount: null };
}

/** Read a saved answer back. A legacy row with no intent: recharged → extra, else part of the quote. */
export function savedToWhoPays(intent: string | null | undefined, mode: string | null | undefined, amount: number | string | null | undefined): { whoPays: WhoPays; part: string; partOpen: boolean } {
  const m = mode || 'none';
  if (m === 'partial') return { whoPays: 'charge', part: amount != null ? String(amount) : '', partOpen: true };
  if (m === 'full') return { whoPays: 'charge', part: '', partOpen: false };
  if (intent === 'extra') return { whoPays: 'ours', part: '', partOpen: false };
  return { whoPays: 'quote', part: '', partOpen: false };
}

/** What a done recharge reads as on a locked row. */
export function lockedLabel(status: string | null): string {
  if (status === 'recharged_hh') return 'Recharged on HireHop ✓';
  if (status === 'recharged_external') return 'Billed another way ✓';
  if (status === 'absorbed') return 'Absorbed';
  return 'Recharge resolved';
}

/** A work item's stops; a booking is one stop on its own job. */
function partsOf(it: FreelancerWorkItem) {
  return it.parts?.length
    ? it.parts
    : [{ kind: 'booking' as const, id: it.key, weight: 1, jobId: it.jobId, hhJobNumber: it.hhJobNumber, jobName: it.jobName }];
}

/**
 * Spread `amountPence` over a work item's stops by what each was booked at, the
 * same arithmetic as planWorkLinks() in services/freelancer-work.ts (the last
 * stop takes the odd penny).
 */
function spreadOverStops(it: FreelancerWorkItem, amountPence: number): Array<{ jobId: string | null; pence: number }> {
  const parts = partsOf(it);
  const totalWeight = parts.reduce((t, p) => t + (p.weight || 0), 0) || parts.length;
  let given = 0;
  return parts.map((p, i) => {
    const share = i === parts.length - 1 ? amountPence - given : Math.round((amountPence * (p.weight || 0)) / totalWeight);
    given += share;
    return { jobId: p.jobId, pence: share };
  });
}

/**
 * Each ticked work item's share of the invoice. A typed figure is kept as
 * typed; the rest of `pool` (the invoice less what's typed) is shared across
 * the untyped ones in proportion to what was booked (fee + expense estimate),
 * pennies to the last, so the shares add back to the pool.
 */
export function workAmounts(items: FreelancerWorkItem[], ticked: string[], typed: Record<string, string>, pool: number): Record<string, number> {
  const out: Record<string, number> = {};
  const on = items.filter((it) => ticked.includes(it.key));
  let typedTotal = 0;
  const untyped: FreelancerWorkItem[] = [];
  for (const it of on) {
    if (typed[it.key] !== undefined && typed[it.key].trim() !== '') {
      out[it.key] = round2(num(typed[it.key]));
      typedTotal += out[it.key];
    } else {
      untyped.push(it);
    }
  }
  if (!untyped.length) return out;
  const left = Math.max(0, pence(pool) - pence(typedTotal));
  const weights = untyped.map((it) => Math.max(0, it.fee + it.estimate) || 1);
  const total = weights.reduce((t, w) => t + w, 0);
  let given = 0;
  untyped.forEach((it, i) => {
    const share = i === untyped.length - 1 ? left - given : Math.round((left * weights[i]) / total);
    given += share;
    out[it.key] = share / 100;
  });
  return out;
}

/**
 * Gross per job from the ticked work. Work on no job (studio evenings, yard
 * days) is left out, so it stays with overheads.
 */
export function jobAmountsFromWork(items: FreelancerWorkItem[], ticked: string[], amounts: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (!ticked.includes(it.key)) continue;
    for (const s of spreadOverStops(it, pence(amounts[it.key] ?? 0))) {
      if (s.jobId) out.set(s.jobId, (out.get(s.jobId) ?? 0) + s.pence);
    }
  }
  for (const [k, v] of out) out.set(k, v / 100);
  return out;
}

/**
 * What they invoiced over their fee on each job (before VAT): the fuel, tolls
 * and parking. What "Charge to client" offers to recharge on a freelancer's
 * invoice, since their fee is already in the quote.
 */
export function expensesByJob(items: FreelancerWorkItem[], ticked: string[], amounts: Record<string, number>, netRatio: number): Map<string, number> {
  const out = new Map<string, number>();
  for (const it of items) {
    if (!ticked.includes(it.key)) continue;
    const over = Math.max(0, pence((amounts[it.key] ?? 0) * netRatio) - pence(it.fee));
    for (const s of spreadOverStops(it, over)) {
      if (s.jobId) out.set(s.jobId, (out.get(s.jobId) ?? 0) + s.pence);
    }
  }
  for (const [k, v] of out) out.set(k, v / 100);
  return out;
}

/** The jobs ticked work lands on, with the HireHop number and name for each. */
export function jobsOfWork(items: FreelancerWorkItem[], ticked: string[]): Array<{ jobId: string; hhJobNumber: number | null; jobName: string | null }> {
  const seen = new Map<string, { jobId: string; hhJobNumber: number | null; jobName: string | null }>();
  for (const it of items) {
    if (!ticked.includes(it.key)) continue;
    for (const p of partsOf(it)) {
      if (!p.jobId || seen.has(p.jobId)) continue;
      seen.set(p.jobId, { jobId: p.jobId, hhJobNumber: p.hhJobNumber ?? null, jobName: p.jobName ?? null });
    }
  }
  return [...seen.values()];
}

/**
 * Bring the job choices in line with the ticked work: a job the work is on gets
 * a choice (who pays defaulted), and a choice only there because of work that
 * is no longer ticked goes. Hand-added jobs and saved shares whose recharge is
 * done always stay. A saved share read back on edit counts as hand-added only
 * when none of the ticked work is on its job.
 */
export function applyWork(choices: JobChoice[], items: FreelancerWorkItem[], ticked: string[]): JobChoice[] {
  const work = jobsOfWork(items, ticked);
  const onWork = new Set(work.map((w) => w.jobId));
  const next = choices
    .map((c) => (c.seeded ? { ...c, seeded: false, manual: !onWork.has(c.jobId) } : c))
    .filter((c) => c.manual || c.locked || onWork.has(c.jobId));
  for (const w of work) {
    if (!next.some((c) => c.jobId === w.jobId)) next.push(newChoice(w, false));
  }
  return next;
}

/**
 * Gross per job. Jobs with ticked work take the work's figure; the rest take
 * their typed amount. With no ticked work at all, the first job left blank
 * takes whatever the typed ones don't, so one job on its own holds the cost.
 */
export function choiceAmounts(gross: number, choices: JobChoice[], amountByJob: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const g = round2(gross);
  const typedPence = choices
    .filter((c) => !amountByJob.has(c.jobId) && c.amount.trim() !== '')
    .reduce((t, c) => t + pence(num(c.amount)), 0);
  const rest = amountByJob.size === 0 ? choices.find((c) => c.amount.trim() === '') : undefined;
  for (const c of choices) {
    if (amountByJob.has(c.jobId)) out.set(c.jobId, round2(amountByJob.get(c.jobId) as number));
    else if (c === rest) out.set(c.jobId, Math.max(0, pence(g) - typedPence) / 100);
    else out.set(c.jobId, round2(num(c.amount)));
  }
  return out;
}

/** The pot ticked work shares: the invoice, less what is typed against jobs the work isn't on. */
export function workPool(gross: number, choices: JobChoice[], items: FreelancerWorkItem[], ticked: string[]): number {
  const onWork = new Set(jobsOfWork(items, ticked).map((w) => w.jobId));
  const typed = choices.filter((c) => !onWork.has(c.jobId)).reduce((t, c) => t + pence(num(c.amount)), 0);
  return Math.max(0, pence(gross) - typed) / 100;
}

export interface ShareOut {
  id?: string;
  job_id: string;
  amount: number;
  cost_intent?: 'quote_actual' | 'extra' | null;
  recharge_mode?: 'none' | 'full' | 'partial';
  recharge_amount?: number | null;
}

export interface SplitPlan {
  kind: 'none' | 'whole' | 'split';
  /** costs.job_id to save. */
  jobId: string | null;
  /** Who pays on the cost itself; null = leave the cost's own answer alone. */
  costLevel: SavedWhoPays | null;
  /** The split to save ([] clears it). */
  shares: ShareOut[];
  onJobs: number;
  overheads: number;
  /** How far the jobs exceed the invoice (blocks the save; the server refuses it too). */
  over: number;
  /** Jobs added by hand with nothing against them: say so rather than drop them. */
  empty: JobChoice[];
}

/**
 * How the jobs are saved. `whoPaysOf` gives each choice's answer (its own, or
 * the default while untouched). `wholeLocked` = the cost carries a recharge as a
 * whole that has to stand (done, or on a cost already split the old way), so
 * nothing about who pays is sent, on the cost or on a share.
 */
export function planSplit(
  gross: number, choices: JobChoice[], amountByJob: Map<string, number>, wholeLocked: boolean,
  whoPaysOf: (c: JobChoice) => WhoPays,
): SplitPlan {
  const g = round2(gross);
  const amounts = choiceAmounts(g, choices, amountByJob);
  const rows = choices.map((c) => ({ c, amount: amounts.get(c.jobId) ?? 0 }));
  // A job holding nothing isn't on the cost, unless it is a saved share whose
  // recharge is done (it has to stay). One added by hand is reported instead.
  const mustStay = (c: JobChoice) => Boolean(c.allocationId && c.locked);
  const kept = rows.filter((r) => r.amount > 0 || mustStay(r.c));
  const empty = rows.filter((r) => !(r.amount > 0) && !mustStay(r.c) && r.c.manual).map((r) => r.c);
  const onJobs = round2(kept.reduce((t, r) => t + r.amount, 0));
  const over = round2(Math.max(0, onJobs - g));
  const overheads = round2(Math.max(0, g - onJobs));
  const saved = (c: JobChoice) => whoPaysToSaved(whoPaysOf(c), c.part);

  if (!kept.length) {
    // No job: no quote to be part of, nothing to recharge (what the form always sent).
    return {
      kind: 'none', jobId: null,
      costLevel: wholeLocked ? null : { cost_intent: null, recharge_mode: 'none', recharge_amount: null },
      shares: [], onJobs, overheads, over, empty,
    };
  }
  const only = kept.length === 1 ? kept[0] : null;
  if (only && pence(only.amount) === pence(g) && !mustStay(only.c)) {
    return {
      kind: 'whole', jobId: only.c.jobId,
      costLevel: wholeLocked || only.c.locked ? null : saved(only.c),
      shares: [], onJobs, overheads, over, empty,
    };
  }
  const biggest = kept.reduce((a, b) => (b.amount > a.amount ? b : a));
  return {
    kind: 'split', jobId: biggest.c.jobId,
    // The shares carry who pays; the cost itself is never recharged as well.
    costLevel: wholeLocked ? null : { ...saved(biggest.c), recharge_mode: 'none', recharge_amount: null },
    shares: kept.map(({ c, amount }) => ({
      ...(c.allocationId ? { id: c.allocationId } : {}),
      job_id: c.jobId,
      amount,
      // A done share's answer is fixed; under a whole-cost recharge a share inherits the cost's.
      ...(c.locked || wholeLocked ? {} : saved(c)),
    })),
    onJobs, overheads, over, empty,
  };
}

/**
 * Booked vs invoiced for ONE row, compared before VAT, the same rule as the
 * whole-invoice check: fees should match; expenses are estimates, "about right"
 * up to the larger of £X or Y% over them (system_settings).
 */
export function rowVerdict(rowNet: number, fee: number, estimate: number, tol: { gbp: number; pct: number }):
  { tone: 'ok' | 'over' | 'under'; text: string; over: number } {
  const allowed = round2(Math.max(tol.gbp, (estimate * tol.pct) / 100));
  const over = round2(rowNet - fee - estimate);
  if (rowNet < fee - 0.5) return { tone: 'under', text: `£${round2(fee - rowNet).toFixed(2)} under the fee`, over };
  if (over > allowed) return { tone: 'over', text: `⚠ £${over.toFixed(2)} over`, over };
  return { tone: 'ok', text: over > 0.5 ? '≈ Close enough' : '✓ As expected', over };
}

export interface VanRow {
  vehicle_id: string | null;
  vehicle_reg?: string | null;
  hire_start?: string | null;
  hire_end?: string | null;
  status?: string | null;
  swapped_at?: string | null;
}

function dayOf(v: string | null | undefined): string | null {
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : ukDateOf(d);
}

/**
 * The vans on a job on a given day, one per van. A van swapped out stops
 * counting on the day of the swap (its replacement starts that day), so a
 * receipt from after a breakdown lands on the van that was actually out. When
 * no van's dates cover the day, every van still on the job is offered.
 */
export function vansOnDate(rows: VanRow[], day: string): Array<{ id: string; reg: string }> {
  const live = rows.filter((r) => r.vehicle_id && r.status !== 'cancelled');
  const covers = (r: VanRow) => {
    const from = dayOf(r.hire_start);
    const to = r.status === 'swapped' ? dayOf(r.swapped_at) : dayOf(r.hire_end);
    if (r.status === 'swapped' && to === day) return false;
    return (!from || from <= day) && (!to || day <= to);
  };
  const onDay = live.filter(covers);
  const pool = onDay.length ? onDay : live.filter((r) => r.status !== 'swapped');
  const seen = new Map<string, string>();
  for (const r of pool) if (!seen.has(r.vehicle_id as string)) seen.set(r.vehicle_id as string, r.vehicle_reg || 'Van');
  return [...seen.entries()].map(([id, reg]) => ({ id, reg }));
}
