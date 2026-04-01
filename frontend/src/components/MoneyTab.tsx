/**
 * MoneyTab — Unified financial view for a job.
 *
 * Shows: HireHop financial summary, insurance excess, payment history,
 * record payment form, client account balance.
 */
import { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import ExcessPaymentModal, { statusLabel, statusColor } from './ExcessPaymentModal';
import type { JobExcess } from '../../../shared/types';

interface MoneyTabProps {
  jobId: string;
  job: any; // Job object from parent
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
    balance_outstanding: number;
    required_deposit: number;
    deposit_paid: boolean;
    deposit_percent: number;
    deposits: Array<{
      id: number; amount: number; date: string;
      description: string | null; memo: string | null;
      is_excess: boolean; is_refund: boolean;
      bank_name: string | null; entered_by: string | null;
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

export default function MoneyTab({ jobId, job }: MoneyTabProps) {
  const [data, setData] = useState<FinancialData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Record payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [payType, setPayType] = useState('deposit');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState('worldpay');
  const [payRef, setPayRef] = useState('');
  const [payNotes, setPayNotes] = useState('');
  const [payExcessId, setPayExcessId] = useState('');
  const [payPushToHH, setPayPushToHH] = useState(true);
  const [payLoading, setPayLoading] = useState(false);
  const [payError, setPayError] = useState('');

  // Excess action modal
  const [actionExcess, setActionExcess] = useState<JobExcess | null>(null);

  // Link deposit state
  const [linkingDeposit, setLinkingDeposit] = useState<{ hh_deposit_id: number; amount: number } | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);

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

  useEffect(() => { loadData(); }, [loadData]);

  // Escape key closes payment modal
  useEffect(() => {
    if (!showPaymentForm) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowPaymentForm(false); };
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
    try {
      const isExcess = (typeOverride === 'excess' || payType === 'excess');
      let excessId = isExcess ? payExcessId : undefined;

      // If recording excess but no excess record selected, create one first
      if (isExcess && !excessId) {
        const createResult = await api.post<{ data: { id: string } }>('/excess/create', {
          job_id: jobId,
          excess_amount_required: parseFloat(payAmount),
          excess_calculation_basis: 'Manual entry from Money tab',
          client_name: job.client_name || job.company_name || undefined,
        });
        excessId = createResult.data.id;
      }

      await api.post(`/money/${jobId}/record-payment`, {
        payment_type: typeOverride || payType,
        amount: parseFloat(payAmount),
        payment_method: payMethod,
        payment_reference: payRef || undefined,
        notes: payNotes || undefined,
        excess_id: excessId || undefined,
        push_to_hirehop: payPushToHH,
      });
      setShowPaymentForm(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      setPayExcessId('');
      loadData();
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
      const createResult = await api.post<{ data: { id: string } }>('/excess/create-from-hh', {
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
    ? Math.min(100, (financial.total_hire_deposits / financial.hire_value_inc_vat) * 100)
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
                <span>Payment Progress</span>
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
              <p className={`text-sm font-semibold ${financial.balance_outstanding > 0 ? 'text-red-600' : 'text-green-600'}`}>
                Balance Outstanding: £{financial.balance_outstanding.toFixed(2)}
              </p>
            </div>

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
                  </div>
                  <p className="text-sm text-gray-900 mt-1">
                    {record.driver_name || record.client_name || 'Job-level excess'}
                    {record.vehicle_reg && ` — ${record.vehicle_reg}`}
                  </p>
                  <p className="text-xs text-gray-500">
                    Required: {record.excess_amount_required != null ? `£${Number(record.excess_amount_required).toFixed(2)}` : '—'}
                    {' · '}
                    Collected: £{Number(record.excess_amount_taken || 0).toFixed(2)}
                  </p>
                </div>
                <button
                  onClick={() => setActionExcess(record)}
                  className="px-3 py-1.5 text-xs font-medium text-ooosh-600 hover:text-ooosh-800 border border-ooosh-200 rounded-md hover:bg-ooosh-50"
                >
                  Manage
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">
            No excess tracked yet. Use "Record Payment" above and toggle to "Insurance Excess" to log excess against this job.
          </p>
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
                      £{dep.amount.toFixed(2)}
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
              HireHop deposit <strong>#{linkingDeposit.hh_deposit_id}</strong> for <strong>£{linkingDeposit.amount.toFixed(2)}</strong>.
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
                  Creates an OP record for £{linkingDeposit.amount.toFixed(2)} linked to this HireHop deposit
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
                <div key={dep.id} className="py-2.5 flex items-center justify-between">
                  <div className="flex-1">
                    <p className="text-sm text-gray-700">
                      {dep.date ? new Date(dep.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
                      {dep.bank_name && <span className="text-gray-500"> — {dep.bank_name}</span>}
                    </p>
                    {dep.description && (
                      <p className="text-xs text-gray-400 mt-0.5">{dep.description}</p>
                    )}
                  </div>
                  <p className={`text-sm font-semibold ${dep.is_refund ? 'text-red-600' : 'text-gray-900'}`}>
                    {dep.is_refund ? '-' : ''}£{dep.amount.toFixed(2)}
                  </p>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {/* Record Payment Form */}
      {showPaymentForm && (() => {
        // Smart payment options
        const total = financial.hire_value_inc_vat;
        const remaining = financial.balance_outstanding;
        const minDeposit = total < 400 ? total : Math.max(total * 0.25, 100);
        const halfPayment = Math.round(total * 0.5);
        const isExcessMode = payType === 'excess';

        // Quick amounts (only for hire payments, not excess)
        const quickAmounts: { label: string; amount: number }[] = [];
        if (!isExcessMode && total > 0) {
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
        const autoType = isExcessMode ? 'excess' : (!financial.deposit_paid ? 'deposit' : 'balance');

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPaymentForm(false)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Record Payment</h3>

              <div className="space-y-3">
                {/* Toggle: Hire Payment vs Insurance Excess */}
                <div className="flex bg-gray-100 rounded-lg p-0.5 mb-1">
                  <button
                    onClick={() => { setPayType('deposit'); setPayAmount(''); }}
                    className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      !isExcessMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                    }`}
                  >
                    Hire Payment
                  </button>
                  <button
                    onClick={() => { setPayType('excess'); setPayAmount(''); }}
                    className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                      isExcessMode ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'
                    }`}
                  >
                    Insurance Excess
                  </button>
                </div>

                {/* Excess: link to existing record or create new */}
                {isExcessMode && (() => {
                  const pendingRecords = excess.records.filter(r => ['needed', 'pending', 'partially_paid', 'partial'].includes(r.excess_status));

                  if (pendingRecords.length === 0) {
                    // No existing excess records — will auto-create on submit
                    return (
                      <div className="px-3 py-2 text-xs bg-blue-50 border border-blue-200 rounded-md text-blue-700">
                        No excess record exists for this job yet. One will be created automatically when you record this payment.
                        It will be logged against: <strong>{job.client_name || job.company_name || 'this job'}</strong>
                      </div>
                    );
                  }

                  // Auto-select if only one pending record and nothing selected yet
                  if (pendingRecords.length === 1 && !payExcessId) {
                    const rec = pendingRecords[0];
                    setTimeout(() => {
                      setPayExcessId(rec.id);
                      setPayAmount(String(Math.max(0, Number(rec.excess_amount_required || 0) - Number(rec.excess_amount_taken || 0)).toFixed(2)));
                    }, 0);
                  }

                  return (
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">Excess Record</label>
                      {pendingRecords.length === 1 ? (
                        <div className="px-3 py-2 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-700">
                          {pendingRecords[0].driver_name || pendingRecords[0].client_name || 'Unknown'} — £{Number(pendingRecords[0].excess_amount_required || 0).toFixed(2)}
                        </div>
                      ) : (
                        <select
                          value={payExcessId}
                          onChange={(e) => {
                            setPayExcessId(e.target.value);
                            const rec = excess.records.find(r => r.id === e.target.value);
                            if (rec) setPayAmount(String(Math.max(0, Number(rec.excess_amount_required || 0) - Number(rec.excess_amount_taken || 0)).toFixed(2)));
                          }}
                          className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                        >
                          <option value="">Select excess record...</option>
                          {pendingRecords.map(r => (
                            <option key={r.id} value={r.id}>
                              {r.driver_name || r.client_name || 'Unknown'} — £{Number(r.excess_amount_required || 0).toFixed(2)} ({statusLabel(r.excess_status)})
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })()}

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
                    {client_balance_on_account > 0 && isExcessMode && (
                      <option value="rolled_over">Applied from Account Balance (£{client_balance_on_account.toFixed(2)} available)</option>
                    )}
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

                <div className="flex gap-2 pt-2">
                  <button
                    onClick={() => handleRecordPayment(isExcessMode ? 'excess' : autoType)}
                    disabled={payLoading}
                    className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50"
                  >
                    {payLoading ? 'Recording...' : `Record ${isExcessMode ? 'Excess' : 'Payment'}`}
                  </button>
                  <button
                    onClick={() => { setShowPaymentForm(false); setPayError(''); }}
                    className="px-4 py-2 text-sm font-medium text-gray-600 border border-gray-300 rounded-md"
                  >
                    Cancel
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
    </div>
  );
}
