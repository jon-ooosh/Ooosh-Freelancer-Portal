/**
 * Damage money — the pure sums behind the Money card on a Problem and on an
 * insurance claim (docs/INCIDENT-CLAIMS-SPEC.md §23). No database here, so
 * every rule is testable on its own; `damage-money.ts` loads the rows.
 *
 * The rules, in one place:
 *   - Everything is compared EX VAT. We reclaim VAT on what we spend, and the
 *     VAT on what we charge a client goes to HMRC, so only net money is ours.
 *     (Ooosh's standard damage charge is £1,000 + VAT = £1,200.)
 *   - What we spent is the Costs entries (Money › Costs). Until there is one,
 *     the estimate stands in, and the result says it is an estimate.
 *   - Insurer money paid STRAIGHT TO THE REPAIRER never reduces our cost — it
 *     was never ours. Their bill to us (usually our excess + VAT) is the cost.
 */

export type MoneyLineKind = 'client_recovery' | 'insurer_payment';
export type RecoverySource = 'excess' | 'invoice' | 'other';
export type InsurerPaidTo = 'ooosh' | 'repairer';

export const RECOVERY_SOURCES: readonly RecoverySource[] = ['excess', 'invoice', 'other'];
export const INSURER_PAID_TO: readonly InsurerPaidTo[] = ['ooosh', 'repairer'];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A number from a NUMERIC column (pg gives strings), or null. */
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** What a Costs entry cost us ex VAT. Older rows may carry only the gross. */
export function costNet(c: { amount_net?: unknown; amount_gross?: unknown; amount_vat?: unknown }): number {
  const net = num(c.amount_net);
  if (net !== null) return net;
  return round2((num(c.amount_gross) ?? 0) - (num(c.amount_vat) ?? 0));
}

/**
 * Net, VAT and gross as typed. Any of them may be left out when it can be
 * worked out from the other two; all three must then add up (to the penny,
 * allowing a penny of rounding). Never negative. Returns the error to show,
 * or the three amounts rounded to pence.
 */
export function checkAmounts(input: { amount_net?: number | null; amount_vat?: number | null; amount_gross?: number | null }):
  { ok: true; net: number; vat: number; gross: number } | { ok: false; error: string } {
  let net = input.amount_net ?? null;
  let vat = input.amount_vat ?? null;
  let gross = input.amount_gross ?? null;
  if (net === null && gross === null) return { ok: false, error: 'Give an amount' };
  if (net !== null && gross === null) gross = net + (vat ?? 0);
  if (gross !== null && net === null) net = gross - (vat ?? 0);
  if (vat === null) vat = (gross as number) - (net as number);
  net = round2(net as number);
  vat = round2(vat);
  gross = round2(gross as number);
  if (net < 0 || vat < 0 || gross < 0) return { ok: false, error: 'Amounts can’t be negative' };
  // In whole pence, so a penny of rounding isn't refused by floating point.
  if (Math.abs(Math.round(gross * 100) - Math.round(net * 100) - Math.round(vat * 100)) > 1) {
    return { ok: false, error: 'Net + VAT doesn’t add up to the gross' };
  }
  if (gross <= 0) return { ok: false, error: 'Give an amount' };
  return { ok: true, net, vat, gross };
}

export interface TotalsInput {
  /** The estimate, ex VAT — null when nobody has given one. */
  estimateNet: number | null;
  costs: Array<{ amount_net?: unknown; amount_gross?: unknown; amount_vat?: unknown }>;
  lines: Array<{ kind: MoneyLineKind; paid_to?: InsurerPaidTo | null; amount_net: unknown; amount_gross: unknown }>;
}

export interface DamageTotals {
  costs_net: number;
  costs_gross: number;
  recovered_net: number;
  recovered_gross: number;
  insurer_to_us: number;
  insurer_to_repairer: number;
  /** What it cost Ooosh, ex VAT. Null when there is no cost AND no estimate. */
  net_cost: number | null;
  /** True while no real cost has been added — the estimate is standing in. */
  net_cost_is_estimate: boolean;
}

export function damageTotals({ estimateNet, costs, lines }: TotalsInput): DamageTotals {
  const costs_net = round2(costs.reduce((t, c) => t + costNet(c), 0));
  const costs_gross = round2(costs.reduce((t, c) => t + (num(c.amount_gross) ?? costNet(c)), 0));
  const rec = lines.filter((l) => l.kind === 'client_recovery');
  const ins = lines.filter((l) => l.kind === 'insurer_payment');
  const recovered_net = round2(rec.reduce((t, l) => t + (num(l.amount_net) ?? 0), 0));
  const recovered_gross = round2(rec.reduce((t, l) => t + (num(l.amount_gross) ?? 0), 0));
  const insurer_to_us = round2(ins.filter((l) => l.paid_to === 'ooosh').reduce((t, l) => t + (num(l.amount_net) ?? 0), 0));
  const insurer_to_repairer = round2(ins.filter((l) => l.paid_to === 'repairer').reduce((t, l) => t + (num(l.amount_net) ?? 0), 0));

  const hasCosts = costs.length > 0;
  const spend = hasCosts ? costs_net : estimateNet;
  const net_cost = spend === null ? null : round2(spend - recovered_net - insurer_to_us);
  return {
    costs_net, costs_gross, recovered_net, recovered_gross, insurer_to_us, insurer_to_repairer,
    net_cost, net_cost_is_estimate: !hasCosts,
  };
}

export interface ExcessCheck {
  /** The hire's excess kept for damage and charges (job_excess.claim_amount), gross. */
  kept_gross: number;
  /** Still held — taken but not yet kept or paid back (v_excess_held). */
  held_gross: number;
  /** Recovery lines "from the excess" on this hire's Problems and claims, gross. */
  against_damage_gross: number;
  /** Kept but not put against any Problem or claim (fuel, lost items…). Negative = more put against damage than was kept. */
  unassigned_gross: number;
}

export function excessCheck(kept: number, held: number, againstDamage: number): ExcessCheck | null {
  if (kept <= 0.004 && held <= 0.004 && againstDamage <= 0.004) return null;
  return {
    kept_gross: round2(kept),
    held_gross: round2(held),
    against_damage_gross: round2(againstDamage),
    unassigned_gross: round2(kept - againstDamage),
  };
}
