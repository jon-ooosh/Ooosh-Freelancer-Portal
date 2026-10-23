/**
 * Recharges, one per job they bill (migration 318).
 *
 * A recharge lives in one of two places:
 *   - on the COST (costs.recharge_*): the whole cost, billed to the cost's own
 *     job. Every recharge before migration 318 is this kind.
 *   - on a SPLIT ROW (cost_allocations.recharge_*): one job's share of a split
 *     cost, billed to that share's job. A freelancer invoice covering five jobs
 *     can recharge each job's fuel to that job's client.
 *
 * A cost uses one or the other, never both, so nothing is billed twice. This
 * file holds that rule and the one way to load or write a recharge wherever it
 * lives. Reading the LIST of recharges is the `v_cost_recharges` view.
 *
 * The column names are identical on both tables, which is what lets one write
 * path serve both.
 */
import { query } from '../config/database';

export const TERMINAL_RECHARGE = new Set(['recharged_hh', 'recharged_external', 'absorbed']);

/** Where a recharge lives: the whole cost, or one job's share of it. */
export interface RechargeTarget {
  costId: string;
  /** cost_allocations.id, or null for a whole-cost recharge. */
  allocationId: string | null;
}

export interface LoadedRecharge extends RechargeTarget {
  /** The cost row itself (SELECT *). */
  cost: Record<string, any>;
  /** The cost's OWN job's HireHop number (where a whole-cost recharge bills). */
  costHhJobNumber: number | null;
  /** The job this recharge bills. */
  jobId: string | null;
  hhJobNumber: number | null;
  /** That job's answer, falling back to the cost's when the share has none. */
  costIntent: string | null;
  rechargeMode: string;
  rechargeAmount: number | null;
  rechargeStatus: string | null;
  rechargedToHhAt: string | null;
  /** What this is a recharge OF: the whole cost, or the share. */
  shareGross: number | null;
  shareNet: number | null;
}

/** The recharge columns, on both tables. Nothing else may be written here. */
const RECHARGE_COLUMNS = new Set([
  'recharge_mode', 'recharge_amount', 'recharge_status', 'recharge_base_amount',
  'recharge_markup_type', 'recharge_markup_value', 'recharge_resolution_note',
  'recharge_resolved_by', 'recharge_resolved_at', 'recharged_to_hh_at', 'recharge_hh_item_id',
]);

const numOrNull = (v: unknown) => (v == null ? null : Number(v));

/**
 * Load a recharge wherever it lives. Null when the cost doesn't exist, or the
 * split row doesn't belong to it.
 */
export async function loadRecharge(costId: string, allocationId: string | null): Promise<LoadedRecharge | null> {
  const c = await query(
    `SELECT c.*, j.hh_job_number AS t_hh_job_number
       FROM costs c LEFT JOIN jobs j ON j.id = c.job_id
      WHERE c.id = $1`,
    [costId],
  );
  const cost = c.rows[0];
  if (!cost) return null;
  const { t_hh_job_number: costHh, ...costRow } = cost;

  if (!allocationId) {
    return {
      costId, allocationId: null, cost: costRow, costHhJobNumber: numOrNull(costHh),
      jobId: cost.job_id ?? null,
      hhJobNumber: numOrNull(costHh),
      costIntent: cost.cost_intent ?? null,
      rechargeMode: cost.recharge_mode || 'none',
      rechargeAmount: numOrNull(cost.recharge_amount),
      rechargeStatus: cost.recharge_status ?? null,
      rechargedToHhAt: cost.recharged_to_hh_at ?? null,
      shareGross: numOrNull(cost.amount_gross),
      shareNet: numOrNull(cost.amount_net),
    };
  }

  const a = await query(
    `SELECT a.*, j.hh_job_number,
            cost_share_net(a.amount, c.amount_gross, c.amount_net) AS share_net
       FROM cost_allocations a
       JOIN costs c ON c.id = a.cost_id
       LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.id = $1 AND a.cost_id = $2`,
    [allocationId, costId],
  );
  const share = a.rows[0];
  if (!share) return null;
  return {
    costId, allocationId, cost: costRow, costHhJobNumber: numOrNull(costHh),
    jobId: share.job_id ?? null,
    hhJobNumber: numOrNull(share.hh_job_number),
    costIntent: share.cost_intent ?? cost.cost_intent ?? null,
    rechargeMode: share.recharge_mode || 'none',
    rechargeAmount: numOrNull(share.recharge_amount),
    rechargeStatus: share.recharge_status ?? null,
    rechargedToHhAt: share.recharged_to_hh_at ?? null,
    shareGross: numOrNull(share.amount),
    shareNet: numOrNull(share.share_net),
  };
}

/** Write recharge columns where the recharge lives. Returns the updated row. */
export async function updateRecharge(t: RechargeTarget, sets: Record<string, unknown>): Promise<Record<string, any> | null> {
  const cols = Object.keys(sets).filter((k) => sets[k] !== undefined);
  for (const k of cols) {
    if (!RECHARGE_COLUMNS.has(k)) throw new Error(`updateRecharge: ${k} is not a recharge column`);
  }
  if (!cols.length) return null;
  const vals = cols.map((k) => sets[k]);
  const assign = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
  if (t.allocationId) {
    vals.push(t.allocationId, t.costId);
    const r = await query(
      `UPDATE cost_allocations SET ${assign} WHERE id = $${vals.length - 1} AND cost_id = $${vals.length} RETURNING *`,
      vals,
    );
    return r.rows[0] ?? null;
  }
  vals.push(t.costId);
  const r = await query(`UPDATE costs SET ${assign} WHERE id = $${vals.length} RETURNING *`, vals);
  return r.rows[0] ?? null;
}

/** Does any job's share of this cost carry its own recharge? */
export async function hasPerJobRecharges(costId: string): Promise<boolean> {
  const r = await query(
    `SELECT EXISTS (SELECT 1 FROM cost_allocations WHERE cost_id = $1 AND recharge_mode <> 'none') AS yes`,
    [costId],
  );
  return r.rows[0]?.yes === true;
}

/** Refusal when something tries to recharge the whole cost while its shares are recharged per job. */
export const PER_JOB_ALREADY =
  'This cost is recharged job by job. Resolve each job\'s share from that job\'s Money tab or the Recharges tab.';

/** Refusal when a share is recharged while the whole cost already is. */
export function wholeCostAlready(hhJobNumber: number | null | undefined): string {
  return `This cost is already recharged as a whole${hhJobNumber ? ` on job #${hhJobNumber}` : ''}. `
    + 'Resolve or clear that recharge before recharging each job\'s share.';
}
