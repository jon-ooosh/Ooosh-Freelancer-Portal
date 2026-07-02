/**
 * MoneyTab — Unified financial view for a job.
 *
 * Shows: HireHop financial summary, insurance excess, payment history,
 * record payment form, client account balance.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import { hasManagerRole } from '../lib/roles';
import { getPaymentState, PAYMENT_STATE_LABELS, PAYMENT_STATE_CLASSES } from '../services/paymentState';
import ExcessPaymentModal, { statusLabel, statusColor } from './ExcessPaymentModal';
import CostCaptureModal from './CostCaptureModal';
import RechargeResolveModal, { RechargeStatusPill } from './RechargeResolveModal';
import type { JobExcess } from '../../../shared/types';

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
      bank_name: string | null; entered_by: string | null;
      /** Original Stripe PaymentIntent (when OP has a matching job_payments row).
       *  Presence enables OP-initiated Stripe refund on the row. */
      stripe_payment_intent?: string | null;
      /** Original OP-side payment method (when matched). Drives the modal's default. */
      op_payment_method?: string | null;
    }>;
    /** OP-only pending refund IOUs (e.g. cancellation refunds) awaiting processing. */
    pending_refunds?: Array<{
      id: number; amount: number; method: string | null; notes: string | null; date: string;
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
  amount_gross: number | null;
  amount_net: number | null;
  cost_intent: 'quote_actual' | 'extra' | null;
  recharge_mode: 'none' | 'full' | 'partial';
  recharge_amount: number | null;
  recharged_to_hh_at: string | null;
  recharge_status: string | null;
}
interface JobQuoteLite {
  id: string;
  freelancer_fee: number | null;
  freelancer_fee_rounded: number | null;
  client_fee: number | null;
  status: string | null;
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

  // Link deposit state
  const [linkingDeposit, setLinkingDeposit] = useState<{ hh_deposit_id: number; amount: number } | null>(null);
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
  const [refundResult, setRefundResult] = useState<{ stripe_refund_id?: string; hh_push_error?: string | null } | null>(null);

  // Job costs (Cost Capture) — quoted-vs-actual variance + extra/recharge list.
  const [jobCosts, setJobCosts] = useState<JobCostLite[]>([]);
  const [jobQuotes, setJobQuotes] = useState<JobQuoteLite[]>([]);
  const [showAddCost, setShowAddCost] = useState(false);

  const openRefundModal = (dep: FinancialData['financial']['deposits'][number]) => {
    setRefundingDep(dep);
    setRefundAmount(String(dep.amount));
    setRefundMethod(dep.stripe_payment_intent ? 'stripe_gbp' : (dep.op_payment_method as typeof refundMethod) || 'worldpay');
    setRefundReference('');
    setRefundNotes('');
    setRefundError('');
    setRefundResult(null);
  };

  const closeRefundModal = () => {
    setRefundingDep(null);
    setRefundError('');
    setRefundResult(null);
    if (refundResult) loadData();
  };

  const submitRefund = async () => {
    if (!refundingDep) return;
    const parsed = parseFloat(refundAmount);
    if (isNaN(parsed) || parsed < 0.01) {
      setRefundError('Enter a valid amount (£0.01 or more)');
      return;
    }
    setRefundLoading(true);
    setRefundError('');
    try {
      const resp = await api.post<{ data: unknown; stripe_refund_id?: string; hh_push_error?: string | null }>(
        `/money/${jobId}/refund-payment`,
        {
          hh_deposit_id: refundingDep.id,
          amount: parsed,
          method: refundMethod,
          reference: refundReference.trim() || null,
          notes: refundNotes.trim() || null,
        }
      );
      setRefundResult({
        stripe_refund_id: resp.stripe_refund_id,
        hh_push_error: resp.hh_push_error || null,
      });
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : 'Refund failed');
    } finally {
      setRefundLoading(false);
    }
  };

  // Process-pending-refund modal — actions an OP IOU (e.g. a cancellation
  // refund) by refunding against a chosen original deposit and marking the IOU
  // completed. Reuses the refundAmount/method/reference/notes/result state.
  const [pendingRefund, setPendingRefund] = useState<NonNullable<FinancialData['financial']['pending_refunds']>[number] | null>(null);
  const [pendingDepositId, setPendingDepositId] = useState<number | null>(null);

  // Hire deposits available to refund against (non-refund, non-excess rows).
  const refundableDeposits = (data?.financial.deposits || []).filter(d => !d.is_refund && !d.is_excess);
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
  };

  const closePendingRefundModal = () => {
    setPendingRefund(null);
    setPendingDepositId(null);
    setRefundError('');
    setRefundResult(null);
    if (refundResult) loadData();
  };

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
    const dep = refundableDeposits.find(d => d.id === depId);
    setRefundMethod(dep?.stripe_payment_intent ? 'stripe_gbp' : (dep?.op_payment_method as typeof refundMethod) || 'worldpay');
  };

  const submitPendingRefund = async () => {
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
      const resp = await api.post<{ data: unknown; stripe_refund_id?: string; hh_push_error?: string | null }>(
        `/money/${jobId}/refund-payment`,
        {
          hh_deposit_id: pendingDepositId,
          amount: parsed,
          method: refundMethod,
          reference: refundReference.trim() || null,
          notes: refundNotes.trim() || null,
          pending_refund_id: pendingRefund.id,
        }
      );
      setRefundResult({
        stripe_refund_id: resp.stripe_refund_id,
        hh_push_error: resp.hh_push_error || null,
      });
    } catch (e) {
      setRefundError(e instanceof Error ? e.message : 'Refund failed');
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

  async function handleLinkDeposit(excessId: string) {
    if (!linkingDeposit) return;
    setLinkLoading(true);
    try {
      await api.post(`/excess/${excessId}/link-deposit`, {
        hh_deposit_id: linkingDeposit.hh_deposit_id,
        amount: linkingDeposit.amount,
      });
      setLinkingDeposit(null);
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
              <p className={`text-sm font-semibold ${financial.balance_override ? 'text-gray-400 line-through' : financial.balance_outstanding > 0 ? 'text-red-600' : 'text-green-600'}`}>
                Balance Outstanding: £{financial.balance_outstanding.toFixed(2)}
              </p>
              {/* Admin: resolve a stray HH balance the business considers settled
                  (Xero source of truth). Only when there's a balance + not already
                  resolved. */}
              {isAdmin && !financial.balance_override && financial.balance_outstanding > 0.01 && (
                <button
                  onClick={() => { setBalError(''); setShowResolveBalance(true); }}
                  className="text-xs text-gray-500 hover:text-ooosh-700 underline"
                >Resolve balance…</button>
              )}
            </div>

            {/* Credit-note write-off transparency — the balance above already
                reflects it; this explains why it's lower than deposits suggest. */}
            {(financial.credit_note_write_off ?? 0) > 0.009 && (
              <p className="text-xs text-gray-500 mt-0.5">
                Includes £{(financial.credit_note_write_off as number).toFixed(2)} written off by credit note in HireHop
              </p>
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
            {financial.deposit_paid && financial.balance_outstanding > 0 && (
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
        {excess.records.length > 0 ? (
          <div className="space-y-3">
            {excess.records.map((record) => (
              <div
                key={record.id}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg border border-gray-200"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(record.excess_status)}`}>
                      {statusLabel(record.excess_status)}
                    </span>
                    {record.hh_deposit_id && (
                      <span className="text-[10px] text-green-600 font-medium" title={`HH Deposit #${record.hh_deposit_id} (${record.hh_reconcile_source || 'linked'})`}>
                        HH linked
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
                  <p className="text-xs text-gray-500">
                    Required: {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
                    {Number(record.amount_held || 0) > 0 ? (
                      <>
                        {' · '}
                        <span className="text-sky-700">Held: £{Number(record.amount_held).toFixed(2)}</span>
                      </>
                    ) : (
                      <>
                        {' · '}
                        Collected: £{Number(record.excess_amount_taken || 0).toFixed(2)}
                      </>
                    )}
                    {Number(record.amount_released || 0) > 0 && (
                      <>
                        {' · '}
                        <span className="text-gray-400">Released: £{Number(record.amount_released).toFixed(2)}</span>
                      </>
                    )}
                  </p>
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
                          {record.reimbursement_method && ` (${record.reimbursement_method.replace(/_/g, ' ')})`}
                        </span>
                      )}
                    </p>
                  )}
                  {record.excess_status === 'pre_auth' && record.held_expires_at && (() => {
                    const daysLeft = Math.ceil((new Date(record.held_expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    const cls = daysLeft <= 1 ? 'text-red-600' : daysLeft <= 2 ? 'text-amber-600' : 'text-sky-600';
                    return (
                      <p className={`text-[11px] mt-0.5 font-medium ${cls}`}>
                        {daysLeft <= 0
                          ? 'Hold expired — capture or release'
                          : daysLeft === 1
                            ? 'Hold expires tomorrow'
                            : `Hold expires in ${daysLeft} days`}
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
            ))}
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
                  {excess.records.length > 0 ? (
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setLinkingDeposit(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Link HH Deposit to Excess Record</h3>
            <p className="text-sm text-gray-600 mb-4">
              HireHop deposit <strong>#{linkingDeposit.hh_deposit_id}</strong> for <strong>£{Number(linkingDeposit.amount).toFixed(2)}</strong>.
              Select which excess record to link it to:
            </p>
            <div className="space-y-2 mb-4">
              {excess.records.map((record) => (
                <button
                  key={record.id}
                  onClick={() => handleLinkDeposit(record.id)}
                  disabled={linkLoading}
                  className="w-full text-left p-3 border border-gray-200 rounded-lg hover:border-ooosh-300 hover:bg-ooosh-50/50 transition-colors disabled:opacity-50"
                >
                  <p className="text-sm font-medium text-gray-900">
                    {record.driver_name || record.client_name || 'Job-level excess'}
                    {record.vehicle_reg && ` — ${record.vehicle_reg}`}
                  </p>
                  <p className="text-xs text-gray-500">
                    Required: {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
                    {' · '}Status: {statusLabel(record.excess_status)}
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
            <button
              onClick={() => setLinkingDeposit(null)}
              className="w-full px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Cancel
            </button>
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
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Payment History</h3>

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

      {/* Hire payment refund modal */}
      {refundingDep && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeRefundModal}>
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
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
                <div className="flex justify-end">
                  <button onClick={closeRefundModal} className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md">Close</button>
                </div>
              </div>
            ) : (
              <div className="px-5 py-4 space-y-3">
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
                    onChange={(e) => setRefundAmount(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 rounded-md"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">Max £{Number(refundingDep.amount).toFixed(2)} (partial refunds OK — submit again for the residual).</p>
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
                {refundError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{refundError}</div>
                )}
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={closeRefundModal} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                  <button onClick={submitRefund} disabled={refundLoading} className="px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50">
                    {refundLoading ? 'Processing...' : 'Confirm Refund'}
                  </button>
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
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
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
              <div className="px-5 py-4 space-y-3">
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
                    onChange={(e) => setRefundAmount(e.target.value)}
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

                {refundError && (
                  <div className="px-3 py-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{refundError}</div>
                )}
                <div className="flex gap-2 justify-end pt-1">
                  <button onClick={closePendingRefundModal} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50">Cancel</button>
                  <button
                    onClick={submitPendingRefund}
                    disabled={refundLoading || !selectedDeposit || (parseFloat(refundAmount) > (selectedDeposit?.amount ?? 0) + 0.005)}
                    className="px-4 py-2 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-md disabled:opacity-50"
                  >
                    {refundLoading ? 'Processing...' : (selectedDeposit?.stripe_payment_intent ? 'Refund via Stripe & complete' : 'Record refund & complete')}
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
  const quotedCost = liveQuotes.reduce((s, q) => s + num(q.freelancer_fee_rounded ?? q.freelancer_fee), 0);
  const clientQuoted = liveQuotes.reduce((s, q) => s + num(q.client_fee), 0);

  const actualCosts = costs.filter((c) => c.cost_intent === 'quote_actual');
  const extraCosts = costs.filter((c) => c.cost_intent === 'extra');
  const unclassified = costs.filter((c) => c.cost_intent == null);

  const actualsTotal = actualCosts.reduce((s, c) => s + num(c.amount_gross), 0);
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
          <div className="text-xs text-gray-400">crew / transport cost</div>
        </div>
        <div className="rounded-md border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Actuals (part of quote)</div>
          <div className="text-lg font-semibold text-gray-900">{m(actualsTotal)}</div>
          <div className="text-xs text-gray-400">{actualCosts.length} cost{actualCosts.length === 1 ? '' : 's'}</div>
        </div>
        <div className="rounded-md border border-gray-200 p-3">
          <div className="text-xs text-gray-500">Variance</div>
          <div className={`text-lg font-semibold ${varianceColour}`}>{varianceLabel}</div>
        </div>
      </div>
      {clientQuoted > 0 && (
        <p className="text-xs text-gray-400 -mt-2 mb-4">Client quoted {m(clientQuoted)} for transport / crew.</p>
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
              const pending = c.recharge_mode !== 'none' && (c.recharge_status ?? 'pending') === 'pending';
              return (
                <li key={c.id} className="flex items-center justify-between text-sm gap-2">
                  <span className="text-gray-600 truncate">{c.supplier_name || c.description || c.category || 'Cost'}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <span className="text-gray-900">{m(num(c.amount_gross))}</span>
                    {c.recharge_mode !== 'none' && <RechargeStatusPill status={c.recharge_status} mode={c.recharge_mode} />}
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

      {unclassified.length > 0 && (
        <p className="text-xs text-gray-400 mt-3">
          {unclassified.length} older cost{unclassified.length === 1 ? '' : 's'} ({m(unclassifiedTotal)}) not yet classified as quote/extra — edit them on the Costs hub to include here.
        </p>
      )}
    </div>
  );
}
