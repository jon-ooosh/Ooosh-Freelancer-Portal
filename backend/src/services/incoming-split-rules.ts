/**
 * Pure rules for splitting one Wise transfer across several jobs
 * (services/incoming-split.ts). No database — tested on their own.
 *
 * Money is compared in whole pence: 33.33 * 3 is 99.99000000000001 in floating point.
 */

export const SPLIT_MAX_LINES = 10;
/** Line statuses that count towards the transfer. 'failed' never counts. */
export const SPLIT_COUNTING_STATUSES = ['recording', 'recorded', 'linked'] as const;

export type SplitPaymentType = 'deposit' | 'balance' | 'excess';
/** record = record new money (refused if it looks already on the job); record_anyway = a genuine second payment; link = it IS that hand-recorded payment. */
export type SplitDecision = 'record' | 'record_anyway' | 'link';

export interface SplitLineRequest {
  hh_job_number: number;
  payment_type: SplitPaymentType;
  amount: number;
  decision?: SplitDecision;
  /** The job payment this line IS (decision 'link'). */
  link_payment_id?: string;
}

export const pence = (n: number): number => Math.round(n * 100);
const pounds = (p: number): string => `£${(p / 100).toFixed(2)}`;

/**
 * Do the new lines finish the transfer exactly? `done` = amounts of the lines that
 * already count (an earlier, part-finished split). Returns the problem, or null.
 */
export function checkSplitLines(total: number, done: number[], lines: SplitLineRequest[]): string | null {
  if (lines.length === 0) return 'Add at least one line';
  if (done.length + lines.length > SPLIT_MAX_LINES) return `A transfer can be split ${SPLIT_MAX_LINES} ways at most`;
  for (const [i, l] of lines.entries()) {
    if (!Number.isInteger(l.hh_job_number) || l.hh_job_number <= 0) return `Line ${i + 1}: enter the HireHop job number`;
    if (!['deposit', 'balance', 'excess'].includes(l.payment_type)) return `Line ${i + 1}: choose hire or excess`;
    if (!Number.isFinite(l.amount) || pence(l.amount) < 1) return `Line ${i + 1}: enter an amount`;
    if (Math.abs(l.amount * 100 - pence(l.amount)) > 1e-6) return `Line ${i + 1}: an amount is pounds and pence`;
    if (l.decision === 'link' && !l.link_payment_id) return `Line ${i + 1}: which payment does it link to?`;
  }
  const linked = lines.filter(l => l.decision === 'link').map(l => l.link_payment_id);
  if (new Set(linked).size !== linked.length) return 'Two lines link to the same payment';

  const totalP = pence(total);
  const doneP = done.reduce((s, a) => s + pence(a), 0);
  const newP = lines.reduce((s, l) => s + pence(l.amount), 0);
  if (doneP + newP !== totalP) {
    const left = totalP - doneP;
    return `The lines add up to ${pounds(newP)}, but ${pounds(left)} of the ${pounds(totalP)} is left to split`;
  }
  return null;
}

/** "#16911 hire £1,163.64 · #16912 excess £1,200.00" — the note on a finished split. */
export function describeSplit(lines: Array<{ hh_job_number: number | null; payment_type: string; amount: number; status: string }>): string {
  return lines
    .filter(l => (SPLIT_COUNTING_STATUSES as readonly string[]).includes(l.status))
    .map(l => `#${l.hh_job_number ?? '?'} ${l.payment_type === 'excess' ? 'excess' : 'hire'} £${l.amount.toFixed(2)}${l.status === 'linked' ? ' (already recorded, linked)' : ''}`)
    .join(' · ');
}
