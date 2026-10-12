/**
 * eu-vat-split.ts — the EU invoice VAT split (docs/HIRE-CLOSE-OUT-SPEC.md §10.1).
 *
 * A hire carrying the "Non-standard VAT rules" item (quantity = the non-UK
 * days) is charged VAT only on its UK share (HMRC 741A) — the figure the
 * payment portal already showed the client (`vat-adjustment.ts`). This puts
 * that on the DRAFT invoice the way staff have done it by hand (job 15812,
 * jon's choice, 12 Oct 2026):
 *
 *   - Equipment, and vehicles on a hire under 31 days: each real line goes to
 *     100% discount, and per NOMINAL two custom lines carry its money —
 *     "<nominal>, UK days (2 of 28)" at 20% and "<nominal>, non-UK days,
 *     zero-rated (HMRC 741A) (26 of 28)" at tax code 33. The nominal is kept,
 *     so Xero's revenue accounts are unchanged; VAT is rounded once per
 *     nominal, as the portal works it out.
 *   - Vehicles on a hire of 31+ days: the lines move to tax code 33, price
 *     untouched.
 *   - Delivery, crew, storage, rehearsals ("always 20%"): untouched.
 *
 * The job's own lines are never touched — only the invoice's copies.
 * Order: add the custom lines, THEN zero the real ones, so any half-done
 * draft shows the wrong net and the penny check stops it on the next press.
 * Every write is read back. A draft never reaches Xero, and the caller stops
 * at the draft after a split so a person looks at it before approving.
 */
import { query } from '../config/database';
import { readBillingRows } from './hh-deposit-release';
import {
  Row, PENNY, round2, gbp, CloseReporter, findInvoice, invoiceNet, invoiceGross, invoiceItems,
  postZeroInvoiceLine, postInvoiceLineTax, postCustomInvoiceLine,
} from './hh-invoice-close';
import {
  VatClass, readSupplyItems, nonUkDaysOf, classifyNominals, hireDaysBetween,
  VEHICLE_ZERO_RATE_MIN_DAYS, calculateVatAdjustment,
} from './vat-adjustment';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Zero Rated Income → Xero ZERORATEDOUTPUT (confirmed by jon, 10 Oct 2026). */
export const ZERO_RATED_TAX_ID = 33;
/** 20% (VAT on Income) → Xero OUTPUT2. */
export const UK_TAX_ID = 20;
/** How far the invoice may sit from the portal's figure (what the client was asked to pay). */
const PORTAL_TOLERANCE = 0.02;
/** Our own lines, by their wording. */
const SPLIT_LINE = /, (?:non-)?UK days\b.*\(\d+ of \d+\)$/;

export interface CustomLine { nominalId: number; description: string; amount: number; rate: number; taxId: number }

export interface EuSplitPlan {
  hireDays: number;
  ukDays: number;
  nonUkDays: number;
  /** Real lines that go to 100% discount (their money moves to the custom lines). */
  zero: Row[];
  /** Vehicle lines on a 31+ day hire: to tax code 33, price untouched. */
  zeroRate: Row[];
  custom: CustomLine[];
}

const num = (v: unknown) => Number(v) || 0;
const lineName = (l: Row) => String(l.DESCRIPTION || l.ITEM || `line ${l.ID}`);
export const isSplitLine = (l: Row) => num(l.KIND) === 3 && SPLIT_LINE.test(String(l.DESCRIPTION || ''));

/**
 * Pure: what the split would do to these invoice lines. `classOf` gives a
 * line's VAT treatment (null = OP can't tell — refuse). Returns a problem
 * sentence instead when it can't be done safely.
 */
export function planEuSplit(input: {
  lines: Row[];
  classOf: (line: Row) => VatClass | null;
  nominalName: (nominalId: number) => string;
  hireDays: number;
  nonUkDays: number;
}): { plan: EuSplitPlan } | { problem: string } {
  const { lines, classOf, nominalName, hireDays } = input;
  const nonUkDays = Math.min(input.nonUkDays, hireDays);
  const ukDays = Math.max(0, hireDays - nonUkDays);
  const plan: EuSplitPlan = { hireDays, ukDays, nonUkDays, zero: [], zeroRate: [], custom: [] };
  const groups = new Map<number, number>();
  for (const line of lines) {
    if (num(line.PRICE) < PENNY) continue;
    if (num(line.KIND) === 3) {
      return { problem: `The draft has a custom line ("${lineName(line)}") — OP can't tell which VAT rule it follows. Delete the draft in HireHop and raise it again, or raise this one by hand.` };
    }
    const cls = classOf(line);
    if (!cls) return { problem: `OP can't match the invoice line "${lineName(line)}" to the job's items, so it can't tell which VAT rule applies. Raise this invoice by hand.` };
    if (cls === 'always20') continue;
    if (cls === 'vehicle' && hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS) {
      if (num(line.ACC_TAX_RATE_ID) !== ZERO_RATED_TAX_ID) plan.zeroRate.push(line);
      continue;
    }
    plan.zero.push(line);
    const nominal = num(line.ACC_NOMINAL_ID);
    groups.set(nominal, round2((groups.get(nominal) ?? 0) + num(line.PRICE)));
  }
  for (const [nominalId, net] of groups) {
    const name = nominalName(nominalId);
    const uk = round2(net * ukDays / hireDays);
    const nonUk = round2(net - uk);
    if (uk >= PENNY) {
      plan.custom.push({ nominalId, description: `${name}, UK days (${ukDays} of ${hireDays})`, amount: uk, rate: 20, taxId: UK_TAX_ID });
    }
    if (nonUk >= PENNY) {
      plan.custom.push({ nominalId, description: `${name}, non-UK days, zero-rated (HMRC 741A) (${nonUkDays} of ${hireDays})`, amount: nonUk, rate: 0, taxId: ZERO_RATED_TAX_ID });
    }
  }
  return { plan };
}

/**
 * Pure: does this draft look split? Every real line in a split class at £0,
 * every 31+ day vehicle line at code 33, and each split nominal's two lines on
 * the right tax codes with the UK share where it should be. Returns the
 * problems found (empty = fine).
 */
export function checkSplitDraft(input: {
  lines: Row[]; classOf: (line: Row) => VatClass | null; hireDays: number; nonUkDays: number;
}): string[] {
  const { lines, classOf, hireDays } = input;
  const nonUkDays = Math.min(input.nonUkDays, hireDays);
  const ukDays = Math.max(0, hireDays - nonUkDays);
  const problems: string[] = [];
  const byNominal = new Map<number, { uk: number; nonUk: number }>();
  for (const line of lines) {
    const price = num(line.PRICE);
    if (isSplitLine(line)) {
      const g = byNominal.get(num(line.ACC_NOMINAL_ID)) ?? { uk: 0, nonUk: 0 };
      const isUk = !/non-UK days/.test(String(line.DESCRIPTION));
      const wantTax = isUk ? UK_TAX_ID : ZERO_RATED_TAX_ID;
      if (num(line.ACC_TAX_RATE_ID) !== wantTax) problems.push(`"${lineName(line)}" is on tax code ${line.ACC_TAX_RATE_ID}, not ${wantTax}.`);
      if (isUk) g.uk = round2(g.uk + price); else g.nonUk = round2(g.nonUk + price);
      byNominal.set(num(line.ACC_NOMINAL_ID), g);
      continue;
    }
    if (price < PENNY) continue;
    const cls = classOf(line);
    if (cls === 'always20') continue;
    if (cls === 'vehicle' && hireDays >= VEHICLE_ZERO_RATE_MIN_DAYS) {
      if (num(line.ACC_TAX_RATE_ID) !== ZERO_RATED_TAX_ID) problems.push(`"${lineName(line)}" should be zero-rated (31+ day vehicle hire) but is on tax code ${line.ACC_TAX_RATE_ID}.`);
      continue;
    }
    problems.push(`"${lineName(line)}" still carries ${gbp(price)} — it should be at 100% discount with its money on the UK / non-UK lines.`);
  }
  for (const [nominalId, g] of byNominal) {
    const wantUk = round2((g.uk + g.nonUk) * ukDays / hireDays);
    if (Math.abs(wantUk - g.uk) >= PENNY) problems.push(`The UK-days line for nominal ${nominalId} is ${gbp(g.uk)}; ${ukDays} of ${hireDays} days makes it ${gbp(wantUk)}.`);
  }
  return problems;
}

/** The hire's days, as the Money tab and the portal figure count them. */
async function hireDaysOf(jobId: string): Promise<number> {
  const r = await query(`SELECT job_date, job_end, out_date, return_date FROM jobs WHERE id = $1`, [jobId]);
  const j = r.rows[0] || {};
  return hireDaysBetween(j.job_date || j.out_date, j.job_end || j.return_date);
}

const sameLines = (a: Row[], b: Row[]) =>
  a.length === b.length && a.every((x) => b.some((y) => num(y.ID) === num(x.ID) && Math.abs(num(y.PRICE) - num(x.PRICE)) < PENNY));

/**
 * Split the draft's VAT, or check a split already there. Returns 'split' when
 * it changed the draft (the caller then stops for a person to look), 'checked'
 * when the draft was already right and checks out, 'none' when the job has no
 * non-UK days after all. Stops (via `rep`) on anything it can't do or can't prove.
 */
export async function splitEuDraft(rep: CloseReporter, ctx: {
  jobId: string; hhJobNumber: number; draftId: number; firstInvoice: boolean;
}): Promise<'split' | 'checked' | 'none'> {
  const { hhJobNumber, draftId } = ctx;
  const deleteHint = `Delete draft ${draftId} in HireHop and ${rep.retryHint} to start again.`;
  const supply = await readSupplyItems(hhJobNumber, true);
  if (!supply) await rep.stop('vat_split', `Could not read the job's items from HireHop to split the VAT. Nothing was changed — ${rep.retryHint} to try again.`);
  const nonUkDays = nonUkDaysOf(supply!);
  if (nonUkDays <= 0) return 'none';
  const hireDays = await hireDaysOf(ctx.jobId);
  const classes = classifyNominals(supply!);
  const byJobLine = new Map(supply!.map((i: any) => [num(i.ID), i]));
  const classOf = (line: Row): VatClass | null => {
    const item = byJobLine.get(num(line.MAIN_ID));
    if (!item) return null;
    return classes[item.ACC_NOMINAL != null ? String(item.ACC_NOMINAL) : '0'] ?? 'equipment';
  };

  let rows = await readBillingRows(hhJobNumber);
  let draft = findInvoice(rows, draftId);
  const nominalNames = new Map<number, string>(
    (draft?.data?.nominal_codes || []).map((n: any) => [num(n.ID), String(n.NAME || `Nominal ${n.CODE}`)]),
  );
  let changed = false;

  if (!invoiceItems(draft).some(isSplitLine)) {
    const result = planEuSplit({
      lines: invoiceItems(draft), classOf, hireDays, nonUkDays,
      nominalName: (id) => nominalNames.get(id) || `Nominal ${id}`,
    });
    if ('problem' in result) await rep.stop('vat_split', result.problem);
    const plan = (result as { plan: EuSplitPlan }).plan;

    // 1. The custom lines first.
    for (const c of plan.custom) {
      const before = invoiceItems(draft);
      const after0 = before.length ? num(before[before.length - 1].ID) : 0;
      const res = await postCustomInvoiceLine(hhJobNumber, draftId, { ...c, after: after0 });
      rows = await readBillingRows(hhJobNumber);
      draft = findInvoice(rows, draftId);
      const fresh = invoiceItems(draft).filter((l) => !before.some((b) => num(b.ID) === num(l.ID)));
      const ok = fresh.length === 1 && fresh[0].DESCRIPTION === c.description && Math.abs(num(fresh[0].PRICE) - c.amount) < PENNY
        && num(fresh[0].ACC_TAX_RATE_ID) === c.taxId && num(fresh[0].ACC_NOMINAL_ID) === c.nominalId;
      if (!ok || !sameLines(before, invoiceItems(draft).filter((l) => !fresh.includes(l)))) {
        await rep.stop('vat_split', `HireHop did not add the line "${c.description}" (${gbp(c.amount)}) as asked`
          + `${res?.error ? ` (${res.error})` : ''}. Nothing has gone to Xero. ${deleteHint}`);
      }
      await rep.log('vat_split', true, `Added "${c.description}": ${gbp(c.amount)} on tax code ${c.taxId}.`);
    }

    // 2. Then the real lines to 100% discount.
    for (const line of plan.zero) {
      const before = invoiceItems(draft);
      const res = await postZeroInvoiceLine(hhJobNumber, draftId, line);
      rows = await readBillingRows(hhJobNumber);
      draft = findInvoice(rows, draftId);
      const after = invoiceItems(draft);
      const mine = after.filter((l) => num(l.MAIN_ID) === num(line.MAIN_ID) && num(l.KIND) === num(line.KIND));
      const others = after.filter((l) => !mine.includes(l));
      const othersBefore = before.filter((l) => num(l.MAIN_ID) !== num(line.MAIN_ID) || num(l.KIND) !== num(line.KIND));
      if (mine.length !== 1 || num(mine[0].PRICE) >= PENNY || !sameLines(othersBefore, others)) {
        await rep.stop('vat_split', `HireHop did not put "${lineName(line)}" at 100% discount as asked`
          + `${res?.error ? ` (${res.error})` : ''}, or changed another line. Nothing has gone to Xero. ${deleteHint}`);
      }
    }
    if (plan.zero.length) await rep.log('vat_split', true, `${plan.zero.length} item line${plan.zero.length === 1 ? '' : 's'} put at 100% discount (their money is on the UK / non-UK lines).`);

    // 3. Vehicles on a 31+ day hire: zero-rated, price untouched.
    for (const line of plan.zeroRate) {
      const before = invoiceItems(draft);
      const res = await postInvoiceLineTax(hhJobNumber, draftId, line, { rate: 0, taxId: ZERO_RATED_TAX_ID });
      rows = await readBillingRows(hhJobNumber);
      draft = findInvoice(rows, draftId);
      const after = invoiceItems(draft);
      const mine = after.find((l) => num(l.ID) === num(line.ID));
      if (!mine || num(mine.ACC_TAX_RATE_ID) !== ZERO_RATED_TAX_ID || Math.abs(num(mine.PRICE) - num(line.PRICE)) >= PENNY
        || !sameLines(before.filter((l) => l !== line && num(l.ID) !== num(line.ID)), after.filter((l) => l !== mine))) {
        await rep.stop('vat_split', `HireHop did not zero-rate "${lineName(line)}" as asked${res?.error ? ` (${res.error})` : ''}. Nothing has gone to Xero. ${deleteHint}`);
      }
    }
    if (plan.zeroRate.length) await rep.log('vat_split', true, `${plan.zeroRate.length} vehicle line${plan.zeroRate.length === 1 ? '' : 's'} zero-rated (${hireDays}-day hire, 31+).`);
    changed = plan.zero.length + plan.zeroRate.length > 0;
  }

  // Read back the whole draft: the split is all there, and the money matches.
  const problems = checkSplitDraft({ lines: invoiceItems(draft), classOf, hireDays, nonUkDays });
  if (problems.length) await rep.stop('vat_split', `Draft ${draftId} isn't split correctly: ${problems.join(' ')} Nothing has gone to Xero. ${deleteHint}`);
  const net = invoiceNet(draft!) ?? 0;
  const gross = invoiceGross(draft!) ?? 0;
  if (ctx.firstInvoice) {
    const portal = await calculateVatAdjustment(hhJobNumber, hireDays);
    if (!portal) await rep.stop('vat_split', `Couldn't work out the portal's VAT figure to check draft ${draftId} against. Nothing has gone to Xero — ${rep.retryHint} to try again.`);
    const expected = round2(portal!.adjustedTotal);
    if (Math.abs(expected - gross) > PORTAL_TOLERANCE + 1e-9) {
      await rep.stop('vat_split', `Draft ${draftId} comes to ${gbp(gross)} but the payment portal worked this hire out at ${gbp(expected)} `
        + `(${nonUkDays} non-UK of ${hireDays} days). Stopped at the draft; nothing has gone to Xero. Check the job's dates and the "Non-standard VAT rules" quantity, then ${deleteHint.charAt(0).toLowerCase()}${deleteHint.slice(1)}`);
    }
  }
  await rep.log('vat_split', true, `Draft ${draftId} split: ${nonUkDays} non-UK of ${hireDays} days — ${gbp(net)} ex VAT, ${gbp(gross)} inc VAT`
    + `${ctx.firstInvoice ? ', matching the payment portal' : ''}.`);
  return changed ? 'split' : 'checked';
}
