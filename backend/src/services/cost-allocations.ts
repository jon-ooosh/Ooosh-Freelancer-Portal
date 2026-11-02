/**
 * A cost's job split (`cost_allocations`): what share of the invoice each job
 * carries, and, per share, who pays for it (migration 318).
 *
 * Two steps, the same shape as freelancer-work.ts's planWorkLinks / writeWorkLinks:
 *   - planAllocations() checks the whole split against the cost as it WILL be,
 *     BEFORE anything is written, so a refusal can't leave a half-saved cost;
 *   - writeAllocations() writes it in one transaction on one client.
 *
 * Used by PUT /costs/:id/allocations and by the create / update routes, which
 * take `allocations` in the same request as the cost itself (the capture form
 * saves the job split with the cost, not as a second step).
 *
 * A share sent with its `id` is KEPT and updated rather than deleted and re-made,
 * so what it carries (its own recharge to that job) survives an edit to the
 * split. A share whose recharge is DONE (billed on HireHop, billed another way,
 * or absorbed) records something that happened: it can't be taken out of the
 * split or moved to another job, and its recharge can't be changed here.
 */
import { query, getClient } from '../config/database';
import { TERMINAL_RECHARGE, wholeCostAlready } from './cost-recharges';

export class AllocationError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface AllocationInput {
  id?: string;
  job_id?: string | null;
  quote_assignment_id?: string | null;
  amount: number;
  recharge?: boolean;
  notes?: string | null;
  cost_intent?: 'quote_actual' | 'extra' | null;
  recharge_mode?: 'none' | 'full' | 'partial';
  recharge_amount?: number | null;
}

/** The cost as it WILL be once this save lands (new values over the old). */
export interface CostForSplit {
  amount_gross: number | string | null;
  cost_intent: string | null;
  recharge_mode: string | null;
  is_credit: boolean | null;
  /** The cost's own job's HireHop number, for the "recharged as a whole" refusal. */
  hh_job_number?: number | null;
}

interface PlannedShare {
  id: string | null; jobId: string | null; quoteAssignmentId: string | null; amount: number;
  recharge: boolean; notes: string | null;
  costIntent: string | null; rechargeMode: string; rechargeAmount: number | null; rechargeStatus: string | null;
}

export interface AllocationPlan {
  shares: PlannedShare[];
  /** The shares as they were, for the audit and the close-out cards. */
  before: Array<Record<string, any>>;
}

const samePence = (a: unknown, b: unknown) => Math.round((Number(a) || 0) * 100) === Math.round((Number(b) || 0) * 100);

/**
 * Check a whole split. `costId` is null for a cost not yet created (no shares
 * exist yet). Throws AllocationError with the status and the staff-readable reason.
 */
export async function planAllocations(
  costId: string | null, cost: CostForSplit, allocations: AllocationInput[],
): Promise<AllocationPlan> {
  // Attribution is OP-only and OPTIONAL — it may leave a remainder unallocated
  // ("our cost"), so allocations summing to LESS than the cost total is fine.
  // Only OVER-allocation is rejected: you can't attribute more than the cost.
  const gross = Number(cost.amount_gross ?? 0);
  const allocated = allocations.reduce((s, a) => s + Number(a.amount || 0), 0);
  if (allocated > gross + 0.01) {
    throw new AllocationError(400,
      `Allocated £${allocated.toFixed(2)} exceeds the cost total £${gross.toFixed(2)}. Reduce the split — you can't attribute more than the cost.`);
  }
  if (allocations.some((a) => !(Number(a.amount) > 0))) {
    throw new AllocationError(400, 'Every line needs an amount greater than zero.');
  }

  const cur = costId
    ? (await query(
        `SELECT a.id, a.job_id, a.quote_assignment_id, a.notes,
                a.cost_intent, a.recharge_mode, a.recharge_amount, a.recharge_status, j.hh_job_number
           FROM cost_allocations a LEFT JOIN jobs j ON j.id = a.job_id
          WHERE a.cost_id = $1`,
        [costId],
      )).rows
    : [];
  const byId = new Map(cur.map((r) => [r.id as string, r]));
  const onJob = (r: { hh_job_number?: number | null }) => (r.hh_job_number ? `job #${r.hh_job_number}` : 'its job');
  const isDone = (r: { recharge_status?: string | null }) => TERMINAL_RECHARGE.has(String(r.recharge_status));

  // Every id sent must be one of this cost's shares, and only once.
  const kept = new Set<string>();
  for (const a of allocations) {
    if (!a.id) continue;
    if (!byId.has(a.id) || kept.has(a.id)) {
      throw new AllocationError(400, 'The split changed while you were editing it. Close it, open it again and re-check.');
    }
    kept.add(a.id);
  }
  // A share whose recharge is done stays in the split.
  for (const r of cur) {
    if (!kept.has(r.id) && isDone(r)) {
      throw new AllocationError(409, `The share on ${onJob(r)} has already been recharged to the client, so it can't be taken out of the split.`);
    }
  }

  const shares: PlannedShare[] = [];
  for (const a of allocations) {
    const prev = a.id ? byId.get(a.id) : undefined;
    const jobId = a.job_id ?? null;
    // A kept share keeps what the sender didn't mention (the capture form sends
    // no notes; the old split modal let people type them per share).
    const base = {
      id: prev ? (prev.id as string) : null, jobId,
      quoteAssignmentId: a.quote_assignment_id !== undefined ? (a.quote_assignment_id ?? null) : (prev?.quote_assignment_id ?? null),
      amount: a.amount, recharge: a.recharge ?? false,
      notes: a.notes !== undefined ? (a.notes ?? null) : (prev?.notes ?? null),
    };

    if (prev && isDone(prev)) {
      if (jobId !== (prev.job_id ?? null)) {
        throw new AllocationError(409, `The share on ${onJob(prev)} has already been recharged to the client, so it can't move to another job.`);
      }
      const changed = (a.recharge_mode !== undefined && a.recharge_mode !== prev.recharge_mode)
        || (a.recharge_amount !== undefined && !samePence(a.recharge_amount, prev.recharge_amount))
        || (a.cost_intent !== undefined && (a.cost_intent ?? null) !== (prev.cost_intent ?? null));
      if (changed) {
        throw new AllocationError(409, `The share on ${onJob(prev)} has already been recharged to the client, so its recharge can't be changed here.`);
      }
      // Its answer is pinned: it was recharged, so it was an extra. Left to
      // inherit, a later "part of the quote" on the cost would contradict it.
      shares.push({
        ...base, costIntent: prev.cost_intent ?? 'extra', rechargeMode: prev.recharge_mode,
        rechargeAmount: prev.recharge_amount == null ? null : Number(prev.recharge_amount), rechargeStatus: prev.recharge_status,
      });
      continue;
    }

    const costIntent = a.cost_intent !== undefined ? (a.cost_intent ?? null) : (prev?.cost_intent ?? null);
    let rechargeMode: string = a.recharge_mode ?? prev?.recharge_mode ?? 'none';
    // Part of the quote (this share's answer, or the cost's when it has none):
    // already billed through the quote, so never recharged too.
    if ((costIntent ?? cost.cost_intent) === 'quote_actual') rechargeMode = 'none';
    const modeChanged = !prev || rechargeMode !== prev.recharge_mode;
    let rechargeAmount: number | null = a.recharge_amount !== undefined
      ? (a.recharge_amount ?? null)
      : (modeChanged ? null : (prev?.recharge_amount == null ? null : Number(prev.recharge_amount)));

    if (rechargeMode !== 'none') {
      if (cost.is_credit) throw new AllocationError(400, 'A refund is never recharged to a client.');
      if (!jobId) throw new AllocationError(400, 'A share can only be recharged when it is on a job.');
      if ((cost.recharge_mode ?? 'none') !== 'none') throw new AllocationError(400, wholeCostAlready(cost.hh_job_number));
      if (rechargeMode === 'partial' && !(Number(rechargeAmount) > 0)) {
        throw new AllocationError(400, 'Say how much of this job\'s share to recharge (£, before VAT).');
      }
    } else {
      rechargeAmount = null;
    }
    shares.push({
      ...base, costIntent, rechargeMode, rechargeAmount,
      // Not done (a done share returned above), so flagged means waiting.
      rechargeStatus: rechargeMode === 'none' ? null : 'pending',
    });
  }
  return { shares, before: cur };
}

/**
 * Write a planned split. One client for the lot, so it IS a transaction
 * (SECURITY-AUDIT-BRIEF B.5). Records a change to any share's recharge in the
 * audit log and refreshes the close-out card on every job a recharge touched.
 */
export async function writeAllocations(costId: string, plan: AllocationPlan, userId: string | null): Promise<void> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const keepIds = plan.shares.filter((p) => p.id).map((p) => p.id as string);
    await client.query(
      'DELETE FROM cost_allocations WHERE cost_id = $1 AND NOT (id = ANY($2::uuid[]))',
      [costId, keepIds],
    );
    for (const p of plan.shares) {
      const vals = [p.jobId, p.quoteAssignmentId, p.amount, p.recharge, p.notes,
        p.costIntent, p.rechargeMode, p.rechargeAmount, p.rechargeStatus];
      if (p.id) {
        await client.query(
          `UPDATE cost_allocations
              SET job_id = $1, quote_assignment_id = $2, amount = $3, recharge = $4, notes = $5,
                  cost_intent = $6, recharge_mode = $7, recharge_amount = $8, recharge_status = $9
            WHERE id = $10 AND cost_id = $11`,
          [...vals, p.id, costId],
        );
      } else {
        await client.query(
          `INSERT INTO cost_allocations
             (job_id, quote_assignment_id, amount, recharge, notes,
              cost_intent, recharge_mode, recharge_amount, recharge_status, cost_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [...vals, costId],
        );
      }
    }
    await client.query('COMMIT');
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => { /* the connection is going back anyway */ });
    throw txErr;
  } finally {
    client.release();
  }

  // A recharge flagged or cleared on a share is a recharge decision: on the record.
  const summary = (rows: Array<Record<string, any>>) =>
    rows.filter((r) => (r.recharge_mode ?? r.rechargeMode) !== 'none')
      .map((r) => ({ job_id: r.job_id ?? r.jobId, mode: r.recharge_mode ?? r.rechargeMode, amount: r.recharge_amount ?? r.rechargeAmount }));
  const before = summary(plan.before);
  const after = summary(plan.shares as unknown as Array<Record<string, any>>);
  if (userId && JSON.stringify(before) !== JSON.stringify(after)) {
    try {
      await query(
        `INSERT INTO audit_log (user_id, entity_type, entity_id, action, previous_values, new_values)
         VALUES ($1, 'cost', $2, 'allocation_recharges', $3, $4)`,
        [userId, costId, JSON.stringify({ shares: before }), JSON.stringify({ shares: after })],
      );
    } catch (err) {
      console.warn('[cost-allocations] audit log failed (non-fatal):', (err as Error).message);
    }
  }
  // Each job's close-out card, for every job a share's recharge billed or now bills.
  const jobs = new Set<string>([
    ...plan.before.filter((r) => r.recharge_mode !== 'none' && r.job_id).map((r) => r.job_id as string),
    ...plan.shares.filter((p) => p.rechargeMode !== 'none' && p.jobId).map((p) => p.jobId as string),
  ]);
  if (jobs.size) {
    const { syncCostResolveRequirementStatus } = await import('./cost-requirement-sync');
    for (const j of jobs) await syncCostResolveRequirementStatus(j).catch(() => { /* non-fatal */ });
  }
}
