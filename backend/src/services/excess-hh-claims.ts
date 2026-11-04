/**
 * Excess applied to an invoice IN HIREHOP → recorded as a claim in OP.
 *
 * The claim twin of the passive refund unwind (routes/money.ts Pass 2,
 * services/excess-refund.ts). When someone applies an excess deposit to an
 * invoice directly in HireHop — damage taken from the excess — OP's Payment
 * History shows it (it reads HireHop's billing), but the job_excess record
 * stayed "Taken", so v_excess_held, the Money overview, the excess ledger and
 * the cash forecast all went on counting money that had been kept. Job 16325
 * (Nov 2026): £1,200 applied to OT-INV-12254 in HireHop on 28 Sep, still "held"
 * in OP five weeks later.
 *
 * Runs from the Money tab summary (and so nightly, through the job-financials
 * backfill that drives the same route). OP ONLY: HireHop already holds the
 * application, so nothing is posted back, and no client email is sent — the
 * client was told when it happened, and a catch-up must never email about a
 * claim weeks old.
 *
 * Idempotent by construction: HireHop's total applied from the deposit is the
 * TARGET claim, never an increment. OP's own Claim button posts its application
 * to HireHop too, so those claims are already inside the target and are never
 * counted twice. The UPDATE only writes while OP is still behind, so two
 * Money-tab loads at once can't both add.
 */
import { query } from '../config/database';
import { ukToday } from './uk-date';

export interface HhExcessApplication {
  appId: number;        // HireHop's payment-application id (kind=3 data.ID)
  depositId: number;    // the excess deposit it was applied from (OWNER_DEPOSIT)
  invoiceId: number;    // the invoice it was applied to (OWNER)
  amount: number;       // positive £
  date: string;         // as HireHop gives it
  crossJob: boolean;    // applied to ANOTHER job's invoice
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The claim OP should show, given what HireHop has applied from the deposit.
 * Never more than the deposit has left after refunds; null when OP is already
 * level (or ahead — never lower a claim someone recorded).
 */
export function planClaimCatchUp(
  rec: { taken: number; claimed: number; reimbursed: number },
  hhApplied: number,
): { newClaim: number; gap: number; capped: boolean } | null {
  const ceiling = Math.max(0, rec.taken - rec.reimbursed);
  const target = round2(Math.min(hhApplied, ceiling));
  if (target <= rec.claimed + 0.005) return null;
  return { newClaim: target, gap: round2(target - rec.claimed), capped: hhApplied > ceiling + 0.005 };
}

/** The applications grouped by the deposit they came from. */
export function totalsByDeposit(apps: HhExcessApplication[]): Map<number, { total: number; apps: HhExcessApplication[] }> {
  const out = new Map<number, { total: number; apps: HhExcessApplication[] }>();
  const seen = new Set<number>();
  for (const a of apps) {
    if (!(a.depositId > 0) || !(a.amount > 0)) continue;
    if (a.appId > 0) {
      if (seen.has(a.appId)) continue;   // HireHop publishes each application twice
      seen.add(a.appId);
    }
    const g = out.get(a.depositId) || { total: 0, apps: [] };
    g.total = round2(g.total + a.amount);
    g.apps.push(a);
    out.set(a.depositId, g);
  }
  return out;
}

/** Bring each linked excess record's claim up to what HireHop has applied. Returns how many changed. */
export async function catchUpHireHopExcessClaims(jobId: string, apps: HhExcessApplication[]): Promise<number> {
  const groups = totalsByDeposit(apps);
  if (groups.size === 0) return 0;

  const recs = await query(
    `SELECT id, hh_deposit_id, excess_status, excess_amount_taken, claim_amount, reimbursement_amount, claim_notes
     FROM job_excess
     WHERE job_id = $1
       AND hh_deposit_id = ANY($2::int[])
       AND excess_status NOT IN ('waived', 'rolled_over', 'released', 'reimbursed', 'not_required')`,
    [jobId, [...groups.keys()]],
  );

  // One OP record per HireHop deposit, or we can't tell whose claim it is.
  const byDeposit = new Map<number, Array<Record<string, unknown>>>();
  for (const r of recs.rows as Array<Record<string, unknown>>) {
    const d = Number(r.hh_deposit_id);
    byDeposit.set(d, [...(byDeposit.get(d) || []), r]);
  }

  let changed = 0;
  for (const [depositId, group] of groups) {
    const list = byDeposit.get(depositId) || [];
    if (list.length !== 1) {
      if (list.length > 1) console.warn(`[excess-hh-claims] job ${jobId}: ${list.length} OP records share HireHop deposit ${depositId} — not guessing which was claimed`);
      continue;
    }
    const rec = list[0];
    const taken = Number(rec.excess_amount_taken) || 0;
    const claimed = Number(rec.claim_amount) || 0;
    const reimbursed = Number(rec.reimbursement_amount) || 0;
    const plan = planClaimCatchUp({ taken, claimed, reimbursed }, group.total);
    if (!plan) continue;
    if (plan.capped) console.warn(`[excess-hh-claims] job ${jobId}: HireHop applied £${group.total.toFixed(2)} from deposit ${depositId}, more than OP's £${(taken - reimbursed).toFixed(2)} left — recorded up to that`);

    const fullyConsumed = plan.newClaim + reimbursed >= taken - 0.005;
    const newStatus = fullyConsumed && reimbursed < 0.005 ? 'fully_claimed' : String(rec.excess_status);
    const latest = [...group.apps].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
    const appliedOn = /^\d{4}-\d{2}-\d{2}/.test(String(latest?.date || '')) ? String(latest.date).slice(0, 10) : null;
    const where = group.apps.some((a) => a.crossJob) ? "an invoice (incl. another job's)" : 'the invoice';
    const noteEntry = `[${ukToday()}] £${plan.gap.toFixed(2)} applied to ${where} in HireHop${appliedOn ? ` on ${appliedOn}` : ''} `
      + `(HireHop row${group.apps.length === 1 ? '' : 's'} ${group.apps.map((a) => a.appId).join(', ')}) — recorded by OP from HireHop`;
    const newNotes = rec.claim_notes ? `${rec.claim_notes}\n${noteEntry}` : noteEntry;

    const r = await query(
      `UPDATE job_excess SET
         claim_amount = $2::numeric,
         excess_status = $3,
         claim_date = COALESCE($4::date::timestamptz, NOW()),
         claim_notes = $5,
         updated_at = NOW()
       WHERE id = $1 AND COALESCE(claim_amount, 0) < $2::numeric - 0.005
       RETURNING id`,
      [rec.id, plan.newClaim, newStatus, appliedOn, newNotes],
    );
    if (r.rows.length) {
      changed++;
      console.log(`[excess-hh-claims] job ${jobId}: recorded £${plan.gap.toFixed(2)} claim from HireHop deposit ${depositId} on excess ${rec.id}`);
    }
  }
  return changed;
}
