/**
 * close-out-xero-sweep.ts — the nightly Xero credit sweep
 * (docs/HIRE-CLOSE-OUT-SPEC.md §4.3 step 2, Phase 3a).
 *
 * HireHop never pushes a payment allocation to Xero: every OP-pushed deposit
 * sits there as an unapplied overpayment and every invoice as "Awaiting
 * payment" until someone presses "Apply credit" by hand (checked 9 Oct 2026).
 * This applies, in Xero, exactly what HireHop's own allocations say, for each
 * recently returned or completed hire — the shared `applyCreditsInXero`, the
 * same step the close-out button runs, which is idempotent and judged only
 * by Xero's AmountDue.
 *
 * Safe to be automatic because it writes nothing to HireHop, applies only what
 * is not already applied, and skips any job whose figures do not match (logged
 * to job_closeout_log with user_id NULL). Switched on by the system setting
 * `closeout_xero_sweep_enabled` (migration 282) — off until jon flips it.
 *
 * A job that swept clean is left alone for a week unless a payment lands on it.
 */
import { query } from '../config/database';
import { readBillingRows } from './hh-deposit-release';
import { Stop, PENNY, invoiceAllocations, applyCreditsInXero } from './hh-invoice-close';
import { approvedInvoices, sourceJobRows, reporter, log } from './hire-close-out';
import { isXeroConfigured } from '../config/xero';

export const SWEEP_SETTING_KEY = 'closeout_xero_sweep_enabled';
const LOOKBACK_DAYS = 120;
const QUIET_DAYS = 7;

export interface SweepResult {
  enabled: boolean;
  checked: number;
  applied: number;      // jobs where at least one credit was applied
  stopped: number;      // jobs that stopped on a mismatch (logged)
  errors: number;
}

export async function isSweepEnabled(): Promise<boolean> {
  const r = await query(`SELECT value FROM system_settings WHERE key = $1`, [SWEEP_SETTING_KEY]);
  return String(r.rows[0]?.value ?? 'false').trim().toLowerCase() === 'true';
}

/** Jobs worth looking at tonight. */
async function candidates(): Promise<Array<{ id: string; hh_job_number: number }>> {
  const r = await query(
    `SELECT j.id, j.hh_job_number
       FROM jobs j
      WHERE j.is_deleted = false
        AND COALESCE(j.is_internal, false) = false
        AND j.hh_job_number IS NOT NULL
        AND j.pipeline_status IN ('returned', 'returned_incomplete', 'completed')
        AND COALESCE(j.return_date, j.job_end, j.job_date) >= NOW() - ($1 || ' days')::interval
        AND NOT EXISTS (
          -- swept clean recently, and no payment has landed since
          SELECT 1 FROM job_closeout_log l
           WHERE l.job_id = j.id AND l.step = 'sweep' AND l.ok = true
             AND l.created_at >= NOW() - ($2 || ' days')::interval
             AND NOT EXISTS (SELECT 1 FROM job_payments p WHERE p.job_id = j.id AND p.created_at > l.created_at)
        )
      ORDER BY COALESCE(j.return_date, j.job_end, j.job_date) DESC`,
    [String(LOOKBACK_DAYS), String(QUIET_DAYS)],
  );
  return r.rows;
}

/** One job: every approved invoice with HireHop allocations, applied in Xero as far as HireHop says. */
export async function sweepJob(jobId: string, hhJobNumber: number): Promise<'applied' | 'clean' | 'stopped'> {
  const rep = reporter(jobId, null, 'open the job and press the button');
  const rows = await readBillingRows(hhJobNumber);
  let touched = false;
  for (const inv of approvedInvoices(rows)) {
    if (!inv.inXero || !invoiceAllocations(rows, inv.invoiceId).length) continue;
    const extraRows = await sourceJobRows(rows, inv.invoiceId);
    const before = rep.log;
    let appliedHere = false;
    // Count a job as "applied" when the shared step logged an application line.
    rep.log = async (step, ok, detail) => { if (step === 'xero' && /credit applied/.test(detail)) appliedHere = true; return before(step, ok, detail); };
    try {
      await applyCreditsInXero(rep, rows, inv.invoiceId, inv.number, { extraRows, expectedDue: inv.owing >= PENNY ? inv.owing : 0 });
    } catch (err) {
      if (err instanceof Stop) return 'stopped';   // already logged by the reporter
      throw err;
    }
    touched = touched || appliedHere;
  }
  await log(jobId, null, 'sweep', true, touched ? 'Nightly sweep: credits applied in Xero to match HireHop.' : 'Nightly sweep: Xero already matches HireHop.');
  return touched ? 'applied' : 'clean';
}

export async function runCloseOutXeroSweep(): Promise<SweepResult> {
  const result: SweepResult = { enabled: false, checked: 0, applied: 0, stopped: 0, errors: 0 };
  if (!(await isSweepEnabled())) return result;
  result.enabled = true;
  if (!isXeroConfigured()) { console.warn('[close-out sweep] Xero is not configured on this server — nothing to do.'); return result; }
  for (const job of await candidates()) {
    result.checked++;
    try {
      const outcome = await sweepJob(job.id, Number(job.hh_job_number));
      if (outcome === 'applied') result.applied++;
      if (outcome === 'stopped') result.stopped++;
    } catch (err) {
      result.errors++;
      await log(job.id, null, 'error', false, `Nightly sweep: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
  return result;
}
