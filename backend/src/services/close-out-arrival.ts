/**
 * close-out-arrival.ts — the hire close-out's arrival hook
 * (docs/HIRE-CLOSE-OUT-SPEC.md §4.5, Phase 3b).
 *
 * When a HIRE payment lands on a job that already has exactly one approved
 * invoice still owing, allocate that payment to it in HireHop and apply the
 * credit in Xero — the same `runHireAllocation()` the Invoice card's button
 * runs, with `user_id` NULL. The typical case: the main invoice is settled,
 * a damage recharge is invoiced, and the client pays it through the portal.
 *
 * What it never does:
 *   - touch an excess payment (callers pass hire payments only, and the plan
 *     never allocates excess anyway);
 *   - use any OTHER payment's money: if the plan would allocate from a payment
 *     other than the one that just arrived (money left unallocated on purpose —
 *     to refund, or held on account) it stops and leaves it for a person
 *     (jon, 10 Oct: a client who wanted their credit used wouldn't send more);
 *   - complete the job — that is the status change at the top of Job Detail;
 *   - fail or slow the payment: it runs after the caller has answered, and
 *     every error is logged and swallowed.
 *
 * Silent on the common case: most hire payments arrive before there is any
 * invoice, and those write nothing to the log. Off until
 * `system_settings.closeout_arrival_hook_enabled` is 'true' (migration 283).
 */
import { query } from '../config/database';
import { PENNY, gbp } from './hh-invoice-close';
import { planHireCloseOut, runHireAllocation, log } from './hire-close-out';

export const ARRIVAL_SETTING_KEY = 'closeout_arrival_hook_enabled';

export type ArrivalOutcome = 'off' | 'skipped' | 'allocated' | 'stopped';

export async function isArrivalHookEnabled(): Promise<boolean> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [ARRIVAL_SETTING_KEY]);
  return String(r.rows[0]?.value ?? 'false').trim().toLowerCase() === 'true';
}

/** One hire payment, just recorded with HireHop deposit `depositId`. Awaitable for tests; callers use fireArrivalHook. */
export async function allocateOnArrival(jobId: string, depositId: number): Promise<ArrivalOutcome> {
  if (!(await isArrivalHookEnabled())) return 'off';
  const plan = await planHireCloseOut(jobId, { fresh: true });
  const open = plan.invoices.filter((i) => i.owing >= PENNY);
  // Not this hook's shape (no invoice yet — the usual case — or several owing): say nothing.
  if (open.length !== 1) return 'skipped';
  // Excess, or already allocated by someone else: nothing for this payment to do.
  const payment = plan.payments.find((p) => p.depositId === depositId);
  if (!payment) return 'skipped';

  await log(plan.jobId, null, 'arrival', true,
    `Payment ${depositId} (${gbp(payment.available)}) arrived while ${open[0].number} shows ${gbp(open[0].owing)} owing — allocating it automatically.`,
    { depositId, invoiceId: open[0].invoiceId });
  const result = await runHireAllocation(plan.jobId, null, {
    onlyFromDeposit: depositId,
    retryHint: 'press the button on the Invoice card',
  });
  return result.done ? 'allocated' : 'stopped';
}

/**
 * Fire-and-forget: runs after the caller's own work, never throws, never
 * delays the payment. Call only for a hire (deposit/balance) payment that has
 * a HireHop deposit id.
 */
export function fireArrivalHook(jobId: string, depositId: number | null | undefined): void {
  if (!jobId || !depositId) return;
  setImmediate(() => {
    allocateOnArrival(jobId, Number(depositId)).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[close-out arrival] job ${jobId}, payment ${depositId}:`, err);
      await log(jobId, null, 'arrival', false,
        `Payment ${depositId} arrived but could not be allocated automatically (${msg}) — press the button on the Invoice card.`)
        .catch(() => undefined);
    });
  });
}
