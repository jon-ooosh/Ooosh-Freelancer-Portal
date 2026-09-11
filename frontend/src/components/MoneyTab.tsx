/**
 * MoneyTab — Unified financial view for a job.
 *
 * Shows: HireHop financial summary, insurance excess, payment history,
 * record payment form, client account balance.
 */
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { describePreauth, paymentMethodLabel } from '../lib/preauth';
import { getPaymentState, PAYMENT_STATE_LABELS, PAYMENT_STATE_CLASSES } from '../services/paymentState';
import { hasOutstanding, isNonZero } from '../lib/money';
import ExcessPaymentModal, { statusLabel, statusColor, computeHireDays } from './ExcessPaymentModal';
import CostCaptureModal from './CostCaptureModal';
import CostAllocationModal from './CostAllocationModal';
import RechargeResolveModal, { RechargeStatusPill } from './RechargeResolveModal';
import ResendConfirmationModal from './ResendConfirmationModal';
import { ReceiptThumb, ReceiptPreview } from './costs/CostReceipt';
import type { JobExcess, Cost } from '../../../shared/types';

// HireHop bank accounts (id → label) for the cross-job apply bank field.
const HH_BANKS: Array<{ id: number; label: string }> = [
  { id: 265, label: 'Wise — Current Account (BACS)' },
  { id: 169, label: 'Worldpay (all cards except Amex)' },
  { id: 165, label: 'Amex' },
  { id: 267, label: 'Stripe GBP' },
  { id: 170, label: 'Lloyds Bank' },
  { id: 168, label: 'Till (Cash)' },
  { id: 173, label: 'PayPal' },
];

interface MoneyTabProps {
  jobId: string;
  job: any; // Job object from parent
  onJobChanged?: () => void; // Notify parent to refresh job data (e.g. after status change)
}

interface FinancialData {
  job: { id: string; hh_job_number: number; client_name: string };
  financial: {
    hire_value_ex_vat: number;
    hire_value_inc_vat: number;
    vat_amount: number;
    original_vat_amount?: number;
    original_hire_value_inc_vat?: number;
    vat_adjusted: boolean;
    vat_saved: number;
    total_deposits: number;
    total_hire_deposits: number;
    total_excess_deposits: number;
    /** All non-excess credit notes on the job (informational). */
    total_credit_notes?: number;
    /** Money the client has OVERPAID and is owed back. 0 when square. Derived
     *  from HireHop's own invoice `owing`, so it self-clears once refunded. */
    client_overpaid?: number;
    /** Portion of credit notes treated as a write-off of accrued value —
     *  already subtracted from balance_outstanding by the backend. */
    credit_note_write_off?: number;
    balance_outstanding: number;
    // Business-level balance override (migration 117) — admin flagged the HH
    // balance as settled in Xero / written off. Null when not overridden.
    balance_override?: {
      reason: string; notes: string | null;
      resolved_at: string | null; resolved_by_name: string | null;
    } | null;
    required_deposit: number;
    deposit_paid: boolean;
    deposit_percent: number;
    deposits: Array<{
      id: number; amount: number; date: string;
      description: string | null; memo: string | null;
      is_excess: boolean; is_refund: boolean;
      /** True for real kind:6 deposits (refundable + cross-job applicable);
       *  absent on application lines (excess/credit applied to invoice). */
      is_deposit?: boolean;
      /** HireHop bank account id — default for the cross-job apply bank field. */
      acc_account_id?: number | null;
      /** Unallocated money on this deposit — what HireHop will actually let us
       *  refund out of it. Lower than `amount` once the deposit has been applied
       *  to an invoice; £0 when fully applied. null when HH published neither
       *  reading. Drives the Refund modal's release warning. */
      available_to_refund?: number | null;
      bank_name: string | null; entered_by: string | null;
      /** Original Stripe PaymentIntent (when OP has a matching job_payments row).
       *  Presence enables OP-initiated Stripe refund on the row. */
      stripe_payment_intent?: string | null;
      /** Original OP-side payment method (when matched). Drives the modal's default. */
      op_payment_method?: string | null;
    }>;
    /** OP-only pending refund IOUs (e.g. cancellation refunds) awaiting processing. */
    pending_refunds?: Array<{
      /** job_payments.id — a UUID. Was typed `number` here, which was simply
       *  wrong; the uuid-validated endpoints only worked because JSON carried
       *  the real string through regardless. */
      id: string; amount: number; method: string | null; notes: string | null; date: string;
    }>;
  };
  vat_adjustment: {
    applies: boolean;
    hireDays: number; ukDays: number; nonUkDays: number;
    vatSaved: number; adjustedVat: number; adjustedTotal: number; originalTotalIncVat: number;
    breakdown: Array<{ category: string; subtotalNet: number; subtotalVat: number; subtotalGross: number; vatSaved: number; rule: string }>;
    explanationText: string;
  } | null;
  excess: {
    records: (JobExcess & { driver_name?: string; vehicle_reg?: string })[];
    total_required: number;
    total_collected: number;
    topn_shortfall?: {
      correctTotal: number;
      chargeableTotal: number;
      short: number;
      drivers: string[];
    } | null;
    status: string | null;
  };
  client_balance_on_account: number;
  reconciliation?: {
    actions: Array<{ hh_deposit_id: number; excess_id: string; action: string }>;
    unmatched_hh_deposits: Array<{
      hh_deposit_id: number; amount: number; date: string;
      description: string | null; memo: string | null;
      bank_name: string | null;
    }>;
  };
}

const PAYMENT_METHODS_BASE = [
  { value: 'worldpay', label: 'Worldpay (all cards EXCEPT AMEX)' },
  { value: 'amex', label: 'Amex' },
  { value: 'stripe_gbp', label: 'Stripe GBP' },
  { value: 'wise_bacs', label: 'Wise - Current Account (BACS)' },
  { value: 'till_cash', label: 'Till (Cash)' },
  { value: 'paypal', label: 'Paypal' },
  { value: 'lloyds_bank', label: 'Lloyds Bank' },
];

// Business-level balance-override reasons (migration 117). Mirrors the list on
// MoneyOverviewPage — kept local to avoid a cross-file dependency for 5 strings.
const BALANCE_REASONS = [
  { value: 'xero_settled', label: 'Settled in Xero (not fed back to HireHop)' },
  { value: 'internal_discounted', label: 'Internal / discounted job' },
  { value: 'hh_xero_corrected', label: 'Corrected HireHop↔Xero error' },
  { value: 'write_off', label: 'Write-off (bad debt / goodwill)' },
  { value: 'other', label: 'Other' },
];
const BALANCE_REASON_LABEL: Record<string, string> = Object.fromEntries(BALANCE_REASONS.map((r) => [r.value, r.label]));

interface JobCostLite {
  id: string;
  supplier_name: string | null;
  description: string | null;
  category: string | null;
  // Xero nominal code — /costs/by-job returns c.*, so it was always on the wire.
  // Drives the actuals make-up buckets on the quoted-vs-actual cards.
  xero_account_code?: string | null;
  // Cost lines, when the invoice was split. Each carries its own code, so a
  // bundled bill buckets by what each part WAS rather than by the header's
  // single category. Empty on a split-in row and on any unsplit cost.
  lines?: Array<{ amount_gross: number | string; xero_account_code: string | null; crew_fronted: boolean }>;
  amount_gross: number | null;
  amount_net: number | null;
  cost_intent: 'quote_actual' | 'extra' | null;
  recharge_mode: 'none' | 'full' | 'partial';
  recharge_amount: number | null;
  recharged_to_hh_at: string | null;
  recharge_status: string | null;
  // Allocation-aware read: a row split IN from a cost captured on another job.
  // amount_gross is this job's share; full_amount_gross is the cost's total.
  is_allocation?: boolean;
  full_amount_gross?: number | null;
  allocation_id?: string | null;
  // Capture job — where the cost was actually entered (differs from this job on
  // split-in rows; the full invoice + recharge live there).
  job_id?: string | null;
  capture_hh_job_number?: number | null;
  // Paperwork. /costs/by-job returns `c.*`, so these have always been on the
  // wire — the panel just never rendered them. The receipt is the thing staff
  // reach for when a client queries a line, so it's one click from here now.
  receipt_r2_key?: string | null;
  receipt_filename?: string | null;
  invoice_number?: string | null;
}
interface JobQuoteLite {
  id: string;
  freelancer_fee: number | null;
  freelancer_fee_rounded: number | null;
  client_fee: number | null;
  status: string | null;
  // Cost components (for the Expected make-up). Admin fee is deliberately NOT a
  // column — it's a markup, never an invoice we reconcile against — so summing
  // these four gives the outlay we actually expect to pay out.
  expected_fuel_cost: number | null;
  expenses_included: number | null;
  travel_cost: number | null;
}

// ── Rollover chain outcome ────────────────────────────────────────────────
// A record whose money rolled forward keeps excess_status='rolled_over' FOREVER
// — that status is a fact about THIS hire ("the money left here"), and it can't
// know what later happened to the money. So once a downstream hire reimbursed
// or claimed it, the origin card still headlined a purple "Rolled Over" and the
// outcome was only readable in the small rollover-thread breadcrumb (job 16371:
// £1,200 rolled to #16605 and reimbursed there, while #16371 still read as
// money in motion).
//
// This resolves the chain's TERMINAL state so the origin card can headline the
// outcome instead. Deliberately conservative — it only claims closure when
// EVERY hop after this record is either a pass-through ('rolled_over') or a
// settled state, and the last hop is settled. A fork that left one branch open,
// or a tail still sitting on 'taken'/'partially_paid', falls through to today's
// rendering rather than announcing a closure that hasn't happened.

/** Statuses that mean the money's journey has finished — nothing left to chase. */
const CHAIN_SETTLED_STATUSES = ['reimbursed', 'fully_claimed', 'claimed', 'waived', 'released', 'not_required'];

type RolloverChainEntry = {
  id: string;
  excess_status: string;
  job_id: string | null;
  hh_job_number: number | null;
  job_name: string | null;
  excess_amount_taken: string | number | null;
  payment_date: string | null;
  payment_method: string | null;
  claim_amount: string | number | null;
  reimbursement_amount: string | number | null;
  reimbursement_date: string | null;
};

/**
 * The settled tail of `recordId`'s rollover chain, or null when the chain is
 * still live (or `recordId` IS the tail — then its own status already tells the
 * truth and nothing needs promoting).
 */
function resolveChainOutcome(chain: RolloverChainEntry[], recordId: string): RolloverChainEntry | null {
  const here = chain.findIndex((l) => l.id === recordId);
  if (here === -1) return null;
  const downstream = chain.slice(here + 1);
  if (downstream.length === 0) return null;
  const tail = downstream[downstream.length - 1];
  if (!CHAIN_SETTLED_STATUSES.includes(tail.excess_status)) return null;
  // Every intermediate hop must be a pass-through or settled. Anything else
  // (e.g. a fork branch still holding money) means the chain is not closed.
  const allResolved = downstream.every(
    (l) => l.excess_status === 'rolled_over' || CHAIN_SETTLED_STATUSES.includes(l.excess_status)
  );
  return allResolved ? tail : null;
}

/** The amount that actually settled the chain, for the outcome line. */
function chainOutcomeAmount(tail: RolloverChainEntry): number | null {
  const reimbursed = Number(tail.reimbursement_amount || 0);
  const claimed = Number(tail.claim_amount || 0);
  if (tail.excess_status === 'reimbursed' && reimbursed > 0) return reimbursed;
  if ((tail.excess_status === 'fully_claimed' || tail.excess_status === 'claimed') && claimed > 0) return claimed;
  return null;
}

// ── Release consent ───────────────────────────────────────────────────────
// HireHop can only refund money still UNALLOCATED on a deposit. Once it has
// been applied to an invoice there is nothing to take back and the refund is
// rejected with error 370 — which on job 15628 fired only AFTER the Stripe
// refund had gone through, leaving real money moved and recorded nowhere.
//
// OP can release the amount back off the invoice first, but never on its own
// initiative: the backend answers 409 with the exact figures and waits. This
// panel is that question. "Never silently move money" covers allocations too —
// the cash received doesn't change, but which invoice it is pointed at does,
// and that is someone's bookkeeping.
type ReleasePlan = {
  deposit_id: number; available: number; shortfall: number;
  invoice_id: number; invoice_number: string | null;
  application_id: number; application_amount: number; new_application_amount: number;
};

function ReleaseConsentPanel({ plan, refundAmount, depositAmount, viaStripe }: {
  plan: ReleasePlan;
  refundAmount: number;
  depositAmount: number;
  viaStripe: boolean;
}) {
  const invoice = plan.invoice_number || plan.invoice_id;
  return (
    <div className="px-3 py-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 space-y-2">
      <div className="font-semibold">Nothing to refund on this deposit yet</div>
      <p>
        All £{depositAmount.toFixed(2)} of deposit {plan.deposit_id} is applied to invoice <strong>{invoice}</strong>.
        OP can free up £{plan.shortfall.toFixed(2)} by reducing that invoice&rsquo;s payment to
        £{plan.new_application_amount.toFixed(2)}, then refund. Reverts automatically if the refund fails.
      </p>
      {/* The detail matters to whoever wants it and is noise to everyone else.
          Three lines of decision, the rest a click away — the panel was tall
          enough to push the confirm button off-screen at 100% zoom. */}
      <details className="group">
        <summary className="cursor-pointer select-none font-medium underline decoration-dotted marker:content-['']">
          <span className="group-open:hidden">▸ What exactly changes?</span>
          <span className="hidden group-open:inline">▾ What exactly changes?</span>
        </summary>
        <ol className="list-decimal ml-4 mt-1.5 space-y-0.5">
          <li>
            Invoice {invoice}&rsquo;s payment from this deposit drops from £{plan.application_amount.toFixed(2)} to
            £{plan.new_application_amount.toFixed(2)}, freeing £{plan.shortfall.toFixed(2)}, and is pushed to Xero.
          </li>
          <li>£{refundAmount.toFixed(2)} is refunded{viaStripe ? ' through Stripe' : ''}.</li>
          <li>The refund is recorded in HireHop and OP.</li>
        </ol>
        <p className="mt-1.5">
          The £{depositAmount.toFixed(2)} we received is unchanged — only how much of it is pointed at that invoice.
          Invoice {invoice} shows £{plan.shortfall.toFixed(2)} owing until the refund lands. If step 2 fails, step 1
          is put back and nothing is refunded.
        </p>
      </details>
    </div>
  );
}


/**
 * "Tell the client" control for a refund.
 *
 * A Stripe refund has genuinely moved the money, so OP always emails and there
 * is nothing to decide — it just says so. Every other method is record-only:
 * the money moves by hand and OP has no way of knowing whether it has, so
 * emailing unconditionally risks telling someone a refund is on its way before
 * anyone has sent it.
 *
 * Ticked by default because the house rule is do-then-record — by the time a
 * BACS refund is being logged the money has normally gone — but it's a checkbox
 * precisely so the exception can be caught. The label says the assumption out
 * loud rather than leaving it implicit.
 */
function RefundNotifyControl({ viaStripe, checked, onChange }: {
  viaStripe: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  if (viaStripe) {
    return (
      <p className="text-[11px] text-gray-500">
        The client will be emailed confirmation of this refund.
      </p>
    );
  }
  return (
    <label className="flex items-start gap-2 text-xs text-gray-700 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        Email the client to confirm this refund
        <span className="block text-[11px] text-gray-500">
          Assumes you&rsquo;ve already sent the money — untick if you haven&rsquo;t yet.
        </span>
      </span>
    </label>
  );
}


export default function MoneyTab({ jobId, job, onJobChanged }: MoneyTabProps) {
  const [data, setData] = useState<FinancialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === 'admin';
  const canManage = hasManagerRole(role);
  const [showResolveBalance, setShowResolveBalance] = useState(false);
  const [balReason, setBalReason] = useState('xero_settled');
  const [balNotes, setBalNotes] = useState('');
  const [balSaving, setBalSaving] = useState(false);
  const [balError, setBalError] = useState('');

  // Resend client confirmation email (manual re-fire, e.g. after an SMTP blip)
  const [resendMsg, setResendMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showResendModal, setShowResendModal] = useState(false);

  // Record payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payType] = useState('deposit');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('worldpay');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payExcessId, setPayExcessId] = useState('');
  const [payPushToHH, setPayPushToHH] = useState(true);
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState('');
  const [payHHPushError, setPayHHPushError] = useState<string | null>(null);

  // Excess action modal
  const [actionExcess, setActionExcess] = useState<JobExcess | null>(null);

  // Rollover chains — "follow the thread" of a rolled-over excess. Keyed by
  // excess record id → ordered chain of records sharing the HH deposit.
  type ChainEntry = RolloverChainEntry;
  const [rolloverChains, setRolloverChains] = useState<Record<string, ChainEntry[]>>({});

  // Link deposit state. Picking a record no longer links immediately — it opens
  // a confirm step showing the resulting TOTAL collected, because linking used
  // to silently ADD the deposit to whatever was already on the record (job
  // 15187: £2,100 + a £1,200 deposit OP had already counted = £3,300).
  const [linkingDeposit, setLinkingDeposit] = useState<{ hh_deposit_id: number; amount: number } | null>(null);
  const [linkTarget, setLinkTarget] = useState<JobExcess | null>(null);
  const [linkTotal, setLinkTotal] = useState('');
  const [linkLoading, setLinkLoading] = useState(false);

  // Refund modal — hire-side payment refund (deposit/balance/etc.). Stripe-paid
  // rows refund directly via Stripe API; other methods record-keep only.
  const [refundingDep, setRefundingDep] = useState<FinancialData['financial']['deposits'][number] | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundMethod, setRefundMethod] = useState<'stripe_gbp' | 'worldpay' | 'amex' | 'wise_bacs' | 'till_cash' | 'paypal' | 'lloyds_bank'>('stripe_gbp');
  const [refundReference, setRefundReference] = useState('');
  const [refundNotes, setRefundNotes] = useState('');
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundError, setRefundError] = useState('');
  const [refundResult, setRefundResult] = useState<{
    stripe_refund_id?: string; hh_push_error?: string | null;
    client_email?: { sent: boolean; toEmail?: string; isFallback?: boolean; error?: string } | null;
  } | null>(null);
  // Record-only refunds (BACS/cash/Worldpay) only email when asked, because the
  // money moves by hand and OP can't know whether it has. Defaults ON because
  // the house rule is do-then-record — by the time it's being logged the money
  // has normally gone — but it's a checkbox precisely so the exception is
  // catchable. Ignored on the Stripe path, which always emails.
  const [refundNotifyClient, setRefundNotifyClient] = useState(true);
  // Set when the backend answered 409 `release_required`: this deposit is fully
  // applied to an invoice, so HireHop has nothing to refund from it until some
  // is released back off that invoice. We never do that silently — the panel
  // spells out the change and the retry carries allow_release. Shared by both
  // refund modals (the payment-history one and the pending-IOU one).
  const [refundRelease, setRefundRelease] = useState<ReleasePlan | null>(null);
  // Pending IOUs that were standing on this job when the refund was submitted.
  // Refunding from Payment History inserts a NEW completed refund row and
  // leaves any IOU untouched (only the IOU's own "Process refund" passes
  // pending_refund_id), so the two drift apart silently and Pending Refunds
  // fills up with money that has already gone back. Snapshotted at submit time
  // because loadData() replaces `data` once the modal closes.
  const [refundOrphanIous, setRefundOrphanIous] = useState<NonNullable<FinancialData['financial']['pending_refunds']>>([]);
  const [clearingIouId, setClearingIouId] = useState<string | null>(null);
  const [clearIouError, setClearIouError] = useState('');

  // Cross-job "Apply credit to another job" (Phase 2 CROSS-JOB-EXCESS-APPLY-SPEC).
  type ApplyInvoice = { id: number; number: string; description: string; owing: number };
  type ApplyGroup = { hh_job_number: number; job_name: string | null; invoices: ApplyInvoice[] };
  const [applyingDep, setApplyingDep] = useState<FinancialData['financial']['deposits'][number] | null>(null);
  const [applyAmount, setApplyAmount] = useState('');
  const [applyBank, setApplyBank] = useState<number | ''>('');
  const [applyGroups, setApplyGroups] = useState<ApplyGroup[]>([]);
  const [applyTarget, setApplyTarget] = useState<{ hhJob: number; invoiceId: number } | null>(null);
  const [applyLoadingInv, setApplyLoadingInv] = useState(false);
  const [applyLoading, setApplyLoading] = useState(false);
  const [applyError, setApplyError] = useState('');

  const openApplyModal = (dep: FinancialData['financial']['deposits'][number]) => {
    setApplyingDep(dep);
    setApplyAmount(String(dep.amount));
    setApplyBank(dep.acc_account_id ?? '');
    setApplyTarget(null);
    setApplyGroups([]);
    setApplyError('');
    setApplyLoadingInv(true);
    api.get<{ data: { jobs: ApplyGroup[] } }>(`/money/${jobId}/cross-job-invoices`)
      .then((r) => setApplyGroups(r.data.jobs || []))
      .catch((e: any) => setApplyError(e.message || 'Failed to load other jobs'))
      .finally(() => setApplyLoadingInv(false));
  };
  const submitApply = async () => {
    if (!applyingDep || !applyTarget) { setApplyError('Pick an invoice on another job'); return; }
    const amt = parseFloat(applyAmount);
    if (isNaN(amt) || amt <= 0) { setApplyError('Enter a valid amount'); return; }
    if (amt > Number(applyingDep.amount) + 0.005) { setApplyError(`Amount exceeds this deposit (£${Number(applyingDep.amount).toFixed(2)})`); return; }
    setApplyLoading(true); setApplyError('');
    try {
      await api.post(`/money/${jobId}/apply-credit`, {
        hh_deposit_id: applyingDep.id,
        amount: amt,
        target_hh_job: applyTarget.hhJob,
        invoice_id: applyTarget.invoiceId,
        ...(applyBank !== '' ? { bank: applyBank } : {}),
      });
      setApplyingDep(null);
      loadData();
    } catch (e: any) {
      setApplyError(e.message || 'Apply failed');
    } finally { setApplyLoading(false); }
  };

  // Job costs (Cost Capture) — quoted-vs-actual variance + extra/recharge list.
  const [jobCosts, setJobCosts] = useState<JobCostLite[]>([]);
  const [jobQuotes, setJobQuotes] = useState<JobQuoteLite[]>([]);
  const [showAddCost, setShowAddCost] = useState(false);
  const [splittingCost, setSplittingCost] = useState<Cost | null>(null);

  const openRefundModal = (dep: FinancialData['financial']['deposits'][number]) => {
    setRefundingDep(dep);
    setRefundAmount(String(dep.amount));
    setRefundMethod(dep.stripe_payment_intent ? 'stripe_gbp' : (dep.op_payment_method as typeof refundMethod) || 'worldpay');
    setRefundReference('');
    setRefundNotes('');
    setRefundError('');
    setRefundResult(null);
    setRefundRelease(null);
    setRefundNotifyClient(true);
  };

  const closeRefundModal = () => {
    setRefundingDep(null);
    setRefundError('');
    setRefundResult(null);
    setRefundRelease(null);
    setRefundOrphanIous([]);
    setClearIouError('');
    if (refundResult) loadData();
  };

  /**
   * Close an IOU that the refund just made has satisfied. Dismiss, NOT complete:
   * the refund already inserted its own completed row, so marking the IOU
   * complete as well would double-count it in every sum over completed refunds
   * (which is what makes the Pending Refunds headline untrustworthy in the first
   * place). `refunded_via_op` rather than `refunded_externally` — the money did
   * go through OP, just not through this IOU.
   */
  const clearOrphanIou = async (iou: NonNullable<FinancialData['financial']['pending_refunds']>[number]) => {
    setClearingIouId(iou.id);
    setClearIouError('');
    try {
      await api.post(`/money/${jobId}/dismiss-refund`, {
        refund_id: iou.id,
        reason: 'refunded_via_op',
        notes: `Cleared alongside a £${(parseFloat(refundAmount) || 0).toFixed(2)} refund recorded from Payment History on ${new Date().toLocaleDateString('en-GB')}.`,
      });
      setRefundOrphanIous((prev) => prev.filter((r) => r.id !== iou.id));
    } catch (e) {
      setClearIouError(e instanceof Error ? e.message : 'Could not clear it');
    } finally {
      setClearingIouId(null);
    }
  };

  // `allowRelease` is passed only by the confirm button on the release panel —
  // never defaulted on, so OP can't rewrite HireHop paperwork nobody agreed to.
  const submitRefund = async (allowRelease = false) => {
    if (!refundingDep) return;
    const parsed = parseFloat(refundAmount);
    if (isNaN(parsed) || parsed < 0.01) {
      setRefundError('Enter a valid amount (£0.01 or more)');
      return;
    }
    setRefundLoading(true);
    setRefundError('');
    try {
      const resp = await api.post<{
        data: unknown; stripe_refund_id?: string; hh_push_error?: string | null;
        client_email?: { sent: boolean; toEmail?: string; isFallback?: boolean; error?: string } | null;
      }>(
        `/money/${jobId}/refund-payment`,
        {
          hh_deposit_id: refundingDep.id,
          amount: parsed,
          method: refundMethod,
          reference: refundReference.trim() || null,
          notes: refundNotes.trim() || null,
          ...(allowRelease ? { allow_release: true } : {}),
          // Sent regardless of method; the backend ignores it on the Stripe
          // path, which always emails.
          notify_client: refundNotifyClient,
        }
      );
      setRefundRelease(null);
      // Any IOU still standing on this job is now probably a duplicate record
      // of the refund just made. Offered, not assumed — see the success panel.
      setRefundOrphanIous(data?.financial.pending_refunds || []);
      setClearIouError('');
      setRefundResult({
        stripe_refund_id: resp.stripe_refund_id,
        hh_push_error: resp.hh_push_error || null,
        client_email: resp.client_email || null,
      });
    } catch (e) {
      // 409 release_required isn't a failure — it's the backend asking a
      // question it refuses to answer on our behalf. Show the plan instead of
      // an error, and let the user decide.
      const body = (e as { body?: Record<string, unknown> })?.body;
      if (body?.code === 'release_required' && body.release) {
        setRefundRelease(body.release as ReleasePlan);
        setRefundError('');
      } else {
        setRefundRelease(null);
        setRefundError(e instanceof Error ? e.message : 'Refund failed');
      }
    } finally {
      setRefundLoading(false);
    }
  };

  // Process-pending-refund modal — actions an OP IOU (e.g. a cancellation
  // refund) by refunding against a chosen original deposit and marking the IOU
  // completed. Reuses the refundAmount/method/reference/notes/result state.
  const [pendingRefund, setPendingRefund] = useState<NonNullable<FinancialData['financial']['pending_refunds']>[number] | null>(null);
  const [pendingDepositId, setPendingDepositId] = useState<number | null>(null);

  // Hire deposits available to refund against. `is_deposit` matters: the list
  // also carries kind=3 application LINES (e.g. "Excess applied to hire
  // invoice"), which are not refundable and have no deposit id to release from.
  const refundableDeposits = (data?.financial.deposits || []).filter(d => !d.is_refund && !d.is_excess && d.is_deposit);
  const selectedDeposit = refundableDeposits.find(d => d.id === pendingDepositId) || null;

  const openPendingRefundModal = (pr: NonNullable<FinancialData['financial']['pending_refunds']>[number]) => {
    setPendingRefund(pr);
    const firstDep = refundableDeposits[0] || null;
    setPendingDepositId(firstDep ? firstDep.id : null);
    setRefundAmount(String(pr.amount));
    setRefundMethod(firstDep?.stripe_payment_intent ? 'stripe_gbp' : (firstDep?.op_payment_method as typeof refundMethod) || 'worldpay');
    setRefundReference('');
    setRefundNotes(pr.notes || '');
    setRefundError('');
    setRefundResult(null);
    setRefundRelease(null);
    setRefundNotifyClient(true);
  };

  const closePendingRefundModal = () => {
    setPendingRefund(null);
    setPendingDepositId(null);
    setRefundError('');
    setRefundResult(null);
    setRefundRelease(null);
    if (refundResult) loadData();
  };

  // A release plan is only valid for the deposit and amount it was calculated
  // for. Editing either must retract it — otherwise the confirm button would
  // still be armed with allow_release and apply a stale shortfall (or worse,
  // one deposit's plan to a different deposit).
  const setRefundAmountChecked = (v: string) => { setRefundAmount(v); setRefundRelease(null); };

  // Dismiss-pending-refund — clears an OP IOU WITHOUT moving money, for refunds
  // already done out-of-band (HireHop / Stripe / bank direct) or artifacts.
  // Distinct from "Process refund" which actually sends money.
  const [dismissRefund, setDismissRefund] = useState<NonNullable<FinancialData['financial']['pending_refunds']>[number] | null>(null);
  const [dismissReason, setDismissReason] = useState('refunded_externally');
  const [dismissNotes, setDismissNotes] = useState('');
  const [dismissLoading, setDismissLoading] = useState(false);
  const [dismissError, setDismissError] = useState('');

  const openDismissRefundModal = (pr: NonNullable<FinancialData['financial']['pending_refunds']>[number]) => {
    setDismissRefund(pr);
    setDismissReason('refunded_externally');
    setDismissNotes('');
    setDismissError('');
  };

  const submitDismissRefund = async () => {
    if (!dismissRefund) return;
    setDismissLoading(true);
    setDismissError('');
    try {
      await api.post(`/money/${jobId}/dismiss-refund`, {
        refund_id: dismissRefund.id,
        reason: dismissReason,
        notes: dismissNotes.trim() || null,
      });
      setDismissRefund(null);
      loadData();
    } catch (e) {
      setDismissError(e instanceof Error ? e.message : 'Failed to clear refund');
    } finally {
      setDismissLoading(false);
    }
  };

  // When the staff member changes the deposit to refund against, default the
  // method to match that deposit (Stripe if it was a Stripe deposit).
  const onPendingDepositChange = (depId: number) => {
    setPendingDepositId(depId);
    setRefundRelease(null);   // plan belonged to the previous deposit
    const dep = refundableDeposits.find(d => d.id === depId);
    setRefundMethod(dep?.stripe_payment_intent ? 'stripe_gbp' : (dep?.op_payment_method as typeof refundMethod) || 'worldpay');
  };

  const submitPendingRefund = async (allowRelease = false) => {
    if (!pendingRefund) return;
    if (!pendingDepositId) {
      setRefundError('Pick which deposit to refund against');
      return;
    }
    const parsed = parseFloat(refundAmount);
    if (isNaN(parsed) || parsed < 0.01) {
      setRefundError('Enter a valid amount (£0.01 or more)');
      return;
    }
    setRefundLoading(true);
    setRefundError('');
    try {
      const resp = await api.post<{
        data: unknown; stripe_refund_id?: string; hh_push_error?: string | null;
        client_email?: { sent: boolean; toEmail?: string; isFallback?: boolean; error?: string } | null;
      }>(
        `/money/${jobId}/refund-payment`,
        {
          hh_deposit_id: pendingDepositId,
          amount: parsed,
          method: refundMethod,
          reference: refundReference.trim() || null,
          notes: refundNotes.trim() || null,
          pending_refund_id: pendingRefund.id,
          ...(allowRelease ? { allow_release: true } : {}),
          // Sent regardless of method; the backend ignores it on the Stripe
          // path, which always emails.
          notify_client: refundNotifyClient,
        }
      );
      setRefundRelease(null);
      setRefundResult({
        stripe_refund_id: resp.stripe_refund_id,
        hh_push_error: resp.hh_push_error || null,
        client_email: resp.client_email || null,
      });
    } catch (e) {
      // Same release-consent branch as the payment-history refund — a
      // cancellation IOU pointed at a fully-applied deposit hits exactly the
      // same 370, and a dead-end error here would strand the IOU.
      const body = (e as { body?: Record<string, unknown> })?.body;
      if (body?.code === 'release_required' && body.release) {
        setRefundRelease(body.release as ReleasePlan);
        setRefundError('');
      } else {
        setRefundRelease(null);
        setRefundError(e instanceof Error ? e.message : 'Refund failed');
      }
    } finally {
      setRefundLoading(false);
    }
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.get<{ data: FinancialData }>(`/money/${jobId}/summary`);
      setData(result.data);
    } catch (err: any) {
      setError(err.message || 'Failed to load financial data');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  // Business-level balance override (migration 117) — admin marks the HH-derived
  // balance as settled in Xero / written off. Doesn't touch HireHop or Xero.
  const submitResolveBalance = async () => {
    setBalSaving(true); setBalError('');
    try {
      await api.post(`/money/${jobId}/resolve-balance`, { reason: balReason, notes: balNotes || null });
      setShowResolveBalance(false); setBalNotes('');
      await loadData();
    } catch (e) {
      setBalError(e instanceof Error ? e.message : 'Failed to resolve');
    } finally {
      setBalSaving(false);
    }
  };
  const undoResolveBalance = async () => {
    try {
      await api.delete(`/money/${jobId}/resolve-balance`);
      await loadData();
    } catch (e) {
      setBalError(e instanceof Error ? e.message : 'Failed to undo');
    }
  };

  useEffect(() => { loadData(); }, [loadData]);

  // Fetch rollover chains for any record that's part of one (rolled over, or
  // came in via rollover). Lazy + best-effort; only records that need the thread.
  useEffect(() => {
    const records = data?.excess?.records || [];
    const needChain = records.filter((r: JobExcess) =>
      r.excess_status === 'rolled_over' || (r as { payment_method?: string }).payment_method === 'rolled_over'
    );
    needChain.forEach((r: JobExcess) => {
      if (rolloverChains[r.id]) return;
      api.get<{ data: { chain: ChainEntry[] } }>(`/excess/${r.id}/rollover-chain`)
        .then((resp) => {
          if (resp.data.chain && resp.data.chain.length > 1) {
            setRolloverChains((prev) => ({ ...prev, [r.id]: resp.data.chain }));
          }
        })
        .catch(() => {});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Job costs + quotes for the quoted-vs-actual panel. Best-effort, non-blocking.
  const loadJobCosts = useCallback(async () => {
    try {
      const [costsRes, quotesRes] = await Promise.all([
        api.get<{ data: JobCostLite[] }>(`/costs/by-job/${jobId}`).catch(() => ({ data: [] })),
        api.get<{ data: JobQuoteLite[] }>(`/quotes?job_id=${jobId}`).catch(() => ({ data: [] })),
      ]);
      setJobCosts(costsRes.data || []);
      setJobQuotes(quotesRes.data || []);
    } catch { /* non-blocking */ }
  }, [jobId]);

  useEffect(() => { loadJobCosts(); }, [loadJobCosts]);

  // Escape key closes payment modal
  useEffect(() => {
    if (!showPaymentForm) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowPaymentForm(false);
        setPayHHPushError(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showPaymentForm]);

  async function handleRecordPayment(typeOverride?: string) {
    if (!payAmount || parseFloat(payAmount) <= 0) {
      setPayError('Enter a valid amount');
      return;
    }
    setPayLoading(true);
    setPayError('');
    setPayHHPushError(null);
    try {
      const isExcess = (typeOverride === 'excess' || payType === 'excess');
      let excessId = isExcess ? payExcessId : undefined;

      // If recording excess but no excess record selected, look for one on the
      // job (any status — including 'taken' for top-ups) before falling back
      // to creating a new one. The previous filter excluded 'taken' records,
      // which led to phantom auto-create promises in the UI.
      if (isExcess && !excessId) {
        const existing = data?.excess?.records || [];
        if (existing.length > 0) {
          // Prefer pre-collection records (needed/partially_paid) but fall
          // back to most recent so top-ups link correctly.
          const sorted = [...existing].sort((a, b) => {
            const aPriority = ['needed', 'pending', 'partially_paid', 'partial'].includes(a.excess_status) ? 0 : 1;
            const bPriority = ['needed', 'pending', 'partially_paid', 'partial'].includes(b.excess_status) ? 0 : 1;
            if (aPriority !== bPriority) return aPriority - bPriority;
            return new Date(b.updated_at || b.created_at || 0).getTime()
                 - new Date(a.updated_at || a.created_at || 0).getTime();
          });
          excessId = sorted[0]!.id;
        } else {
          // Genuinely no excess record on the job — create one with this
          // payment as the seed required amount.
          const createResult = await api.post<{ data: { id: string } }>('/excess/create', {
            job_id: jobId,
            excess_amount_required: parseFloat(payAmount),
            excess_calculation_basis: 'Manual entry from Money tab',
            client_name: job.client_name || job.company_name || undefined,
          });
          excessId = createResult.data.id;
        }
      }

      // For excess payments, send `total_collected` (absolute) so the backend
      // computes the delta. The amount field stays as the user-entered
      // delta-style "money taking" — backend converts.
      const body: Record<string, unknown> = {
        payment_type: typeOverride || payType,
        payment_method: payMethod,
        payment_reference: payRef || undefined,
        notes: payNotes || undefined,
        excess_id: excessId || undefined,
        push_to_hirehop: payPushToHH,
        amount: parseFloat(payAmount),
      };
      // If this is an excess top-up against an existing record, also send
      // total_collected so re-submits are idempotent.
      if (isExcess && excessId) {
        const rec = data?.excess?.records?.find((r) => r.id === excessId);
        if (rec) {
          const previousTaken = Number(rec.excess_amount_taken || 0);
          body.total_collected = previousTaken + parseFloat(payAmount);
        }
      }

      const resp = await api.post<{ data: any; hh_push_error?: string | null }>(
        `/money/${jobId}/record-payment`,
        body
      );

      if (resp.hh_push_error) {
        // OP recorded the payment, but HH push failed. Keep modal open so the
        // user can manually link in HH. The OP record is correct either way.
        setPayHHPushError(resp.hh_push_error);
        loadData();
        onJobChanged?.();
        return;
      }

      setShowPaymentForm(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      setPayExcessId('');
      loadData();
      onJobChanged?.(); // Refresh parent job data (status may have changed)
    } catch (err: any) {
      setPayError(err.message || 'Failed to record payment');
    } finally {
      setPayLoading(false);
    }
  }

  // Step 1 — pick the record. Pre-fill the resulting total as "what's already
  // collected + this deposit", which is right for genuinely new money and
  // obvious to correct when it isn't.
  function handlePickLinkTarget(record: JobExcess) {
    if (!linkingDeposit) return;
    const already = Number(record.excess_amount_taken || 0);
    setLinkTarget(record);
    setLinkTotal((already + Number(linkingDeposit.amount)).toFixed(2));
  }

  // Step 2 — confirm the total. Sends total_collected (absolute), never a delta.
  async function handleLinkDeposit() {
    if (!linkingDeposit || !linkTarget) return;
    const total = parseFloat(linkTotal);
    if (isNaN(total) || total < 0) {
      alert('Enter the total collected on this record after linking.');
      return;
    }
    setLinkLoading(true);
    try {
      await api.post(`/excess/${linkTarget.id}/link-deposit`, {
        hh_deposit_id: linkingDeposit.hh_deposit_id,
        total_collected: total,
      });
      setLinkingDeposit(null);
      setLinkTarget(null);
      setLinkTotal('');
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to link deposit');
    } finally {
      setLinkLoading(false);
    }
  }

  async function handleCreateAndLinkExcess() {
    if (!linkingDeposit) return;
    setLinkLoading(true);
    try {
      // Create a new excess record pre-linked to the HH deposit (no push back to HH)
      await api.post<{ data: { id: string } }>('/excess/create-from-hh', {
        job_id: jobId,
        hh_deposit_id: linkingDeposit.hh_deposit_id,
        amount: linkingDeposit.amount,
        client_name: job.client_name || job.company_name || undefined,
      });
      setLinkingDeposit(null);
      loadData();
    } catch (err: any) {
      alert(err.message || 'Failed to create excess record');
    } finally {
      setLinkLoading(false);
    }
  }

  // Create a manual excess record (£1,200 standard floor) and drop straight into
  // the Manage modal, where the full lifecycle lives — payment, pre-auth hold,
  // waive, rollover. This is the only "create from scratch" path now the Money
  // tab's Record Payment form is hire-payments-only; it's only surfaced when the
  // job has no excess record yet (derivation auto-creates one for self-drive).
  async function handleAddExcessRecord() {
    try {
      const res = await api.post<{ data: JobExcess }>('/excess/create', {
        job_id: jobId,
        excess_amount_required: 1200,
        excess_calculation_basis: 'Manual entry from Money tab',
      });
      await loadData();
      setActionExcess(res.data);
    } catch (err: any) {
      alert(err.message || 'Failed to create excess record');
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">
        {error || 'Failed to load financial data'}
      </div>
    );
  }

  const { financial, excess, client_balance_on_account } = data;
  const depositPercent = financial.hire_value_inc_vat > 0
    ? Math.min(100, ((financial.total_hire_deposits + (financial.credit_note_write_off || 0)) / financial.hire_value_inc_vat) * 100)
    : 0;

  /*
   * Excess is charged per HIRE (per van, top-N drivers), but stored per DRIVER
   * — so a 2-driver/1-van job used to render two cards, the second reading
   * "Required: £0.00 · Collected: £0.00 · Covered", which says nothing.
   *
   * Collapse instead of hide. A `not_required` row still answers a real
   * question ("did we forget to take an excess off Lewis?" — no, deliberately),
   * so the covered drivers are NAMED on the chargeable row for their van rather
   * than deleted. Nothing is silently dropped: covered rows whose van doesn't
   * match a chargeable row fall through to `orphanCovered` below.
   *
   * The Drivers & Vehicles tab deliberately still shows excess per driver —
   * there it means the driver's PERSONAL liability (£1,200 if they prang it),
   * which is a different fact and stays true whoever holds the money.
   */
  const coveredRecords = excess.records.filter((r) => r.excess_status === 'not_required');
  const chargeableRecords = excess.records.filter((r) => r.excess_status !== 'not_required');
  const coveredName = (r: JobExcess) => r.driver_name || r.client_name || 'Unnamed driver';
  /*
   * Attribution is JOB-level, not per-van — because the top-N ranking is. The
   * rule is "the N highest driver liabilities on the hire, where N = van
   * count", not "the highest driver on each van", and drivers on a multi-van
   * hire can drive any of its vans. Matching covered drivers to a chargeable
   * row by registration therefore asserted a pairing the algorithm never made.
   * With one chargeable row we fold the covered names onto it; with several we
   * list them once beneath, rather than repeating them on each.
   */
  const soleChargeable = chargeableRecords.length === 1 ? chargeableRecords[0] : null;

  return (
    <div className="space-y-6">
      {/* Financial Summary */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Financial Summary</h3>
          <button
            onClick={() => setShowPaymentForm(true)}
            className="px-3 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md"
          >
            Record Payment
          </button>
        </div>

        {financial.hire_value_ex_vat > 0 ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-xs text-gray-500">Hire Value (ex VAT)</p>
                <p className="text-lg font-bold text-gray-900">£{financial.hire_value_ex_vat.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">
                  VAT{financial.vat_adjusted && <span className="text-amber-600"> (adjusted)</span>}
                </p>
                <p className="text-lg font-bold text-gray-900">
                  £{financial.vat_amount.toFixed(2)}
                  {financial.vat_adjusted && financial.original_vat_amount != null && (
                    <span className="text-xs font-normal text-gray-400 line-through ml-1">£{financial.original_vat_amount.toFixed(2)}</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Total (inc VAT)</p>
                <p className="text-lg font-bold text-gray-900">
                  £{financial.hire_value_inc_vat.toFixed(2)}
                  {financial.vat_adjusted && financial.original_hire_value_inc_vat != null && (
                    <span className="text-xs font-normal text-gray-400 line-through ml-1">£{financial.original_hire_value_inc_vat.toFixed(2)}</span>
                  )}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Hire Deposits</p>
                <p className="text-lg font-bold text-green-700">£{financial.total_hire_deposits.toFixed(2)}</p>
              </div>
            </div>

            {/* Payment progress bar */}
            <div className="mb-2">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <div className="flex items-center gap-2">
                  <span>Payment Progress</span>
                  {(() => {
                    const state = getPaymentState(financial);
                    return (
                      <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium uppercase tracking-wider ${PAYMENT_STATE_CLASSES[state].pill}`}>
                        {PAYMENT_STATE_LABELS[state]}
                      </span>
                    );
                  })()}
                </div>
                <span>{depositPercent.toFixed(0)}% paid</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5">
                <div
                  className={`h-2.5 rounded-full transition-all ${
                    depositPercent >= 100 ? 'bg-green-500' : depositPercent >= 50 ? 'bg-ooosh-500' : 'bg-amber-500'
                  }`}
                  style={{ width: `${depositPercent}%` }}
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className={`text-sm font-semibold ${financial.balance_override ? 'text-gray-400 line-through' : hasOutstanding(financial.balance_outstanding) ? 'text-red-600' : 'text-green-600'}`}>
                Balance Outstanding: £{financial.balance_outstanding.toFixed(2)}
              </p>
              {/* Admin: resolve a stray HH balance the business considers settled
                  (Xero source of truth). Only when there's a balance + not already
                  resolved. */}
              {isAdmin && !financial.balance_override && hasOutstanding(financial.balance_outstanding) && (
                <button
                  onClick={() => { setBalError(''); setShowResolveBalance(true); }}
                  className="text-xs text-gray-500 hover:text-ooosh-700 underline"
                >Resolve balance…</button>
              )}
            </div>

            {/* Credit notes, ALWAYS shown when there are any. Previously this
                line was keyed on `credit_note_write_off`, which clamps to zero
                on a job whose deposits already cover the invoice — so job
                15187's £120 goodwill credit note was read, sent to the browser,
                and then rendered nowhere. A credit note is a thing that
                happened to this job's money; staff should see it either way. */}
            {(financial.total_credit_notes ?? 0) > 0.009 && (
              <p className="text-xs text-gray-500 mt-0.5">
                £{(financial.total_credit_notes as number).toFixed(2)} credited by credit note in HireHop
                {(financial.credit_note_write_off ?? 0) > 0.009
                  && ` — £${(financial.credit_note_write_off as number).toFixed(2)} of it written off against this balance`}
              </p>
            )}

            {/* Client is OWED money. The balance line above can't say this: it
                clamps at zero, so an overpaid job reads "PAID IN FULL · £0.00"
                — which is what OP told us on 15628 (£91.12 already refunded in
                Stripe, invisible) and still tells us on 15187 (£120 goodwill
                credit, unrefunded). Taken from HireHop's own invoice `owing`,
                so it disappears by itself once the refund is made. */}
            {(financial.client_overpaid ?? 0) > 0.009 && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-300 rounded-lg">
                <p className="text-sm font-semibold text-amber-900">
                  Client is owed £{(financial.client_overpaid as number).toFixed(2)}
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  HireHop shows this much overpaid on the invoice — usually a credit note raised after payment.
                  Refund it from Payment History below; this note clears itself once the refund lands.
                </p>
              </div>
            )}

            {/* Business-override banner — shown to everyone so staff understand
                why HireHop still shows money owed. */}
            {financial.balance_override && (
              <div className="mt-2 p-3 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 flex items-start justify-between gap-3">
                <div>
                  <span className="font-semibold text-gray-700">Balance resolved (business adjustment)</span>
                  {' — '}{BALANCE_REASON_LABEL[financial.balance_override.reason] || financial.balance_override.reason}.
                  {financial.balance_override.notes && <span className="block mt-0.5 text-gray-500">{financial.balance_override.notes}</span>}
                  <span className="block mt-0.5 text-gray-400">
                    {financial.balance_override.resolved_by_name || '—'}
                    {financial.balance_override.resolved_at && ` · ${new Date(financial.balance_override.resolved_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                    {' · HireHop figure left untouched'}
                  </span>
                </div>
                {isAdmin && (
                  <button onClick={undoResolveBalance} className="text-[11px] text-gray-400 hover:text-red-600 underline whitespace-nowrap">Undo</button>
                )}
              </div>
            )}
            {balError && <p className="text-xs text-red-600 mt-1">{balError}</p>}

            {/* Deposit to Secure info */}
            {financial.hire_value_inc_vat > 0 && !financial.deposit_paid && (
              <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <p className="text-xs font-semibold text-blue-800 uppercase tracking-wider mb-1">Deposit to Secure</p>
                <p className="text-sm text-blue-700">
                  {financial.hire_value_inc_vat < 400
                    ? `Full payment required: £${financial.hire_value_inc_vat.toFixed(2)} (jobs under £400)`
                    : <>
                        Minimum deposit (25%): <span className="font-bold">£{financial.required_deposit.toFixed(2)}</span>
                        {' · '}Half: £{(financial.hire_value_inc_vat * 0.5).toFixed(2)}
                        {' · '}Full: £{financial.hire_value_inc_vat.toFixed(2)}
                      </>
                  }
                </p>
              </div>
            )}
            {financial.deposit_paid && hasOutstanding(financial.balance_outstanding) && (
              <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
                <p className="text-xs text-green-700">
                  Deposit secured. Remaining balance: <span className="font-semibold">£{financial.balance_outstanding.toFixed(2)}</span>
                </p>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">
            {job.hh_job_number
              ? 'No billing data available from HireHop yet.'
              : 'Job not linked to HireHop — no financial data available.'}
          </p>
        )}
      </div>

      {/* VAT Adjustment (international hires) */}
      {data.vat_adjustment && (
        <div className="bg-white rounded-xl shadow-sm border border-amber-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">International VAT Adjustment</h3>
          <p className="text-xs text-gray-500 mb-4">{data.vat_adjustment.explanationText}</p>

          <div className="grid grid-cols-3 gap-2 text-sm mb-4">
            <div className="text-center p-2 bg-gray-50 rounded">
              <p className="text-xs text-gray-500">Total days</p>
              <p className="font-bold">{data.vat_adjustment.hireDays}</p>
            </div>
            <div className="text-center p-2 bg-gray-50 rounded">
              <p className="text-xs text-gray-500">UK days</p>
              <p className="font-bold">{data.vat_adjustment.ukDays}</p>
            </div>
            <div className="text-center p-2 bg-gray-50 rounded">
              <p className="text-xs text-gray-500">Non-UK days</p>
              <p className="font-bold">{data.vat_adjustment.nonUkDays}</p>
            </div>
          </div>

          <table className="w-full text-sm mb-4">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-1.5 text-xs font-medium text-gray-500">Category</th>
                <th className="text-right py-1.5 text-xs font-medium text-gray-500">Net</th>
                <th className="text-right py-1.5 text-xs font-medium text-gray-500">VAT</th>
                <th className="text-right py-1.5 text-xs font-medium text-gray-500">Gross</th>
              </tr>
            </thead>
            <tbody>
              {data.vat_adjustment.breakdown.map((cat) => (
                <tr key={cat.category} className="border-b border-gray-100">
                  <td className="py-1.5 text-gray-700">
                    {cat.category}
                    <p className="text-[10px] text-gray-400">{cat.rule}</p>
                  </td>
                  <td className="py-1.5 text-right text-gray-600">{'\u00A3'}{cat.subtotalNet.toFixed(2)}</td>
                  <td className="py-1.5 text-right text-gray-600">{'\u00A3'}{cat.subtotalVat.toFixed(2)}</td>
                  <td className="py-1.5 text-right font-medium">{'\u00A3'}{cat.subtotalGross.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="flex items-center justify-between p-3 bg-green-50 border border-green-200 rounded-lg">
            <div>
              <p className="text-sm text-green-800">
                Adjusted total: <strong>{'\u00A3'}{data.vat_adjustment.adjustedTotal.toFixed(2)}</strong>
              </p>
              <p className="text-xs text-green-600">
                Standard total: {'\u00A3'}{data.vat_adjustment.originalTotalIncVat.toFixed(2)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-bold text-green-700">{'\u00A3'}{data.vat_adjustment.vatSaved.toFixed(2)}</p>
              <p className="text-xs text-green-600">VAT saved</p>
            </div>
          </div>
        </div>
      )}

      {/* Insurance Excess */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Insurance Excess</h3>
        {/* Under-collected: a higher-risk driver joined after the money had
            already been taken on someone else's record, so the correct top-N
            can't be applied without stranding a deposit. Warn, never auto-move
            — same convention as referral authorise. */}
        {excess.topn_shortfall && (
          <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3">
            <p className="text-sm font-semibold text-red-800">
              This hire is under-collected by £{excess.topn_shortfall.short.toFixed(2)}
            </p>
            <p className="text-xs text-red-700 mt-1">
              {excess.topn_shortfall.drivers.join(' and ')}{' '}
              {excess.topn_shortfall.drivers.length === 1 ? 'carries' : 'carry'} a higher excess than the
              driver holding the charge, so the hire should total £{excess.topn_shortfall.correctTotal.toFixed(2)}
              {' '}rather than £{excess.topn_shortfall.chargeableTotal.toFixed(2)}. The money already collected
              can't be moved automatically — collect the difference, or adjust the required amount if you've
              agreed otherwise.
            </p>
          </div>
        )}
        {chargeableRecords.length > 0 ? (
          <div className="space-y-3">
            {chargeableRecords.map((record) => {
              // Where this record's money finally ended up, when it rolled
              // forward and a later hire settled it. Null while the chain is
              // still live — then the record's own status is the whole truth.
              const chainOutcome = rolloverChains[record.id]
                ? resolveChainOutcome(rolloverChains[record.id], record.id)
                : null;
              return (
              <div
                key={record.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    {/* A closed rollover chain headlines its OUTCOME, coloured
                        by the settled state, rather than a purple "Rolled Over"
                        that outlived the money (job 16371 → #16605). The arrow
                        keeps this hire's own fact — the money left here — which
                        replacing the label outright would have thrown away. */}
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${chainOutcome ? statusColor(chainOutcome.excess_status) : statusColor(record.excess_status, record.auto_covered)}`}
                      title={chainOutcome
                        ? `Rolled forward to job #${chainOutcome.hh_job_number ?? '—'}, where it was ${statusLabel(chainOutcome.excess_status).toLowerCase()}.`
                        : undefined}
                    >
                      {statusLabel(record.excess_status, record.auto_covered)}
                      {chainOutcome && ` → ${statusLabel(chainOutcome.excess_status)}`}
                    </span>
                    {record.hh_deposit_id && (
                      <span className="text-[10px] text-green-600 font-medium" title={`HH Deposit #${record.hh_deposit_id} (${record.hh_reconcile_source || 'linked'})`}>
                        HH linked
                      </span>
                    )}
                    {record.held_on_account && (record.excess_status === 'taken' || record.excess_status === 'partially_paid') && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-700" title="Deliberately held on account for the client's next hire — still held, refundable, or applicable to a future hire.">
                        Held on account
                      </span>
                    )}
                    {record.dispatch_override && (
                      <span className="text-[10px] text-amber-600 font-medium">overridden</span>
                    )}
                    {record.suggested_collection_method === 'pre_auth' && (record.excess_status === 'needed' || record.excess_status === 'pending') && (
                      <span className="text-[10px] text-blue-600 font-medium">pre-auth suggested</span>
                    )}
                    {record.dispute_status && (
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${record.dispute_status === 'open' ? 'bg-red-100 text-red-700' : record.dispute_status === 'lost' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'}`}>
                        {record.dispute_status === 'open' ? '⚠ Chargeback' : `Chargeback ${record.dispute_status}`}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-900 mt-1">
                    {record.driver_name || record.client_name || 'Job-level excess'}
                    {record.vehicle_reg && ` — ${record.vehicle_reg}`}
                  </p>
                  {/* Money line. Zero-value fields are SUPPRESSED — "Collected:
                      £0.00" is noise next to a REQUIRED pill that already says
                      nothing has been collected. "Required" is also renamed to
                      "Excess" here so the word only appears in one place (it was
                      doing double duty as both a field label and a status). */}
                  <p className="text-xs text-gray-500">
                    Excess: {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
                    {isNonZero(record.amount_held) ? (
                      <>
                        {' · '}
                        <span className="text-sky-700">Held: £{Number(record.amount_held).toFixed(2)}</span>
                      </>
                    ) : isNonZero(record.excess_amount_taken) ? (
                      <>
                        {' · '}
                        {/* A rolled-over record's payment_date is the day the
                            rollover was APPLIED, not when the cash arrived — it
                            landed on the origin hire, possibly weeks earlier.
                            Saying "Collected on <that date>" was a plain untruth
                            (job 16605). The breadcrumb below names the origin. */}
                        {record.payment_method === 'rolled_over' ? 'Carried over: ' : 'Collected: '}
                        £{Number(record.excess_amount_taken).toFixed(2)}
                        {record.payment_date &&
                          ` on ${new Date(record.payment_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                        {record.payment_method && record.payment_method !== 'rolled_over' &&
                          ` · ${paymentMethodLabel(record.payment_method)}`}
                      </>
                    ) : null}
                    {isNonZero(record.amount_released) && (
                      <>
                        {' · '}
                        <span className="text-gray-500">Released: £{Number(record.amount_released).toFixed(2)}</span>
                      </>
                    )}
                  </p>
                  {/* Outcome line — the answer to "so where did my money go?".
                      The money line above is about THIS hire and reads as if the
                      cash is still sitting here; this says where it actually
                      went and how it ended, with the amount and date the
                      rollover-thread breadcrumb below can't carry. */}
                  {chainOutcome && (() => {
                    const settledAmount = chainOutcomeAmount(chainOutcome);
                    const settledDate = chainOutcome.reimbursement_date
                      ? new Date(chainOutcome.reimbursement_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                      : null;
                    const outcomeWord = statusLabel(chainOutcome.excess_status).toLowerCase();
                    const jobLabel = `#${chainOutcome.hh_job_number ?? '—'}`;
                    return (
                      <p className="text-xs text-gray-600 mt-0.5">
                        <span aria-hidden="true">→ </span>
                        Carried to{' '}
                        {chainOutcome.job_id ? (
                          <Link
                            to={`/jobs/${chainOutcome.job_id}`}
                            title={chainOutcome.job_name || undefined}
                            className="underline decoration-dotted hover:text-gray-900"
                          >
                            {jobLabel}
                          </Link>
                        ) : (
                          jobLabel
                        )}
                        {' — '}{outcomeWord}
                        {settledAmount != null && ` £${settledAmount.toFixed(2)}`}
                        {settledDate && ` on ${settledDate}`}
                      </p>
                    );
                  })()}
                  {/* Covered drivers, folded onto the row that actually carries
                      the money for their van. */}
                  {soleChargeable?.id === record.id && coveredRecords.length > 0 && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      Also covered by this excess: {coveredRecords.map(coveredName).join(', ')}
                    </p>
                  )}
                  {/* Resolution breakdown — what actually happened to collected
                      excess. Without this the card showed only collected vs
                      required, hiding claim/reimburse splits (job 15291). */}
                  {(Number(record.claim_amount || 0) > 0 || Number(record.reimbursement_amount || 0) > 0) && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {Number(record.claim_amount || 0) > 0 && (
                        <span className="text-orange-700">Claimed to invoice: £{Number(record.claim_amount).toFixed(2)}</span>
                      )}
                      {Number(record.claim_amount || 0) > 0 && Number(record.reimbursement_amount || 0) > 0 && ' · '}
                      {Number(record.reimbursement_amount || 0) > 0 && (
                        <span className="text-emerald-700">
                          Reimbursed: £{Number(record.reimbursement_amount).toFixed(2)}
                          {record.reimbursement_date && ` on ${new Date(record.reimbursement_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                          {record.reimbursement_method && ` (${paymentMethodLabel(record.reimbursement_method)})`}
                        </span>
                      )}
                    </p>
                  )}
                  {/* Rollover chain — "follow the thread". Shows the money's
                      journey across jobs (#A → #B → #C), current job highlighted,
                      until it's finally reimbursed/claimed. */}
                  {rolloverChains[record.id] && rolloverChains[record.id].length > 1 && (() => {
                    const chain = rolloverChains[record.id];
                    /* The ORIGIN is the hire the cash actually landed on — the
                       earliest hop that took money in its own right rather than
                       inheriting it. Naming it is the whole point: without it a
                       child hire reads "Taken £1,200" with no clue that the
                       money is sitting on a different job (#16605 / #16371). */
                    const origin = chain.find(
                      (l) => l.payment_method !== 'rolled_over' && Number(l.excess_amount_taken || 0) > 0,
                    ) || chain[0];
                    const originDate = origin?.payment_date
                      ? new Date(origin.payment_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
                      : null;
                    return (
                      <div className="text-xs text-purple-700 mt-1">
                        <p className="flex flex-wrap items-center gap-1">
                          <span className="font-medium">↪ Rollover thread:</span>
                          {chain.map((link, i) => {
                            const isHere = link.id === record.id;
                            const isOrigin = origin && link.id === origin.id;
                            const label = (
                              <>
                                {isOrigin && <span title="The hire the money was originally taken on">💷 </span>}
                                #{link.hh_job_number ?? '—'}{' '}
                                <span className="text-purple-400">
                                  ({isHere ? 'here' : statusLabel(link.excess_status)})
                                </span>
                              </>
                            );
                            return (
                              <span key={link.id} className="flex items-center gap-1">
                                {i > 0 && <span className="text-purple-300">→</span>}
                                {/* Each hop links to its own job's Money tab so
                                    staff can jump straight to wherever the money
                                    actually is, rather than searching for it. */}
                                {link.job_id && !isHere ? (
                                  <Link
                                    to={`/jobs/${link.job_id}`}
                                    title={link.job_name || undefined}
                                    className="underline decoration-dotted hover:text-purple-900"
                                  >
                                    {label}
                                  </Link>
                                ) : (
                                  <span
                                    className={isHere ? 'font-semibold underline decoration-dotted' : ''}
                                    title={link.job_name || undefined}
                                  >
                                    {label}
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </p>
                        {origin && origin.id !== record.id && Number(origin.excess_amount_taken || 0) > 0 && (
                          <p className="text-purple-500 mt-0.5">
                            Money originally taken on{' '}
                            {origin.job_id ? (
                              <Link to={`/jobs/${origin.job_id}`} className="underline decoration-dotted hover:text-purple-900">
                                #{origin.hh_job_number ?? '—'}
                              </Link>
                            ) : (
                              <>#{origin.hh_job_number ?? '—'}</>
                            )}
                            {originDate && ` on ${originDate}`}
                            {origin.payment_method && origin.payment_method !== 'rolled_over' &&
                              ` · ${paymentMethodLabel(origin.payment_method)}`}
                          </p>
                        )}
                      </div>
                    );
                  })()}
                  {(record.excess_status === 'pre_auth' || record.excess_status === 'released') && (() => {
                    // Shared wording — see lib/preauth.ts. Binary held/released,
                    // never a "maybe"; the server-side self-heal resolves a stuck
                    // past-expiry hold to its true state on this tab's load.
                    const d = describePreauth(record);
                    if (!d.compact) return null;
                    const cls = d.isHold
                      ? (d.pastExpiry ? 'text-amber-600' : 'text-sky-600')
                      : 'text-gray-500';
                    return (
                      <p className={`text-[11px] mt-0.5 font-medium ${cls}`}>
                        {d.compact}{record.payment_method ? ` · ${paymentMethodLabel(record.payment_method)}` : ''}
                      </p>
                    );
                  })()}
                </div>
                {/* "Covered" (not_required) records are £0 top-N siblings —
                    nothing actionable, so no Manage button. */}
                {record.excess_status !== 'not_required' && (
                  <button
                    onClick={() => setActionExcess(record)}
                    className="px-3 py-1.5 text-xs font-medium text-ooosh-600 hover:text-ooosh-800 border border-ooosh-200 rounded-md hover:bg-ooosh-50"
                  >
                    Manage
                  </button>
                )}
              </div>
              );
            })}
            {/* Covered rows whose van doesn't match any chargeable row (a swap,
                a deleted record, a job-level excess with no reg). Shown rather
                than dropped — collapsing must never lose a driver. */}
            {!soleChargeable && coveredRecords.length > 0 && (
              <p className="text-xs text-gray-500 px-1">
                Also covered on this hire: {coveredRecords.map(coveredName).join(', ')}
              </p>
            )}
          </div>
        ) : coveredRecords.length > 0 ? (
          /* Every record on the job is a £0 "covered" row — an internal job, a
             Van & Driver hire, or a top-N result with nothing chargeable. This
             is NOT "no excess tracked": showing the empty state here invited
             staff to create a spurious record. Say what's actually true. */
          <div className="text-sm text-gray-500">
            <p>
              No excess chargeable on this hire.{' '}
              <span className="text-gray-400">
                {coveredRecords.length} driver{coveredRecords.length === 1 ? '' : 's'} covered:{' '}
                {coveredRecords.map(coveredName).join(', ')}
              </span>
            </p>
          </div>
        ) : (
          <div className="text-sm text-gray-500">
            <p className="mb-3">No insurance excess tracked for this job yet.</p>
            <button
              onClick={handleAddExcessRecord}
              className="px-3 py-1.5 text-xs font-medium text-ooosh-600 hover:text-ooosh-800 border border-ooosh-200 rounded-md hover:bg-ooosh-50"
            >
              + Add excess record
            </button>
          </div>
        )}

        {/* Unmatched HH excess deposits — need manual linking */}
        {data.reconciliation && data.reconciliation.unmatched_hh_deposits.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-200">
            <p className="text-xs font-medium text-amber-700 mb-2">
              Excess deposits found in HireHop not yet linked to an OP record:
            </p>
            <div className="space-y-2">
              {data.reconciliation.unmatched_hh_deposits.map((dep) => (
                <div key={dep.hh_deposit_id} className="flex items-center justify-between p-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <div>
                    <p className="text-sm text-gray-800">
                      £{Number(dep.amount).toFixed(2)}
                      {dep.bank_name && <span className="text-gray-500"> via {dep.bank_name}</span>}
                    </p>
                    <p className="text-xs text-gray-500">
                      {dep.date ? new Date(dep.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
                      {dep.description && ` — ${dep.description}`}
                    </p>
                  </div>
                  {/* Must match the picker's source (chargeableRecords) or the
                      button opens an empty modal. */}
                  {chargeableRecords.length > 0 ? (
                    <button
                      onClick={() => setLinkingDeposit({ hh_deposit_id: dep.hh_deposit_id, amount: dep.amount })}
                      className="px-2.5 py-1 text-xs font-medium text-amber-700 hover:text-amber-900 border border-amber-300 rounded-md hover:bg-amber-100"
                    >
                      Link to Excess
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">No excess record to link to</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-reconciliation results */}
        {data.reconciliation && data.reconciliation.actions.length > 0 && (
          <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-xs text-green-700">
              {data.reconciliation.actions.length} HireHop deposit{data.reconciliation.actions.length > 1 ? 's' : ''} automatically linked to excess record{data.reconciliation.actions.length > 1 ? 's' : ''}.
            </p>
          </div>
        )}
      </div>

      {/* Link Deposit to Excess modal */}
      {linkingDeposit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setLinkingDeposit(null); setLinkTarget(null); }}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Link HH Deposit to Excess Record</h3>
            <p className="text-sm text-gray-600 mb-4">
              HireHop deposit <strong>#{linkingDeposit.hh_deposit_id}</strong> for <strong>£{Number(linkingDeposit.amount).toFixed(2)}</strong>.
              {linkTarget ? ' Confirm the total collected:' : ' Select which excess record to link it to:'}
            </p>

            {/* Step 2 — confirm the resulting total. Linking is bookkeeping, and
                a HireHop deposit showing as "unlinked" is often money OP has
                already counted, so the number is always shown and always
                editable rather than being added behind the scenes. */}
            {linkTarget ? (
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-900">
                  {linkTarget.driver_name || linkTarget.client_name || 'Job-level excess'}
                  {linkTarget.vehicle_reg && ` — ${linkTarget.vehicle_reg}`}
                </p>
                <p className="text-xs text-gray-500 mb-3">
                  Already collected on this record: £{Number(linkTarget.excess_amount_taken || 0).toFixed(2)}
                  {linkTarget.hh_deposit_id && ` · currently linked to HH deposit #${linkTarget.hh_deposit_id}`}
                </p>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Total collected after linking
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">£</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={linkTotal}
                    onChange={(e) => setLinkTotal(e.target.value)}
                    className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-ooosh-500 focus:border-ooosh-500"
                  />
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  Pre-filled as £{Number(linkTarget.excess_amount_taken || 0).toFixed(2)} already collected
                  {' + '}£{Number(linkingDeposit.amount).toFixed(2)} deposit. If this deposit is money OP has
                  already counted, set it back to £{Number(linkTarget.excess_amount_taken || 0).toFixed(2)} —
                  the record just gets re-pointed at this deposit.
                </p>
                <div className="flex gap-2 mt-4">
                  <button
                    onClick={() => setLinkTarget(null)}
                    disabled={linkLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleLinkDeposit}
                    disabled={linkLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 rounded-md hover:bg-ooosh-700 disabled:opacity-50"
                  >
                    {linkLoading ? 'Linking…' : 'Link deposit'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-2 mb-4">
                {chargeableRecords.map((record) => (
                  <button
                    key={record.id}
                    onClick={() => handlePickLinkTarget(record)}
                    disabled={linkLoading}
                    className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-ooosh-300 hover:bg-ooosh-50/50 transition-colors disabled:opacity-50"
                  >
                    <p className="text-sm font-medium text-gray-900">
                      {record.driver_name || record.client_name || 'Job-level excess'}
                      {record.vehicle_reg && ` — ${record.vehicle_reg}`}
                    </p>
                    <p className="text-xs text-gray-500">
                      Required: {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
                      {' · '}Collected: £{Number(record.excess_amount_taken || 0).toFixed(2)}
                      {' · '}Status: {statusLabel(record.excess_status, record.auto_covered)}
                      {record.hh_deposit_id && ' · Already linked'}
                    </p>
                  </button>
                ))}

                {/* Create new excess record from HH deposit */}
                <button
                  onClick={handleCreateAndLinkExcess}
                  disabled={linkLoading}
                  className="w-full text-left p-3 border-2 border-dashed border-ooosh-300 rounded-lg hover:border-ooosh-400 hover:bg-ooosh-50/50 transition-colors disabled:opacity-50"
                >
                  <p className="text-sm font-medium text-ooosh-700">+ Create new excess record</p>
                  <p className="text-xs text-gray-500">
                    Creates an OP record for £{Number(linkingDeposit.amount).toFixed(2)} linked to this HireHop deposit
                  </p>
                </button>
              </div>
            )}

            {!linkTarget && (
              <button
                onClick={() => setLinkingDeposit(null)}
                className="w-full px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      )}

      {/* Client Account Balance */}
      {client_balance_on_account > 0 && (
        <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-3">
          <p className="text-sm text-green-800">
            <span className="font-semibold">Client has £{client_balance_on_account.toFixed(2)} on account</span>
            {' '}from previous hires. This can be applied against this job's excess or balance.
          </p>
        </div>
      )}

      {/* Payment History */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4 gap-3">
          <h3 className="text-lg font-semibold text-gray-900">Payment History</h3>
          <button
            onClick={() => { setResendMsg(null); setShowResendModal(true); }}
            title="Re-send the client's booking/payment confirmation email — pick who gets it"
            className="px-3 py-1.5 text-sm font-medium text-ooosh-700 border border-ooosh-200 hover:bg-ooosh-50 rounded-md whitespace-nowrap"
          >
            Resend confirmation
          </button>
        </div>
        {resendMsg && (
          <div
            className={`mb-4 text-sm rounded-md px-3 py-2 border ${
              resendMsg.ok
                ? 'bg-green-50 border-green-200 text-green-800'
                : 'bg-amber-50 border-amber-200 text-amber-800'
            }`}
          >
            {resendMsg.text}
          </div>
        )}
        {showResendModal && (
          <ResendConfirmationModal
            jobId={jobId}
            amount={data.financial.total_hire_deposits || 0}
            hireValueIncVat={data.financial.hire_value_inc_vat || 0}
            balanceOwed={data.financial.balance_override ? 0 : (data.financial.balance_outstanding || 0)}
            payments={data.financial.deposits
              // Hire payments only — excess has its own lifecycle/emails. Application
              // lines (excess/credit applied to an invoice) aren't real client payments.
              .filter((d) => !d.is_excess && d.is_deposit !== false)
              .map((d) => ({
                date: d.date,
                method: d.bank_name || 'Card',
                amount: Math.abs(d.amount),
                isRefund: d.is_refund,
              }))}
            onClose={() => setShowResendModal(false)}
            onResult={(r) => setResendMsg(r)}
          />
        )}

        {/* Payment history — hire payments from HireHop (excess payments tracked in Insurance Excess section above) */}
        {(() => {
          if (financial.deposits.length === 0) {
            return <p className="text-sm text-gray-500">No hire payments recorded yet. Excess payments are tracked in the Insurance Excess section above.</p>;
          }

          return (
            <div className="divide-y divide-gray-100">
              {financial.deposits.map((dep) => (
                <div key={dep.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-sm text-gray-700">
                      {dep.date ? new Date(dep.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      {dep.bank_name && <span className="text-gray-500"> — {dep.bank_name}</span>}
                      {dep.stripe_payment_intent && !dep.is_refund && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-purple-50 text-purple-700">Stripe</span>}
                    </p>
                    {dep.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{dep.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className={`text-sm font-semibold ${dep.is_refund ? 'text-red-600' : 'text-gray-900'}`}>
                      {dep.is_refund ? '-' : ''}£{Number(dep.amount).toFixed(2)}
                    </p>
                    {!dep.is_refund && (
                      <button
                        onClick={() => openRefundModal(dep)}
                        className="text-xs text-ooosh-600 hover:text-ooosh-700 underline"
                      >
                        Refund
                      </button>
                    )}
                    {!dep.is_refund && dep.is_deposit && canManage && (
                      <button
                        onClick={() => openApplyModal(dep)}
                        className="text-xs text-ooosh-600 hover:text-ooosh-700 underline whitespace-nowrap"
                        title="Apply this credit to a same-client invoice on another job"
                      >
                        Apply to another job
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          );
        })()}

        {/* Pending refunds — OP IOUs (e.g. cancellation refunds) awaiting processing */}
        {financial.pending_refunds && financial.pending_refunds.length > 0 && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">Pending Refunds</p>
            <div className="divide-y divide-amber-100 rounded-lg border border-amber-200 bg-amber-50/50">
              {financial.pending_refunds.map((pr) => (
                <div key={pr.id} className="py-2.5 px-3 flex items-center justify-between gap-3">
                  <div className="flex-1">
                    <p className="text-sm text-amber-900">
                      {pr.date ? new Date(pr.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Awaiting refund</span>
                    </p>
                    {pr.notes && <p className="text-xs text-amber-700 mt-0.5">{pr.notes}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-sm font-semibold text-amber-900">£{Number(pr.amount).toFixed(2)}</p>
                    <button
                      onClick={() => openPendingRefundModal(pr)}
                      disabled={refundableDeposits.length === 0}
                      title={refundableDeposits.length === 0 ? 'No deposit on this job to refund against' : 'Process this refund'}
                      className="text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md px-2.5 py-1 disabled:opacity-50"
                    >
                      Process refund
                    </button>
                    {canManage && (
                      <button
                        onClick={() => openDismissRefundModal(pr)}
                        title="Clear this IOU without moving money (already refunded out-of-band, or shouldn't have been logged)"
                        className="text-xs font-medium text-amber-700 hover:text-amber-900 underline"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Job costs vs quotes (Cost Capture) */}
      <JobCostsPanel costs={jobCosts} quotes={jobQuotes} onAddCost={() => setShowAddCost(true)} onChanged={loadJobCosts}
        jobId={jobId} rechargeOn={!!job?.recharge_running_costs} onJobChanged={onJobChanged} />
      {showAddCost && (
        <CostCaptureModal
          presetJobId={jobId}
          onClose={() => setShowAddCost(false)}
          onSaved={() => { setShowAddCost(false); loadJobCosts(); }}
          onSavedAndSplit={(c) => { setShowAddCost(false); loadJobCosts(); setSplittingCost(c); }}
        />
      )}
      {splittingCost && (
        <CostAllocationModal
          cost={splittingCost}
          onClose={() => setSplittingCost(null)}
          onSaved={() => { setSplittingCost(null); loadJobCosts(); }}
        />
      )}

      {/* Record Payment Form */}
      {showPaymentForm && (() => {
        // Smart payment options
        const total = financial.hire_value_inc_vat;
        const remaining = financial.balance_outstanding;
        const minDeposit = total < 400 ? total : Math.max(total * 0.25, 100);
        const halfPayment = Math.round(total * 0.5);
        // Quick amounts for hire payments (deposit / balance)
        const quickAmounts: { label: string; amount: number }[] = [];
        if (total > 0) {
          if (!financial.deposit_paid && total >= 400) {
            quickAmounts.push({ label: `Min. Deposit (25%) - £${minDeposit.toFixed(2)}`, amount: minDeposit });
            if (halfPayment > minDeposit && halfPayment < remaining) {
              quickAmounts.push({ label: `Half (50%) - £${halfPayment.toFixed(2)}`, amount: halfPayment });
            }
          }
          if (remaining > 0) {
            quickAmounts.push({
              label: remaining === total ? `Full Payment - £${total.toFixed(2)}` : `Remaining Balance - £${remaining.toFixed(2)}`,
              amount: remaining,
            });
          }
        }

        // Auto-detect type: if deposit not yet paid, it's a deposit; otherwise balance
        const autoType = !financial.deposit_paid ? 'deposit' : 'balance';

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPaymentForm(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Record Payment</h3>

              <div className="space-y-3">
                {/* Excess collection lives in the Insurance Excess section below
                    (Manage on a record, or "+ Add excess record" when none) so the
                    full lifecycle — including pre-auth holds — sits in one place.
                    This form records hire payments only. */}

                {/* Quick amount buttons */}
                {quickAmounts.length > 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Amount</label>
                    <div className="space-y-1.5">
                      {quickAmounts.map((qa) => (
                        <button
                          key={qa.label}
                          onClick={() => setPayAmount(qa.amount.toFixed(2))}
                          className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
                            payAmount === qa.amount.toFixed(2)
                              ? 'border-ooosh-400 bg-ooosh-50 text-ooosh-700 font-medium'
                              : 'border-gray-200 hover:border-ooosh-200 hover:bg-ooosh-50/50 text-gray-700'
                          }`}
                        >
                          {qa.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">£</span>
                      <input
                        type="number"
                        step="0.01"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                        placeholder="Or enter custom amount"
                      />
                    </div>
                  </div>
                )}

                {/* Fallback: plain amount input when no quick options */}
                {quickAmounts.length === 0 && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                      <input
                        type="number"
                        step="0.01"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {PAYMENT_METHODS_BASE.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reference (optional)</label>
                  <input
                    type="text"
                    value={payRef}
                    onChange={(e) => setPayRef(e.target.value)}
                    placeholder="Bank ref, Stripe ID, etc."
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
                  <input
                    type="text"
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                    placeholder="Any additional details"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={payPushToHH}
                    onChange={(e) => setPayPushToHH(e.target.checked)}
                    className="rounded border-gray-300"
                  />
                  <span className="text-xs text-gray-600">Also create deposit in HireHop</span>
                </label>

                {payError && <p className="text-xs text-red-600">{payError}</p>}

                {payHHPushError && (
                  <div className="px-3 py-2 text-xs bg-amber-50 border border-amber-200 rounded-md text-amber-800">
                    <div className="font-semibold mb-1">Saved in OP — HireHop push failed</div>
                    <div>{payHHPushError}</div>
                    <div className="mt-1 text-amber-700">
                      The OP record is correct. To reconcile: create the deposit manually in HireHop, then on /money/excess use Manage &gt; Link to HH.
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => handleRecordPayment(autoType)}
                    disabled={payLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50"
                  >
                    {payLoading ? 'Recording...' : 'Record Payment'}
                  </button>
                  <button
                    onClick={() => { setShowPaymentForm(false); setPayError(''); setPayHHPushError(null); }}
                    className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md"
                  >
                    {payHHPushError ? 'Close' : 'Cancel'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Excess action modal */}
      {actionExcess && (
        <ExcessPaymentModal
          excess={actionExcess}
          hireDays={computeHireDays(job)}
          onClose={() => setActionExcess(null)}
          onUpdated={loadData}
        />
      )}

      {/* Resolve-balance modal (business adjustment — admin only) */}
      {showResolveBalance && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setShowResolveBalance(false)}>
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-1">Resolve balance</h3>
            <p className="text-xs text-gray-500 mb-3">
              Marks this £{data?.financial.balance_outstanding.toFixed(2)} balance as settled for business purposes.
              Doesn't touch HireHop or Xero — the live figure above stays as-is, it just stops counting on the Money Overview.
            </p>
            <div className="mb-3">
              <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
              <select value={balReason} onChange={(e) => setBalReason(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-md px-3 py-2">
                {BALANCE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">Notes (optional)</label>
              <textarea value={balNotes} onChange={(e) => setBalNotes(e.target.value)} rows={2}
                className="w-full text-sm border border-gray-300 rounded-md px-3 py-2 resize-y" />
            </div>
            {balError && <p className="text-xs text-red-600 mb-3">{balError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowResolveBalance(false)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={submitResolveBalance} disabled={balSaving}
                className="px-4 py-1.5 text-sm font-medium text-white bg-ooosh-600 rounded-md hover:bg-ooosh-700 disabled:opacity-50">
                {balSaving ? 'Saving…' : 'Resolve'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Cross-job "Apply credit to another job" modal */}
      {applyingDep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setApplyingDep(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Apply Credit to Another Job</h3>
              <p className="text-xs text-gray-500 mt-1">
                Apply £{Number(applyingDep.amount).toFixed(2)}{applyingDep.bank_name && ` (${applyingDep.bank_name})`} on this job to a same-client invoice on another job. No cash moves — it reallocates the deposit to the other job's invoice.
              </p>
            </div>
            <div className="px-5 py-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Apply to invoice (same client, another job)</label>
                {applyLoadingInv ? (
                  <div className="text-xs text-gray-500 py-2">Loading this client's other jobs…</div>
                ) : applyGroups.length === 0 ? (
                  <div className="text-xs text-gray-500 py-2">No other jobs with an outstanding balance for this client.</div>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto border border-gray-200 rounded-md p-2">
                    {applyGroups.map((grp) => (
                      <div key={grp.hh_job_number}>
                        <div className="text-xs font-semibold text-gray-700">#{grp.hh_job_number}{grp.job_name ? ` — ${grp.job_name}` : ''}</div>
                        {grp.invoices.map((inv) => (
                          <label key={inv.id} className="flex items-center gap-2 text-xs py-0.5 cursor-pointer">
                            <input type="radio" name="applyInvoice"
                              checked={applyTarget?.hhJob === grp.hh_job_number && applyTarget?.invoiceId === inv.id}
                              onChange={() => setApplyTarget({ hhJob: grp.hh_job_number, invoiceId: inv.id })} />
                            <span>{inv.number} · £{inv.owing.toFixed(2)} owing · {inv.description.substring(0, 44)}</span>
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                  <input type="number" step="0.01" max={applyingDep.amount} value={applyAmount}
                    onChange={(e) => setApplyAmount(e.target.value)}
                    className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md" />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Bank attribution (HireHop/Xero)</label>
                <select value={applyBank} onChange={(e) => setApplyBank(e.target.value ? Number(e.target.value) : '')}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2">
                  <option value="">Auto — from the source deposit's bank</option>
                  {HH_BANKS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
                <p className="text-xs text-gray-400 mt-1">No cash moves — this only sets the bank the reallocation is attributed to. Defaults to the source deposit's bank.</p>
              </div>
              {applyError && <div className="text-xs bg-red-50 border border-red-200 rounded p-2 text-red-700">{applyError}</div>}
            </div>
            <div className="px-5 py-4 border-t border-gray-200 flex justify-end gap-2">
              <button onClick={() => setApplyingDep(null)} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
              <button onClick={submitApply} disabled={applyLoading || !applyTarget}
                className="px-4 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
                {applyLoading ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Hire payment refund modal */}
      {refundingDep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeRefundModal}>
          {/* Height-capped with a scrolling body. Without it the release-consent
              panel pushed "Confirm Refund" off the bottom of a 100%-zoom
              screen; any long content (a verbose HireHop error, say) would do
              the same. Matches the convention used elsewhere in this file. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Refund Payment</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  £{Number(refundingDep.amount).toFixed(2)} on {refundingDep.date ? new Date(refundingDep.date).toLocaleDateString('en-GB') : '—'}
                  {refundingDep.bank_name && <> — {refundingDep.bank_name}</>}
                </p>
              </div>
              <button onClick={closeRefundModal} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>

            {refundResult ? (
              <div className="px-5 py-5 space-y-3">
                <div className="px-3 py-2 bg-green-50 border border-green-200 rounded text-sm text-green-800">
                  Refund recorded successfully.
                  {refundResult.stripe_refund_id && <div className="text-xs mt-1">Stripe refund: <code className="font-mono">{refundResult.stripe_refund_id}</code></div>}
                </div>
                {refundResult.hh_push_error && (
                  <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
                    <div className="font-semibold mb-1">HireHop paperwork push failed</div>
                    {refundResult.hh_push_error}
                  </div>
                )}
                {refundResult.client_email && (
                  refundResult.client_email.sent ? (
                    <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600">
                      Confirmation emailed to {refundResult.client_email.toEmail}
                      {refundResult.client_email.isFallback && ' (no client address on file — sent to info@ to forward)'}
                    </div>
                  ) : (
                    <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
                      <div className="font-semibold mb-1">Confirmation email not sent</div>
                      The refund itself is recorded. {refundResult.client_email.error || 'The email failed to send.'} Let the client know another way.
                    </div>
                  )
                )}
                {/* Close out any IOU this refund has satisfied, here and now.
                    Refunding from Payment History leaves an IOU untouched, so
                    Pending Refunds silently accumulates money that has already
                    gone back — £8,430 across 16 rows by Sep 2026, which is why
                    nobody trusts that figure. Asking at the one moment someone
                    actually knows the answer is what stops it rebuilding.
                    Offered, never automatic: the amounts often differ, and OP
                    can't tell a part-payment from a duplicate. */}
                {refundOrphanIous.length > 0 && (
                  <div className="px-3 py-3 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900 space-y-2">
                    <div className="font-semibold">
                      Still showing as a pending refund on this job
                    </div>
                    <p>
                      {canManage ? (
                        <>
                          If the £{(parseFloat(refundAmount) || 0).toFixed(2)} you just refunded covers
                          {refundOrphanIous.length === 1 ? ' this, clear it' : ' these, clear them'} so
                          {refundOrphanIous.length === 1 ? ' it stops' : ' they stop'} appearing in Pending Refunds.
                        </>
                      ) : (
                        <>
                          If the £{(parseFloat(refundAmount) || 0).toFixed(2)} you just refunded covers
                          {refundOrphanIous.length === 1 ? ' this' : ' these'}, ask a manager to clear
                          {refundOrphanIous.length === 1 ? ' it' : ' them'} from the Money tab.
                        </>
                      )}
                    </p>
                    {refundOrphanIous.map((iou) => {
                      const shortOfIou = iou.amount > (parseFloat(refundAmount) || 0) + 0.005;
                      return (
                        <div key={iou.id} className="flex items-start justify-between gap-3 border-t border-amber-200 pt-2">
                          <div>
                            <span className="font-medium">£{Number(iou.amount).toFixed(2)}</span>
                            {iou.date && <> · logged {new Date(iou.date).toLocaleDateString('en-GB')}</>}
                            {iou.notes && <div className="text-amber-800">{iou.notes}</div>}
                            {/* The one case where clearing is probably wrong. */}
                            {shortOfIou && (
                              <div className="text-amber-800 mt-0.5">
                                More than you just refunded — check the rest has been paid before clearing.
                              </div>
                            )}
                          </div>
                          {/* Same gate as the Clear link on the Money tab's
                              own IOU row — dismiss-refund is managers+. Anyone
                              can still SEE the IOU; only the action is gated,
                              so a staff refund doesn't end in a 403. */}
                          {canManage && (
                            <button
                              onClick={() => clearOrphanIou(iou)}
                              disabled={clearingIouId === iou.id}
                              className="shrink-0 px-2.5 py-1 text-xs font-medium text-amber-900 border border-amber-400 rounded hover:bg-amber-100 disabled:opacity-50"
                            >
                              {clearingIouId === iou.id ? 'Clearing…' : 'Clear it'}
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {clearIouError && <p className="text-red-700">{clearIouError}</p>}
                    {canManage && (
                      <p className="text-[11px]">
                        Leaving {refundOrphanIous.length === 1 ? 'it' : 'them'} is fine — nothing is lost, and
                        {refundOrphanIous.length === 1 ? ' it' : ' they'} can be cleared from the Money tab later.
                      </p>
                    )}
                  </div>
                )}
                <div className="flex justify-end">
                  <button onClick={closeRefundModal} className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md">Close</button>
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3 overflow-y-auto">
                {refundingDep.stripe_payment_intent && (
                  <div className="px-3 py-2 bg-purple-50 border border-purple-200 rounded text-xs text-purple-900">
                    <strong>Stripe-paid</strong> — OP will originate the refund directly via the Stripe API. The matching payment-application appears in HireHop alongside.
                  </div>
                )}
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Amount £</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={refundingDep.amount}
                    value={refundAmount}
                    onChange={(e) => setRefundAmountChecked(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">Max £{Number(refundingDep.amount).toFixed(2)} (partial refunds OK — submit again for the residual).</p>
                  {/* Heads-up BEFORE submitting. HireHop can only refund money
                      still unallocated on the deposit; once it's been applied to
                      an invoice there is nothing to take back (error 370). This
                      isn't a block — OP can release it back off the invoice —
                      but saying so up front beats a surprise confirm step. */}
                  {refundingDep.available_to_refund != null
                    && refundingDep.available_to_refund + 0.005 < (parseFloat(refundAmount) || 0) && (
                    <p className="text-[11px] text-amber-700 mt-1">
                      HireHop shows only £{Number(refundingDep.available_to_refund).toFixed(2)} unallocated on this deposit — the rest has been applied to an invoice. OP will offer to release the difference back first.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
                  <select
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value as typeof refundMethod)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    disabled={!!refundingDep.stripe_payment_intent}
                  >
                    <option value="stripe_gbp">Stripe GBP</option>
                    <option value="worldpay">Worldpay</option>
                    <option value="amex">Amex</option>
                    <option value="wise_bacs">Wise (BACS)</option>
                    <option value="lloyds_bank">Lloyds Bank</option>
                    <option value="till_cash">Cash</option>
                    <option value="paypal">PayPal</option>
                  </select>
                  {refundingDep.stripe_payment_intent && (
                    <p className="text-[11px] text-gray-500 mt-1">Locked to Stripe — original payment was made via Stripe.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Reference (optional)</label>
                  <input
                    type="text"
                    value={refundReference}
                    onChange={(e) => setRefundReference(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    placeholder="e.g. customer reference"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
                  <textarea
                    value={refundNotes}
                    onChange={(e) => setRefundNotes(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    placeholder="Why is this being refunded?"
                  />
                </div>
                <RefundNotifyControl
                  viaStripe={!!refundingDep.stripe_payment_intent}
                  checked={refundNotifyClient}
                  onChange={setRefundNotifyClient}
                />
                {refundError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{refundError}</div>
                )}
                {refundRelease && (
                  <ReleaseConsentPanel
                    plan={refundRelease}
                    refundAmount={parseFloat(refundAmount) || 0}
                    depositAmount={Number(refundingDep.amount)}
                    viaStripe={!!refundingDep.stripe_payment_intent}
                  />
                )}
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={closeRefundModal} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                  {/* Arrow functions, not bare references: passing the handler
                      directly would hand React's click event in as
                      `allowRelease`, and a truthy event would authorise the
                      release nobody confirmed. */}
                  {refundRelease ? (
                    <button onClick={() => submitRefund(true)} disabled={refundLoading} className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50">
                      {refundLoading ? 'Processing...' : `Release £${Number(refundRelease.shortfall).toFixed(2)} and refund`}
                    </button>
                  ) : (
                    <button onClick={() => submitRefund()} disabled={refundLoading} className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
                      {refundLoading ? 'Processing...' : 'Confirm Refund'}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Clear (dismiss) pending refund modal — no money moves */}
      {dismissRefund && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDismissRefund(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200">
              <h3 className="text-lg font-semibold text-gray-900">Clear Pending Refund</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                £{Number(dismissRefund.amount).toFixed(2)} — clears the IOU without moving any money. Doesn't touch HireHop / Stripe / Xero.
                To actually send a refund, use "Process refund" instead.
              </p>
            </div>
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Reason</label>
                <select
                  value={dismissReason}
                  onChange={(e) => setDismissReason(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                >
                  <option value="refunded_externally">Already refunded outside OP (HireHop / Stripe / bank)</option>
                  <option value="refunded_via_op">Refunded in OP, but not through this IOU</option>
                  <option value="not_required">Not required (artifact / superseded)</option>
                  <option value="duplicate">Duplicate record</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
                <textarea
                  value={dismissNotes}
                  onChange={(e) => setDismissNotes(e.target.value)}
                  rows={2}
                  placeholder="e.g. refunded £150 in full direct in HireHop"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md resize-y"
                />
              </div>
              {dismissError && <p className="text-xs text-red-600">{dismissError}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setDismissRefund(null)} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                <button onClick={submitDismissRefund} disabled={dismissLoading} className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50">
                  {dismissLoading ? 'Clearing…' : 'Clear refund'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Process pending refund modal (e.g. cancellation IOU) */}
      {pendingRefund && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closePendingRefundModal}>
          {/* Height-capped like the refund modal above — this one is TALLER
              (deposit picker + "when you confirm" panel) and can also carry the
              release-consent panel, so it overflows sooner. */}
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full max-h-[90vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Process Refund</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  Pending £{Number(pendingRefund.amount).toFixed(2)}
                  {pendingRefund.notes && <> — {pendingRefund.notes}</>}
                </p>
              </div>
              <button onClick={closePendingRefundModal} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
            </div>

            {refundResult ? (
              <div className="px-5 py-5 space-y-3">
                <div className="px-3 py-2 bg-green-50 border border-green-200 rounded text-sm text-green-800">
                  Refund processed and marked complete.
                  {refundResult.stripe_refund_id && <div className="text-xs mt-1">Stripe refund: <code className="font-mono">{refundResult.stripe_refund_id}</code></div>}
                </div>
                {refundResult.hh_push_error && (
                  <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
                    <div className="font-semibold mb-1">HireHop paperwork push failed</div>
                    {refundResult.hh_push_error}
                  </div>
                )}
                {refundResult.client_email && (
                  refundResult.client_email.sent ? (
                    <div className="px-3 py-2 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600">
                      Confirmation emailed to {refundResult.client_email.toEmail}
                      {refundResult.client_email.isFallback && ' (no client address on file — sent to info@ to forward)'}
                    </div>
                  ) : (
                    <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded text-xs text-amber-900">
                      <div className="font-semibold mb-1">Confirmation email not sent</div>
                      The refund itself is recorded. {refundResult.client_email.error || 'The email failed to send.'} Let the client know another way.
                    </div>
                  )
                )}
                <div className="flex justify-end">
                  <button onClick={closePendingRefundModal} className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md">Close</button>
                </div>
              </div>
            ) : refundableDeposits.length === 0 ? (
              <div className="px-5 py-5 space-y-3">
                <div className="px-3 py-2 bg-amber-50 border border-amber-300 rounded text-sm text-amber-900">
                  There's no deposit on this job to refund against. Record the refund manually in HireHop, or record the original payment first.
                </div>
                <div className="flex justify-end">
                  <button onClick={closePendingRefundModal} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Close</button>
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3 overflow-y-auto">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Refund against deposit</label>
                  <select
                    value={pendingDepositId ?? ''}
                    onChange={(e) => onPendingDepositChange(Number(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  >
                    {refundableDeposits.map((d) => (
                      <option key={d.id} value={d.id}>
                        £{Number(d.amount).toFixed(2)}{d.bank_name ? ` — ${d.bank_name}` : ''}{d.date ? ` (${new Date(d.date).toLocaleDateString('en-GB')})` : ''}{d.stripe_payment_intent ? ' — Stripe' : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Amount £</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    max={selectedDeposit?.amount}
                    value={refundAmount}
                    onChange={(e) => setRefundAmountChecked(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  />
                  {selectedDeposit && parseFloat(refundAmount) > selectedDeposit.amount && (
                    <p className="text-[11px] text-red-600 mt-1">Exceeds the selected deposit (£{Number(selectedDeposit.amount).toFixed(2)}). Pick a bigger deposit or split the refund.</p>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Method</label>
                  <select
                    value={refundMethod}
                    onChange={(e) => setRefundMethod(e.target.value as typeof refundMethod)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                    disabled={!!selectedDeposit?.stripe_payment_intent}
                  >
                    <option value="stripe_gbp">Stripe GBP</option>
                    <option value="worldpay">Worldpay</option>
                    <option value="amex">Amex</option>
                    <option value="wise_bacs">Wise (BACS)</option>
                    <option value="lloyds_bank">Lloyds Bank</option>
                    <option value="till_cash">Cash</option>
                    <option value="paypal">PayPal</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Notes (optional)</label>
                  <textarea
                    value={refundNotes}
                    onChange={(e) => setRefundNotes(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  />
                </div>

                {/* "This will do this" — explicit summary of what Confirm performs */}
                <div className="px-3 py-2.5 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                  <div className="font-semibold mb-1">When you confirm:</div>
                  <ol className="list-decimal list-inside space-y-0.5">
                    {selectedDeposit?.stripe_payment_intent ? (
                      <li><strong>£{(parseFloat(refundAmount) || 0).toFixed(2)} refunded to the client automatically via Stripe.</strong></li>
                    ) : (
                      <li><strong>£{(parseFloat(refundAmount) || 0).toFixed(2)} recorded as refunded via {refundMethod.replace(/_/g, ' ')}</strong> — you must move the money yourself (this does <em>not</em> send it).</li>
                    )}
                    <li>A matching refund is recorded in HireHop and posted to Xero.</li>
                    <li>This pending refund is marked <strong>Completed</strong>.</li>
                  </ol>
                </div>

                <RefundNotifyControl
                  viaStripe={!!selectedDeposit?.stripe_payment_intent}
                  checked={refundNotifyClient}
                  onChange={setRefundNotifyClient}
                />
                {refundError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{refundError}</div>
                )}
                {refundRelease && selectedDeposit && (
                  <ReleaseConsentPanel
                    plan={refundRelease}
                    refundAmount={parseFloat(refundAmount) || 0}
                    depositAmount={Number(selectedDeposit.amount)}
                    viaStripe={!!selectedDeposit.stripe_payment_intent}
                  />
                )}
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={closePendingRefundModal} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                  {/* Arrow function, not a bare reference — passing the handler
                      directly hands React's click event in as `allowRelease`,
                      and a truthy event would authorise a release nobody
                      confirmed. */}
                  <button
                    onClick={() => submitPendingRefund(!!refundRelease)}
                    disabled={refundLoading || !selectedDeposit || (parseFloat(refundAmount) > (selectedDeposit?.amount ?? 0) + 0.005)}
                    className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50"
                  >
                    {refundLoading ? 'Processing...'
                      : refundRelease ? `Release £${refundRelease.shortfall.toFixed(2)} and refund`
                      : (selectedDeposit?.stripe_payment_intent ? 'Refund via Stripe & complete' : 'Record refund & complete')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Deep-link to a cost on the Costs hub. Narrows the hub to the CAPTURE job
// (`c.job_id`) — for a split-in row that's a different job than the one we're
// looking at, and it's where the invoice and the recharge actually live. The
// `job` filter also keeps the target row inside the hub's 200-row page cap.
function costHubHref(cost: JobCostLite): string {
  return cost.job_id
    ? `/money/costs?view=all&job=${cost.job_id}&cost=${cost.id}`
    : `/money/costs?view=all&cost=${cost.id}`;
}

// Receipt cell for a cost row — the thumb (image / 📎, opens a lightbox) or a
// soft marker when there's no paperwork attached. The click-through to the hub
// lives on the row title instead: an arrow this size was too small to aim at.
function CostReceiptCell({ cost, onPreview }: { cost: JobCostLite; onPreview: (c: JobCostLite) => void }) {
  if (!cost.receipt_r2_key) {
    return (
      <span className="text-[10px] text-gray-300 whitespace-nowrap" title="No receipt or invoice attached to this cost">
        no receipt
      </span>
    );
  }
  return <ReceiptThumb cost={cost} size="sm" onOpen={() => onPreview(cost)} />;
}

// Quoted-vs-actual variance + extra/recharge breakdown for a job's captured
// costs. "Quoted (our cost)" sums the job's quote freelancer fees — the
// expected transport/crew cost. "Actuals" sums the quote_actual costs. Extra
// costs are listed separately (eligible for client recharge). Hidden when the
// job has neither costs nor quotes.
function JobCostsPanel({ costs, quotes, onAddCost, onChanged, jobId, rechargeOn, onJobChanged }: { costs: JobCostLite[]; quotes: JobQuoteLite[]; onAddCost: () => void; onChanged: () => void; jobId: string; rechargeOn: boolean; onJobChanged?: () => void }) {
  const m = (n: number) => `£${n.toFixed(2)}`;
  const num = (n: number | null | undefined) => Number(n || 0);
  const [resolving, setResolving] = useState<JobCostLite | null>(null);
  const [rechargeBusy, setRechargeBusy] = useState(false);
  const [receiptPreview, setReceiptPreview] = useState<JobCostLite | null>(null);

  // Lightweight "recharge running costs" toggle — the flag is normally set by a
  // Recharge line on a quote; this covers the no-quote / mid-hire case. Sets the
  // cost auto-inherit + the standing card.
  async function toggleRecharge() {
    const turningOn = !rechargeOn;
    if (turningOn && !window.confirm('Mark this job as "recharge running costs"?\n\nNew running-cost costs (fuel/parking/etc.) logged here will default to recharge (actual + 20%), and a card surfaces at check-in. Usually set via a Recharge line on the quote — use this for jobs without one.')) return;
    setRechargeBusy(true);
    try {
      await api.patch(`/hirehop/jobs/${jobId}/recharge-running-costs`, { rechargeRunningCosts: turningOn });
      onJobChanged?.();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update recharge flag');
    } finally {
      setRechargeBusy(false);
    }
  }
  const RechargeToggle = (
    <button onClick={toggleRecharge} disabled={rechargeBusy}
      title={rechargeOn ? 'Running costs are recharged to the client post-hire. Click to turn off.' : 'Mark this job as recharging its running costs (fuel/parking/etc.) to the client post-hire'}
      className={`text-xs rounded-md px-2 py-1 border disabled:opacity-50 ${rechargeOn ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}>
      {rechargeBusy ? '…' : rechargeOn ? '⛽ Recharging running costs ✓' : '⛽ Recharge running costs'}
    </button>
  );

  const AddBtn = (
    <button onClick={onAddCost} className="text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md px-3 py-1.5">
      + Add cost
    </button>
  );

  if (!costs.length && !quotes.length) {
    return (
      <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">Job Costs</h3>
          {AddBtn}
        </div>
        <p className="text-sm text-gray-500 mt-2">No supplier costs, fuel, or freelancer invoices logged against this job yet.</p>
      </div>
    );
  }

  const liveQuotes = quotes.filter((q) => q.status !== 'cancelled');
  // Expected outlay = what we actually expect to PAY OUT (and reconcile invoices
  // against): freelancer labour + van fuel + fronted (absorbed) expenses +
  // transport fares. Admin fee is EXCLUDED — it's a markup baked into our_total_cost,
  // never a real invoice. Previously this summed only the freelancer fee, so it
  // understated the expected cost by fuel/expenses/transport.
  const expFreelancer = liveQuotes.reduce((s, q) => s + num(q.freelancer_fee_rounded ?? q.freelancer_fee), 0);
  const expFuel = liveQuotes.reduce((s, q) => s + num(q.expected_fuel_cost), 0);
  const expExpenses = liveQuotes.reduce((s, q) => s + num(q.expenses_included), 0);
  const expTransport = liveQuotes.reduce((s, q) => s + num(q.travel_cost), 0);
  const quotedCost = expFreelancer + expFuel + expExpenses + expTransport;
  const expectedMakeup: { label: string; amount: number; hint?: string }[] = [
    { label: 'Freelancer', amount: expFreelancer },
    { label: 'Fuel', amount: expFuel },
    {
      label: 'Fronted expenses',
      amount: expExpenses,
      // Deliberately has no matching bucket on the actuals side — see the
      // actualsMakeup comment below.
      hint: 'Money the crew lays out and reclaims. Tick “fronted” on a cost line and it lands here on the actuals side too; an unsplit cost has nowhere to record who paid, so it falls under whatever it was bought as.',
    },
    { label: 'Transport', amount: expTransport },
  ].filter((c) => c.amount > 0.005);
  const clientQuoted = liveQuotes.reduce((s, q) => s + num(q.client_fee), 0);

  const actualCosts = costs.filter((c) => c.cost_intent === 'quote_actual');
  const extraCosts = costs.filter((c) => c.cost_intent === 'extra');
  const unclassified = costs.filter((c) => c.cost_intent == null);

  const actualsTotal = actualCosts.reduce((s, c) => s + num(c.amount_gross), 0);
  // Actuals broken down the same way as the Expected card, so the two read side
  // by side and a variance points at WHERE it came from rather than just how big
  // it is. Buckets come off the Xero nominal code, which is what the category
  // picker already writes.
  //
  // Both blind spots this used to carry are now closed by cost lines:
  //
  //  - Whole-invoice coding. A £250 freelancer bill that was really £190 fee +
  //    £60 fuel counted entirely as Freelancer. Split into lines, each part
  //    lands in its own bucket.
  //  - "Fronted expenses" had NO actuals bucket at all, because fronting is a
  //    fact about WHO PAID and no Xero code carries it. A line's `crew_fronted`
  //    flag does, so it finally has one — and fronted WINS over the line's
  //    category, because that is what the quote means by the word: money the
  //    crew laid out and reclaims, whatever they spent it on.
  //
  // A cost with no lines still buckets by its header code, exactly as before.
  const actualsMakeup = (() => {
    const byLabel = new Map<string, number>();
    const add = (code: string | null | undefined, fronted: boolean, amount: number) => {
      const c = (code || '').trim();
      const label = fronted ? 'Fronted expenses'
        : c === '320' ? 'Freelancer'
        : c === '410' ? 'Fuel'
        : c === '325' ? 'Transport'
        : 'Other';
      byLabel.set(label, (byLabel.get(label) || 0) + amount);
    };
    for (const c of actualCosts) {
      if (c.lines?.length) {
        for (const l of c.lines) {
          add(l.xero_account_code || c.xero_account_code, Boolean(l.crew_fronted), Number(l.amount_gross) || 0);
        }
      } else {
        add(c.xero_account_code, false, num(c.amount_gross));
      }
    }
    // Same order as the Expected card above, so the two read side by side.
    return ['Freelancer', 'Fuel', 'Fronted expenses', 'Transport', 'Other']
      .map((label) => ({ label, amount: byLabel.get(label) || 0 }))
      .filter((c) => c.amount > 0.005);
  })();
  const extraTotal = extraCosts.reduce((s, c) => s + num(c.amount_gross), 0);
  const unclassifiedTotal = unclassified.reduce((s, c) => s + num(c.amount_gross), 0);
  const variance = actualsTotal - quotedCost;

  const varianceLabel = quotedCost === 0
    ? 'No quote to compare against'
    : variance > 0.005 ? `${m(variance)} over the quote`
    : variance < -0.005 ? `${m(-variance)} under the quote`
    : 'On the quote';
  const varianceColour = quotedCost === 0 ? 'text-gray-500'
    : variance > 0.005 ? 'text-red-600' : 'text-green-600';

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-6">
      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h3 className="text-lg font-semibold text-gray-900">Job Costs</h3>
        <div className="flex items-center gap-2 flex-wrap">
          {RechargeToggle}
          <a href="/money/costs" className="text-sm text-purple-700 hover:underline">Costs hub →</a>
          {AddBtn}
        </div>
      </div>

      {/* Quoted vs actual */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className="rounded-md border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Expected (from quotes)</div>
          <div className="text-lg font-semibold text-gray-900">{m(quotedCost)}</div>
          {expectedMakeup.length > 0 ? (
            <div className="mt-1 space-y-0.5">
              {expectedMakeup.map((c) => (
                <div key={c.label} title={c.hint} className="flex items-center justify-between text-xs text-gray-400">
                  <span className={c.hint ? 'border-b border-dotted border-gray-300' : undefined}>{c.label}</span>
                  <span>{m(c.amount)}</span>
                </div>
              ))}
              <div className="text-[10px] text-gray-300 pt-0.5">admin fee excluded</div>
            </div>
          ) : (
            <div className="text-xs text-gray-400">crew / transport cost</div>
          )}
        </div>
        <div className="rounded-md border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Actuals (part of quote)</div>
          <div className="text-lg font-semibold text-gray-900">{m(actualsTotal)}</div>
          {actualsMakeup.length > 0 ? (
            <div className="mt-1 space-y-0.5">
              {actualsMakeup.map((c) => (
                <div key={c.label} className="flex items-center justify-between text-xs text-gray-400">
                  <span>{c.label}</span>
                  <span>{m(c.amount)}</span>
                </div>
              ))}
              <div className="text-[10px] text-gray-300 pt-0.5"
                title="Grouped by category — per line where an invoice was split, otherwise by the whole cost's category. An unsplit freelancer bill that also covered fuel still counts entirely as Freelancer; split it into lines to break it out.">
                {actualCosts.length} cost{actualCosts.length === 1 ? '' : 's'} · by category
              </div>
            </div>
          ) : (
            <div className="text-xs text-gray-400">{actualCosts.length} cost{actualCosts.length === 1 ? '' : 's'}</div>
          )}
        </div>
        <div className="rounded-md border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Variance</div>
          <div className={`text-lg font-semibold ${varianceColour}`}>{varianceLabel}</div>
        </div>
      </div>
      {clientQuoted > 0 && (
        <p className="text-xs text-gray-400 -mt-2 mb-4">Client quoted {m(clientQuoted)} for transport / crew.</p>
      )}

      {/* Actual costs (part of quote) — itemised, so staff can see WHICH bills make up the total */}
      {actualCosts.length > 0 && (
        <div className="border-t border-gray-100 pt-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Costs applied to this job</span>
            <span className="text-sm font-semibold text-gray-900">{m(actualsTotal)}</span>
          </div>
          <ul className="space-y-1">
            {actualCosts.map((c) => {
              const isSplit = !!c.is_allocation;
              const captureJobId = c.job_id;
              return (
                <li key={isSplit ? `a-${c.allocation_id || c.id}` : `c-${c.id}`} className="flex items-center justify-between text-sm gap-2">
                  <span className="text-gray-600 truncate min-w-0">
                    <span className="inline-block px-1.5 py-0.5 mr-1.5 text-[10px] font-medium bg-gray-100 text-gray-500 rounded align-middle">Quote</span>
                    <a href={costHubHref(c)} title="Open this cost on the Costs hub" className="hover:text-purple-700 hover:underline">
                      {c.supplier_name || c.description || c.category || 'Cost'}
                      {c.invoice_number && <span className="ml-1.5 text-xs text-gray-400">#{c.invoice_number}</span>}
                    </a>
                    {isSplit && (
                      captureJobId ? (
                        <a href={`/jobs/${captureJobId}`} className="ml-1 text-xs text-purple-600 hover:underline"
                          title={`This job's share of a ${m(num(c.full_amount_gross))} cost captured on ${c.capture_hh_job_number ? `job #${c.capture_hh_job_number}` : 'another job'}`}>
                          · split from {c.capture_hh_job_number ? `#${c.capture_hh_job_number}` : 'another job'}
                        </a>
                      ) : (
                        <span className="ml-1 text-xs text-purple-600" title={`This job's share of a ${m(num(c.full_amount_gross))} cost split across jobs`}>· split ({m(num(c.full_amount_gross))} total)</span>
                      )
                    )}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-900">{m(num(c.amount_gross))}</span>
                    <CostReceiptCell cost={c} onPreview={setReceiptPreview} />
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-gray-400 mt-1.5">Manage individual costs on the <a href="/money/costs" className="text-purple-600 hover:underline">Costs hub</a>.</p>
        </div>
      )}

      {/* Extra (rechargeable) costs */}
      {extraCosts.length > 0 && (
        <div className="border-t border-gray-100 pt-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-gray-700">Extra costs (not in a quote)</span>
            <span className="text-sm font-semibold text-gray-900">{m(extraTotal)}</span>
          </div>
          <ul className="space-y-1">
            {extraCosts.map((c) => {
              // Allocation-in rows are a share of a cost captured on ANOTHER
              // job — recharge (and its resolution) belongs to that capture job,
              // so we show them read-only here, tagged as a split.
              const isSplit = !!c.is_allocation;
              const pending = !isSplit && c.recharge_mode !== 'none' && (c.recharge_status ?? 'pending') === 'pending';
              return (
                <li key={isSplit ? `a-${c.allocation_id || c.id}` : `c-${c.id}`} className="flex items-center justify-between text-sm gap-2">
                  <span className="text-gray-600 truncate">
                    <a href={costHubHref(c)} title="Open this cost on the Costs hub" className="hover:text-purple-700 hover:underline">
                      {c.supplier_name || c.description || c.category || 'Cost'}
                      {c.invoice_number && <span className="ml-1.5 text-xs text-gray-400">#{c.invoice_number}</span>}
                    </a>
                    {isSplit && <span className="ml-1 text-xs text-purple-600" title={`This job's share of a ${m(num(c.full_amount_gross))} cost split across jobs`}>· split ({m(num(c.full_amount_gross))} total)</span>}
                  </span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-900">{m(num(c.amount_gross))}</span>
                    <CostReceiptCell cost={c} onPreview={setReceiptPreview} />
                    {!isSplit && c.recharge_mode !== 'none' && <RechargeStatusPill status={c.recharge_status} mode={c.recharge_mode} />}
                    {pending && (
                      <button onClick={() => setResolving(c)}
                        className="px-2 py-0.5 text-xs text-white bg-blue-600 hover:bg-blue-700 rounded">
                        Resolve
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {resolving && (
        <RechargeResolveModal
          cost={resolving}
          onClose={() => setResolving(null)}
          onResolved={() => { setResolving(null); onChanged(); }}
        />
      )}

      {receiptPreview && (
        <ReceiptPreview cost={receiptPreview} onClose={() => setReceiptPreview(null)} />
      )}

      {unclassified.length > 0 && (
        <p className="text-xs text-gray-400 mt-3">
          {unclassified.length} older cost{unclassified.length === 1 ? '' : 's'} ({m(unclassifiedTotal)}) not yet classified as quote/extra — edit them on the Costs hub to include here.
        </p>
      )}
    </div>
  );
}
