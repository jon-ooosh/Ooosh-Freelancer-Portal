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
 * goes on at No VAT (HireHop 27 → Xero NONE: a fine passed on is outside the scope of
 * VAT); the handling fee and misc at 20%. Damage is never charged this way — it is
 * charged before the invoice or not at all.
 *
 * A charge invoice is left out of the "invoices add up to the job" sums
 * (`isChargeOnlyInvoice`). The client pays it through Record payment (the arrival hook
 * then allocates it); the payment portal reads it only once its own change lands.
 */
import { query } from '../config/database';
import { readBillingRows } from './hh-deposit-release';
import {
  PENNY, round2, gbp, Stop, Row, findInvoice, invoiceRows, invoiceStatus, invoiceNet, invoiceGross, invoiceItems,
  idOf, postDraftInvoice, postApproveInvoice, postCustomInvoiceLine, pushInvoiceToXero, readJobStatus,
} from './hh-invoice-close';
import { loadJob, withJobLock, reporter, log, planHireCloseOut, CloseOutResult } from './hire-close-out';
import { hhLocalNow } from './shop-stock';

/** Misc income (Xero 275) — HireHop's invoice nominal id. */
const MISC_INCOME_NOMINAL = 190;

export const CHARGE_TYPES = {
  misc:         { label: 'Misc income',       nominalId: MISC_INCOME_NOMINAL, rate: 20, taxId: 20 },
  pcn_fine:     { label: 'PCN fine (no VAT)', nominalId: MISC_INCOME_NOMINAL, rate: 0,  taxId: 27 },
  pcn_handling: { label: 'PCN handling fee',  nominalId: MISC_INCOME_NOMINAL, rate: 20, taxId: 20 },
} as const;
export type ChargeType = keyof typeof CHARGE_TYPES;

export interface ChargeLine { type: ChargeType; description: string; amount: number }

const HH_COMPLETED = 11;
const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

/** What a line comes to inc VAT, rounded per line as HireHop does. */
const lineGross = (l: ChargeLine) => round2(l.amount + round2(l.amount * CHARGE_TYPES[l.type].rate / 100));

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
  let rows = await readBillingRows(hhJobNumber);
  const drafts = invoiceRows(rows).filter((r) => invoiceStatus(r) === 0);
  if (drafts.length) {
    await rep.stop('charge', `Job ${hhJobNumber} already has a draft invoice in HireHop — approve or delete it there first.`);
  }

  // ── 1. An EMPTY draft ──
  const { res: draftRes } = await postDraftInvoice(hhJobNumber, `Job ${hhJobNumber}`, { all: 0 });
  rows = await readBillingRows(hhJobNumber);
  const fresh = invoiceRows(rows).filter((r) => invoiceStatus(r) === 0);
  if (fresh.length !== 1) {
    await rep.stop('charge', fresh.length === 0
      ? `HireHop did not create the draft (${draftRes?.error || 'no draft on the job afterwards'}) — it may not allow invoices on a Completed job for OP's HireHop user. Nothing was changed.`
      : `HireHop now shows ${fresh.length} drafts on job ${hhJobNumber}; expected one. Delete them in HireHop, then ${rep.retryHint}.`);
  }
  const draftId = idOf(fresh[0]);
  const deleteHint = `Delete draft ${draftId} in HireHop, then ${rep.retryHint}.`;
  if (invoiceItems(fresh[0]).length) {
    await rep.stop('charge', `HireHop put job lines on draft ${draftId} — a charge invoice must be empty to start. Nothing has gone to Xero. ${deleteHint}`);
  }
  await rep.log('charge', true, `Empty draft ${draftId} created for the charge.`);

  // ── 2. The custom lines, each read back ──
  let draft = findInvoice(rows, draftId);
  for (const l of lines) {
    const t = CHARGE_TYPES[l.type];
    const before = invoiceItems(draft);
    const after0 = before.length ? Number(before[before.length - 1].ID) : 0;
    const res = await postCustomInvoiceLine(hhJobNumber, draftId, {
      description: l.description, amount: l.amount, rate: t.rate, taxId: t.taxId, nominalId: t.nominalId, after: after0,
    });
    rows = await readBillingRows(hhJobNumber);
    draft = findInvoice(rows, draftId);
    const added = invoiceItems(draft).filter((x: Row) => !before.some((b: Row) => Number(b.ID) === Number(x.ID)));
    const ok = added.length === 1 && Math.abs(Number(added[0].PRICE) - l.amount) < PENNY
      && Number(added[0].ACC_TAX_RATE_ID) === t.taxId && Number(added[0].ACC_NOMINAL_ID) === t.nominalId;
    if (!ok) {
      await rep.stop('charge', `HireHop did not add "${l.description}" (${gbp(l.amount)}) as asked${res?.error ? ` (${res.error})` : ''}. Nothing has gone to Xero. ${deleteHint}`);
    }
  }

  // ── 3. Penny check: the draft is exactly the lines ──
  const wantNet = round2(lines.reduce((s, l) => s + l.amount, 0));
  const wantGross = round2(lines.reduce((s, l) => s + lineGross(l), 0));
  const net = invoiceNet(draft!) ?? 0;
  const gross = invoiceGross(draft!) ?? 0;
  if (Math.abs(net - wantNet) >= PENNY || Math.abs(gross - wantGross) >= PENNY) {
    await rep.stop('charge', `Draft ${draftId} comes to ${gbp(net)} ex VAT / ${gbp(gross)} inc VAT; the charges are ${gbp(wantNet)} / ${gbp(wantGross)}. Nothing has gone to Xero. ${deleteHint}`);
  }

  // ── 4. Approve, dated today, then Xero ──
  const approveRes = await postApproveInvoice(draftId, hhLocalNow());
  rows = await readBillingRows(hhJobNumber);
  const approved = findInvoice(rows, draftId);
  const number = String(approved?.data?.NUMBER || '');
  if (!approved || invoiceStatus(approved) < 2 || !number) {
    await rep.stop('charge', `HireHop did not approve draft ${draftId} (${approveRes?.error || 'still a draft on read-back'}). Nothing has gone to Xero — ${rep.retryHint}.`);
  }
  await pushInvoiceToXero(rep, {
    label: `completed-job charge — invoice ${number}`, hhJobNumber, invoiceId: draftId, number, gross,
    saved: { ...(approveRes?.data || {}), hh_task: approveRes?.data?.hh_task || 'post_invoice_credit', hh_id: approveRes?.data?.hh_id || draftId },
    alert: { jobId, what: `charge invoice ${number}` },
  });

  const what = lines.map((l) => `${CHARGE_TYPES[l.type].label}: ${l.description} ${gbp(l.amount)}`).join('; ');
  await log(jobId, userId, 'charge', true, `Charge invoice ${number} raised for ${gbp(gross)} — ${what}. Reason: ${reason}`,
    { invoiceId: draftId, number, gross });
  await query(
    `INSERT INTO interactions (job_id, type, content, created_by, source) VALUES ($1, 'note', $2, $3, 'system')`,
    [jobId, `🧾 Charge invoice ${number} raised after completion: ${gbp(gross)} inc VAT (${what}). Reason: ${reason}`, userId || SYSTEM_USER_ID],
  ).catch((e) => console.warn('[completed-charges] timeline note failed:', e));
  return `Charge invoice ${number} raised for ${gbp(gross)} and sent to Xero.`;
}
