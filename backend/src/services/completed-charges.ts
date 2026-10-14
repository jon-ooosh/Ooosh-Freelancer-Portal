/**
 * completed-charges.ts — a charge after a hire is COMPLETED (HIRE-CLOSE-OUT-SPEC.md §4.6).
 *
 * Before completion, extra costs go on the HireHop job as usual and land on the final
 * invoice. Once a job is Completed HireHop takes no new job lines, so a later charge
 * (a PCN, a misc cost) is raised as its OWN small invoice built only from custom lines:
 * an empty draft (`billing_save.php` `all: 0`), one custom line per charge
 * (`billing_save_item.php` `id: 0`, `kind: 3` — no job item, no stock touched),
 * approve dated today, push to Xero. Every step read back; any doubt stops at the draft,
 * which never reaches Xero.
 *
 * jon, 13 Oct 2026: managers only; two kinds for now — Misc income (with a reason) and
 * the PCN fine / handling fee (the PCN module calls this for a Completed job). The fine
 * goes on zero-rated (HireHop 33 → Xero ZERORATEDOUTPUT — jon, 14 Oct 2026; first built
 * as No VAT, code 27); the handling fee and misc at 20%. Damage is never charged this way — it is
 * charged before the invoice or not at all.
 *
 * A charge invoice is left out of the "invoices add up to the job" sums
 * (`isChargeOnlyInvoice`). The client pays it on the payment portal (which reads a Completed
 * job's balance from its invoices) or staff use Record payment; the arrival hook allocates it.
 */
import { query } from '../config/database';
import { PENNY, round2, gbp, Stop, readJobStatus, raiseCustomLineInvoice, MISC_INCOME_NOMINAL } from './hh-invoice-close';
import { loadJob, withJobLock, reporter, log, planHireCloseOut, CloseOutResult } from './hire-close-out';

export const CHARGE_TYPES = {
  misc:         { label: 'Misc income',       nominalId: MISC_INCOME_NOMINAL, rate: 20, taxId: 20 },
  pcn_fine:     { label: 'PCN fine (zero-rated)', nominalId: MISC_INCOME_NOMINAL, rate: 0,  taxId: 33 },
  pcn_handling: { label: 'PCN handling fee',  nominalId: MISC_INCOME_NOMINAL, rate: 20, taxId: 20 },
} as const;
export type ChargeType = keyof typeof CHARGE_TYPES;

export interface ChargeLine { type: ChargeType; description: string; amount: number }

const HH_COMPLETED = 11;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Raise one charge invoice on a Completed job. `reason` is internal (log + timeline);
 * each line's `description` is what the client reads on the invoice.
 */
export async function raiseChargeInvoice(jobIdOrNumber: string, userId: string | null,
  input: { lines: ChargeLine[]; reason: string }): Promise<CloseOutResult> {
  const job = await loadJob(jobIdOrNumber);
  return withJobLock(job.id, async () => {
    const rep = reporter(job.id, userId, 'try again');
    let done = false;
    let message: string;
    try {
      message = await chargeSteps(job.id, Number(job.hh_job_number), job.pipeline_status, rep, input, userId);
      done = true;
    } catch (err) {
      if (!(err instanceof Stop)) {
        await log(job.id, userId, 'error', false, err instanceof Error ? err.message : String(err)).catch(() => undefined);
      }
      message = err instanceof Error ? err.message : String(err);
    }
    return { done, message, plan: await planHireCloseOut(job.id, { fresh: true }) };
  });
}

async function chargeSteps(jobId: string, hhJobNumber: number, pipelineStatus: string | null,
  rep: ReturnType<typeof reporter>, input: { lines: ChargeLine[]; reason: string }, userId: string | null): Promise<string> {
  const reason = String(input.reason || '').trim();
  const lines = (input.lines || []).map((l) => ({ ...l, description: String(l.description || '').trim(), amount: round2(Number(l.amount)) }));

  // ── Pre-flight ──
  if (!hhJobNumber) await rep.stop('charge', 'This job has no HireHop job number.');
  if (!reason) await rep.stop('charge', 'Say why the charge is being made.');
  if (!lines.length || lines.length > 5) await rep.stop('charge', 'A charge invoice needs between one and five lines.');
  for (const l of lines) {
    if (!(l.type in CHARGE_TYPES)) await rep.stop('charge', `Unknown charge type "${l.type}".`);
    if (!l.description) await rep.stop('charge', 'Every line needs a description — it is what the client reads on the invoice.');
    if (!(l.amount >= PENNY) || l.amount > 10000) await rep.stop('charge', `"${l.description}" needs an amount between £0.01 and £10,000.`);
  }
  if (pipelineStatus !== 'completed') {
    await rep.stop('charge', 'This job isn\'t Completed — until it is, add the cost to the HireHop job and it goes on the final invoice.');
  }
  const hhStatus = await readJobStatus(hhJobNumber);
  if (hhStatus !== HH_COMPLETED) {
    await rep.stop('charge', `HireHop doesn't show job ${hhJobNumber} as Completed (status ${hhStatus ?? 'unknown'}) — check it there first.`);
  }
  // ── Empty draft → the lines → penny check → approve → Xero (the shared recipe) ──
  const { invoiceId, number, gross } = await raiseCustomLineInvoice(rep, {
    hhJobNumber, step: 'charge',
    lines: lines.map((l) => {
      const t = CHARGE_TYPES[l.type];
      return { description: l.description, amount: l.amount, rate: t.rate, taxId: t.taxId, nominalId: t.nominalId };
    }),
    xeroLabel: 'completed-job charge', alert: { jobId, what: 'charge invoice' },
  });

  const what = lines.map((l) => `${CHARGE_TYPES[l.type].label}: ${l.description} ${gbp(l.amount)}`).join('; ');
  await log(jobId, userId, 'charge', true, `Charge invoice ${number} raised for ${gbp(gross)} — ${what}. Reason: ${reason}`,
    { invoiceId, number, gross });
  await query(
    `INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`,
    [jobId, `🧾 Charge invoice ${number} raised after completion: ${gbp(gross)} inc VAT (${what}). Reason: ${reason}`, userId || SYSTEM_USER_ID],
  ).catch((e) => console.warn('[completed-charges] timeline note failed:', e));
  return `Charge invoice ${number} raised for ${gbp(gross)} and sent to Xero.`;
}
