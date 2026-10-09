/**
 * Cost lines — one payable broken into N lines.
 *
 * A single invoice often covers several different things: a freelancer bills
 * £325 that is really £250 of driver fee, £60 of fuel and £15 of train fare.
 * Without lines that is one cost with one category and one VAT rate, so
 * whichever category staff pick, the rest is quietly wrong.
 *
 * THE ONE RULE EVERYTHING ELSE HANGS OFF: `costs.amount_gross` is authoritative.
 * It is what we owe and what we pay, it is typed by a human, and nothing here
 * ever writes it — the lines must sum back to it.
 *
 * VAT is different, and used to be modelled wrongly. It is not part of what we
 * owe; it is an ANALYSIS of what we owe. Requiring staff to type it both on the
 * header and on every line meant two figures that could disagree, and a save
 * that failed with "the gross balances but the VAT doesn't" — a confusing state
 * with no good fix. So when a cost HAS lines, each line carries its own VAT and
 * the header's `amount_vat` / `amount_net` are DERIVED from them
 * (`headerVatFromLines`). With no lines nothing changes: the header's own VAT
 * mode decides, exactly as it always has.
 *
 * Both the routes and the Xero push read lines through THIS module — see
 * `buildCostLineItems` in cost-xero-push.ts — so the shape is defined once.
 *
 * See docs/COST-LINES-SPEC.md.
 */
import { query } from '../config/database';

export interface CostLine {
  id: string;
  cost_id: string;
  line_no: number;
  description: string | null;
  amount_gross: string | number;
  amount_vat: string | number;
  xero_account_code: string | null;
  job_id: string | null;
  crew_fronted: boolean;
  source: 'manual' | 'ai';
}

/** A line as it arrives from the API, before it has an id. */
export interface CostLineInput {
  description?: string | null;
  amount_gross: number;
  amount_vat?: number | null;
  xero_account_code?: string | null;
  job_id?: string | null;
  crew_fronted?: boolean;
  source?: 'manual' | 'ai';
}

/** Money comparisons are never exact — the balance rules allow a 1p residue. */
export const LINE_TOLERANCE = 0.01;

const num = (v: unknown) => Number(v ?? 0) || 0;
const round2 = (n: number) => Math.round(n * 100) / 100;
// Compare money in whole pence, never as floats. 33.33 * 3 is 99.99000000000001
// in IEEE754, so `Math.abs(sum - total) > 0.01` REJECTS an exactly-1p residue —
// the very case the tolerance exists to allow. Integers have no such problem.
const pence = (v: unknown) => Math.round(num(v) * 100);

/**
 * The cost's lines, in display order. Empty array = no lines, which means the
 * cost behaves exactly as it always has (no backfill, no migration).
 */
export async function fetchCostLines(costId: string): Promise<CostLine[]> {
  const r = await query(
    `SELECT id, cost_id, line_no, description, amount_gross, amount_vat,
            xero_account_code, job_id, crew_fronted, source
       FROM cost_lines WHERE cost_id = $1 ORDER BY line_no ASC`,
    [costId],
  );
  return r.rows as CostLine[];
}

/**
 * Check a proposed set of lines against the cost header.
 *
 * Returns a staff-readable message, or null when the set is good. Deliberately
 * a plain string rather than a thrown error — every caller wants to hand it
 * straight back to the user.
 *
 * An UNBALANCED set is REJECTED rather than saved-and-flagged. A cost saved
 * with lines that don't add up is an unflagged problem with no owner, sitting
 * in the payables queue looking fine. (The UI owes the user the other half of
 * this bargain: closing the modal on an unbalanced split must warn that nothing
 * will be saved.)
 */
export function validateCostLines(
  cost: { amount_gross: unknown; amount_vat: unknown; vat_treatment?: string | null },
  lines: CostLineInput[],
): string | null {
  if (!lines.length) return null; // clearing the split is always allowed

  // The reclaim_split push builds its own 3-line Exclusive structure (net @ No
  // VAT, vat/0.2 @ 20%, −vat/0.2 @ No VAT) on a single account code. Mixing
  // user lines into that is a real design problem, not a coding one, and
  // insurance-claim invoices aren't the case lines exist to solve.
  if (cost.vat_treatment === 'reclaim_split') {
    return 'This cost uses the VAT-reclaim split (insurance claims), which pushes its own three-line structure to Xero. It can’t also be split into lines.';
  }

  for (const [i, l] of lines.entries()) {
    const gross = pence(l.amount_gross);
    const vat = pence(l.amount_vat);
    if (gross <= 0) return `Line ${i + 1} needs an amount greater than zero.`;
    if (vat < 0) return `Line ${i + 1} has a negative VAT amount.`;
    if (vat > gross) {
      return `Line ${i + 1}: VAT (£${(vat / 100).toFixed(2)}) can’t be more than the line total (£${(gross / 100).toFixed(2)}).`;
    }
  }

  // ONE balance rule: do the lines add up to the invoice total? There is no
  // second VAT check because there is nothing for the VAT to disagree WITH —
  // the header's VAT is the sum of these lines by construction.
  const grossTotal = lines.reduce((t, l) => t + pence(l.amount_gross), 0);
  const headerGross = pence(cost.amount_gross);
  const tolerance = Math.round(LINE_TOLERANCE * 100);
  const gbp = (p: number) => `£${(p / 100).toFixed(2)}`;

  if (Math.abs(grossTotal - headerGross) > tolerance) {
    const diff = grossTotal - headerGross;
    return `The lines add up to ${gbp(grossTotal)} but the cost is ${gbp(headerGross)} — ${
      diff > 0 ? `${gbp(diff)} too much` : `${gbp(-diff)} short`
    }. Adjust the lines so they match the invoice total.`;
  }
  return null;
}

/**
 * The header's VAT and net, derived from the lines.
 *
 * VAT is an analysis of the total, not part of it, so a cost WITH lines takes
 * its VAT from them rather than from a separately-typed header figure that
 * could disagree. `amount_gross` is passed through untouched — that is the
 * figure staff typed off the invoice and the one thing lines may never change.
 *
 * Callers apply this on write, so `costs.amount_vat` always agrees with
 * `SUM(cost_lines.amount_vat)` for a cost that has lines.
 */
export function headerVatFromLines(
  lines: CostLineInput[],
  headerGross: unknown,
): { amount_vat: number; amount_net: number } {
  const vat = lines.reduce((t, l) => t + pence(l.amount_vat), 0);
  return { amount_vat: vat / 100, amount_net: (pence(headerGross) - vat) / 100 };
}

/**
 * Line gross amounts with any sub-penny residue folded onto the LARGEST line.
 *
 * The API guarantees the lines sum to the header within 1p, but a three-way
 * split of an odd total doesn't divide cleanly. The bill must still foot to
 * what we owe, so the residue goes somewhere — and the largest line is where a
 * penny distorts least. Applied only when BUILDING the Xero payload: the stored
 * lines keep exactly the figures staff typed.
 */
export function grossesWithResidue(lines: Pick<CostLine, 'amount_gross'>[], headerGross: unknown): number[] {
  const p = lines.map((l) => pence(l.amount_gross));
  if (!p.length) return [];
  const residue = pence(headerGross) - p.reduce((a, b) => a + b, 0);
  if (residue !== 0) {
    let biggest = 0;
    for (let i = 1; i < p.length; i += 1) if (p[i] > p[biggest]) biggest = i;
    p[biggest] += residue;
  }
  return p.map((v) => v / 100);
}

/**
 * Replace a cost's lines wholesale, inside a transaction.
 *
 * Whole-set replacement (rather than per-line patching) keeps `line_no`
 * contiguous for free and means the UI only ever has to send what it currently
 * shows. An empty array clears the split.
 *
 * NB the caller validates first — this writes what it's given.
 */
export async function replaceCostLines(costId: string, lines: CostLineInput[]): Promise<CostLine[]> {
  await query('BEGIN');
  try {
    await query('DELETE FROM cost_lines WHERE cost_id = $1', [costId]);
    for (const [i, l] of lines.entries()) {
      await query(
        `INSERT INTO cost_lines
           (cost_id, line_no, description, amount_gross, amount_vat,
            xero_account_code, job_id, crew_fronted, source)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          costId,
          i + 1,
          l.description ?? null,
          round2(num(l.amount_gross)),
          round2(num(l.amount_vat)),
          l.xero_account_code ?? null,
          l.job_id ?? null,
          l.crew_fronted ?? false,
          l.source ?? 'manual',
        ],
      );
    }
    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }
  return fetchCostLines(costId);
}
