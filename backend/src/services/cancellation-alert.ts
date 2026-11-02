/**
 * The internal "job cancelled" email (`job_cancelled_internal`) — what is LEFT
 * to do on a cancellation's money, for whichever manager picks it up.
 *
 * Until Oct 2026 it was titled "Cancellation Processed" and listed the fee and
 * refund as facts, so it read as if everything was finished — when the fee
 * invoice, the refund and sending the invoice were all still to do (job 16725).
 * Now it is a to-do list, and the same follow-up cards are chased by the 09:30
 * close-out scanner from CANCELLATION_CHASE_DAYS after cancelling
 * (routes/cancellations.ts step 11, config/scheduler.ts).
 *
 * Pure: the route gathers the figures (the fee with VAT from
 * cancellation-close.ts `cancellationFeeGross()`, excess from `v_excess_held`)
 * and this turns them into template variables. The template's {{#if}} blocks
 * can't nest, so every step has its own flag.
 */

/** Days after cancelling before an unfinished follow-up card is chased (jon, Oct 2026). */
export const CANCELLATION_CHASE_DAYS = 3;

/** Below half a penny is nothing — never compare money against 0. */
const HALF_PENNY = 0.005;

export interface CancellationAlertInput {
  cancelledBy: string;
  jobName: string;
  hhJobNumber: number | string | null;
  reason: string;
  /** The fee before VAT, as saved at cancellation. */
  feeNet: number;
  /** The fee with VAT — `cancellationFeeGross(feeNet)`. */
  feeGross: number;
  /** What goes back to the client after the fee (the pending refund). */
  refund: number;
  /** What the client still owes after their payments go against the fee. */
  owing: number;
  /** Excess held on the job right now (`v_excess_held`). */
  excessHeld: number;
  /** False when staff ticked off the client email in the cancel window. */
  clientEmailed: boolean;
  /** The first day an unfinished card is chased, YYYY-MM-DD. */
  chaseFrom: string;
  moneyUrl: string;
  listUrl: string;
}

const gbp = (n: number) =>
  `£${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "Thu 29 Oct" from YYYY-MM-DD (read as a calendar date, not a moment). */
function shortDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  if (Number.isNaN(date.getTime())) return ymd;
  return date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Template variables for `job_cancelled_internal`. Empty string = flag off. */
export function cancellationAlertVariables(input: CancellationAlertInput): Record<string, string> {
  const on = (b: boolean) => (b ? '1' : '');
  const hasFee = input.feeNet >= HALF_PENNY;
  const hasRefund = input.refund >= HALF_PENNY;
  const hasOwing = input.owing >= HALF_PENNY;
  const hasExcess = input.excessHeld >= HALF_PENNY;
  const hasMoneySteps = hasFee || hasRefund || hasOwing || hasExcess;
  const number = String(input.hhJobNumber ?? '').trim();

  return {
    cancelledBy: input.cancelledBy,
    jobName: input.jobName,
    // `jobNumber` is the bare number so email_log links a bounce back to the job
    // (email-service `jobNumberForLog`); `jobRef` is what people read.
    jobNumber: number,
    jobRef: number ? `J-${number}` : 'no HireHop number',
    reason: input.reason,
    subjectAction: hasMoneySteps ? 'money to finish' : 'nothing to settle',
    hasMoneySteps: on(hasMoneySteps),
    nothingToDo: on(!hasMoneySteps),
    hasFee: on(hasFee),
    feeNet: gbp(input.feeNet),
    feeGross: gbp(input.feeGross),
    hasRefund: on(hasRefund),
    refund: gbp(input.refund),
    hasOwing: on(hasOwing),
    owing: gbp(input.owing),
    hasExcess: on(hasExcess),
    excessHeld: gbp(input.excessHeld),
    clientEmailed: on(input.clientEmailed),
    clientNotEmailed: on(!input.clientEmailed),
    chaseFrom: shortDay(input.chaseFrom),
    moneyUrl: input.moneyUrl,
    listUrl: input.listUrl,
  };
}
