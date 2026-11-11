/**
 * Damage money — THE read for the Money card on a Problem and on an insurance
 * claim (docs/INCIDENT-CLAIMS-SPEC.md §23). The sums live in
 * `damage-money-maths.ts`; this file only loads the rows.
 *
 * Where each figure comes from (nothing is copied — each is read live):
 *   - estimate: job_issues.estimated_cost (a Problem) or the broker form's
 *     form_data.our_vehicle.repair_cost (a claim — the figure the broker PDF
 *     prints). Both ex VAT.
 *   - costs: Money › Costs entries linked to the Problem(s) (costs.job_issue_id).
 *   - recovered from the client / insurer payments: damage_money_lines.
 *   - the excess check: the hire's job_excess (kept = claim_amount, held =
 *     v_excess_held) against the "from the excess" recovery lines on all of
 *     that hire's Problems and claims.
 *
 * A Problem that is on a claim keeps its costs, but its money is read on the
 * claim: the claim's card gathers every linked Problem's costs and lines.
 */
import { query } from '../config/database';
import { claimLabel } from './incident-claims';
import {
  damageTotals, excessCheck, num,
  type DamageTotals, type ExcessCheck, type MoneyLineKind, type RecoverySource, type InsurerPaidTo,
} from './damage-money-maths';

export interface DamageCostRow {
  id: string;
  supplier_name: string | null;
  description: string | null;
  cost_date: string | null;
  amount_net: number | null;
  amount_vat: number | null;
  amount_gross: number | null;
  payment_status: string;
  job_issue_id: string;
  problem_summary: string | null;
}

export interface DamageMoneyLine {
  id: string;
  issue_id: string | null;
  claim_id: string | null;
  kind: MoneyLineKind;
  source: RecoverySource | null;
  paid_to: InsurerPaidTo | null;
  description: string | null;
  amount_net: number;
  amount_vat: number;
  amount_gross: number;
  entry_date: string | null;
  problem_summary: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface DamageMoneySummary {
  scope: 'problem' | 'claim';
  /** A Problem on a claim: its money is read on the claim. */
  on_claim: { id: string; label: string } | null;
  /** The estimate this card shows and edits, ex VAT. */
  estimate_net: number | null;
  /** A claim only: what its Problems' own estimates add up to (null when none has one). */
  problems_estimate_net: number | null;
  /** A claim only: the Problems a cost can be added to. */
  problems: Array<{ id: string; summary: string }>;
  costs: DamageCostRow[];
  lines: DamageMoneyLine[];
  /** The old typed "Actual" box, from before costs were linked. Read-only. */
  legacy_actual: Array<{ issue_id: string; summary: string; actual_cost: number }>;
  hire: { job_id: string; hh_job_number: number | null } | null;
  excess: ExcessCheck | null;
  totals: DamageTotals;
}

const toNum = (v: unknown) => num(v) ?? 0;

async function loadCosts(issueIds: string[]): Promise<DamageCostRow[]> {
  if (issueIds.length === 0) return [];
  const r = await query(
    `SELECT c.id, c.supplier_name, c.description, to_char(c.cost_date, 'YYYY-MM-DD') AS cost_date,
            c.amount_net, c.amount_vat, c.amount_gross, c.payment_status, c.job_issue_id,
            ji.summary AS problem_summary
     FROM costs c
     JOIN job_issues ji ON ji.id = c.job_issue_id
     WHERE c.job_issue_id = ANY($1::uuid[])
     ORDER BY c.cost_date NULLS LAST, c.created_at`,
    [issueIds],
  );
  return r.rows.map((c) => ({
    ...c,
    amount_net: num(c.amount_net),
    amount_vat: num(c.amount_vat),
    amount_gross: num(c.amount_gross),
  }));
}

async function loadLines(issueIds: string[], claimId: string | null): Promise<DamageMoneyLine[]> {
  const r = await query(
    `SELECT l.id, l.issue_id, l.claim_id, l.kind, l.source, l.paid_to, l.description,
            l.amount_net, l.amount_vat, l.amount_gross,
            to_char(l.entry_date, 'YYYY-MM-DD') AS entry_date, l.created_at,
            ji.summary AS problem_summary,
            NULLIF(TRIM(CONCAT(p.first_name, ' ', p.last_name)), '') AS created_by_name
     FROM damage_money_lines l
     LEFT JOIN job_issues ji ON ji.id = l.issue_id
     LEFT JOIN users u ON u.id = l.created_by
     LEFT JOIN people p ON p.id = u.person_id
     WHERE l.deleted_at IS NULL
       AND (l.issue_id = ANY($1::uuid[]) OR ($2::uuid IS NOT NULL AND l.claim_id = $2::uuid))
     ORDER BY l.entry_date NULLS LAST, l.created_at`,
    [issueIds, claimId],
  );
  return r.rows.map((l) => ({
    ...l,
    amount_net: toNum(l.amount_net),
    amount_vat: toNum(l.amount_vat),
    amount_gross: toNum(l.amount_gross),
  }));
}

/** The hire's excess against the "from the excess" lines on all its Problems and claims. */
async function loadExcessCheck(jobId: string): Promise<ExcessCheck | null> {
  const [kept, held, against] = await Promise.all([
    query(`SELECT COALESCE(SUM(claim_amount), 0) AS v FROM job_excess WHERE job_id = $1`, [jobId]),
    query(`SELECT COALESCE(SUM(held_amount), 0) AS v FROM v_excess_held WHERE job_id = $1`, [jobId]),
    query(
      `SELECT COALESCE(SUM(l.amount_gross), 0) AS v
       FROM damage_money_lines l
       LEFT JOIN job_issues ji ON ji.id = l.issue_id
       LEFT JOIN incident_claims c ON c.id = l.claim_id AND c.is_deleted = false
       WHERE l.deleted_at IS NULL AND l.kind = 'client_recovery' AND l.source = 'excess'
         AND (ji.job_id = $1 OR c.job_id = $1)`,
      [jobId],
    ),
  ]);
  return excessCheck(toNum(kept.rows[0]?.v), toNum(held.rows[0]?.v), toNum(against.rows[0]?.v));
}

function legacyActual(rows: Array<{ id: string; summary: string; actual_cost: unknown }>) {
  return rows
    .filter((p) => num(p.actual_cost) !== null)
    .map((p) => ({ issue_id: p.id, summary: p.summary, actual_cost: num(p.actual_cost) as number }));
}

/** The Money card for one Problem. Null when the Problem doesn't exist. */
export async function getProblemMoney(issueId: string): Promise<DamageMoneySummary | null> {
  const r = await query(
    `SELECT ji.id, ji.summary, ji.job_id, ji.claim_id, ji.estimated_cost, ji.actual_cost,
            j.hh_job_number,
            c.id AS live_claim_id, c.vehicle_reg AS claim_vehicle_reg, c.hh_job_number AS claim_hh_job_number
     FROM job_issues ji
     LEFT JOIN jobs j ON j.id = ji.job_id
     LEFT JOIN incident_claims c ON c.id = ji.claim_id AND c.is_deleted = false
     WHERE ji.id = $1`,
    [issueId],
  );
  const p = r.rows[0];
  if (!p) return null;

  const [costs, lines, excess] = await Promise.all([
    loadCosts([p.id]),
    loadLines([p.id], null),
    p.job_id ? loadExcessCheck(p.job_id) : Promise.resolve(null),
  ]);
  const estimate = num(p.estimated_cost);
  return {
    scope: 'problem',
    on_claim: p.live_claim_id
      ? { id: p.live_claim_id, label: claimLabel({ vehicle_reg: p.claim_vehicle_reg, hh_job_number: p.claim_hh_job_number }) }
      : null,
    estimate_net: estimate,
    problems_estimate_net: null,
    problems: [],
    costs,
    lines,
    legacy_actual: legacyActual([p]),
    hire: p.job_id ? { job_id: p.job_id, hh_job_number: p.hh_job_number ?? null } : null,
    excess,
    totals: damageTotals({ estimateNet: estimate, costs, lines }),
  };
}

/** The Money card for one claim — every linked Problem's costs and lines too. */
export async function getClaimMoney(claimId: string): Promise<DamageMoneySummary | null> {
  const r = await query(
    `SELECT c.id, c.job_id, c.hh_job_number, c.vehicle_reg, c.origin_issue_id,
            c.form_data->'our_vehicle'->>'repair_cost' AS repair_cost
     FROM incident_claims c
     WHERE c.id = $1 AND c.is_deleted = false`,
    [claimId],
  );
  const c = r.rows[0];
  if (!c) return null;
  const probs = await query(
    `SELECT id, summary, estimated_cost, actual_cost
     FROM job_issues WHERE claim_id = $1
     ORDER BY (id = $2) DESC, created_at`,
    [claimId, c.origin_issue_id],
  );
  const ids: string[] = probs.rows.map((p) => p.id);
  const [costs, lines, excess] = await Promise.all([
    loadCosts(ids),
    loadLines(ids, claimId),
    c.job_id ? loadExcessCheck(c.job_id) : Promise.resolve(null),
  ]);
  const problemEstimates = probs.rows.map((p) => num(p.estimated_cost)).filter((n): n is number => n !== null);
  const estimate = num(c.repair_cost);
  return {
    scope: 'claim',
    on_claim: null,
    estimate_net: estimate,
    problems_estimate_net: problemEstimates.length
      ? Math.round(problemEstimates.reduce((t, n) => t + n, 0) * 100) / 100
      : null,
    problems: probs.rows.map((p) => ({ id: p.id, summary: p.summary })),
    costs,
    lines,
    legacy_actual: legacyActual(probs.rows),
    hire: c.job_id ? { job_id: c.job_id, hh_job_number: c.hh_job_number ?? null } : null,
    excess,
    totals: damageTotals({ estimateNet: estimate, costs, lines }),
  };
}
