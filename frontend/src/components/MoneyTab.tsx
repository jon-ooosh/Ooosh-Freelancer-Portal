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
  excess: {
    records: (JobExcess & { driver_name?: string; vehicle_reg?: string })[];
    total_required: number;
    total_collected: number;
    status: string | null;
  };
  client_balance_on_account: number;
}

const PAYMENT_METHODS = [
  { value: 'worldpay', label: 'Worldpay (all cards EXCEPT AMEX)' },
  { value: 'amex', label: 'Amex' },
  { value: 'stripe_gbp', label: 'Stripe GBP' },
  { value: 'wise_bacs', label: 'Wise - Current Account (BACS)' },
  { value: 'till_cash', label: 'Till (Cash)' },
  { value: 'paypal', label: 'Paypal' },
  { value: 'lloyds_bank', label: 'Lloyds Bank' },
  { value: 'rolled_over', label: 'Applied from Account Balance' },
];

const PAYMENT_TYPES = [
  { value: 'deposit', label: 'Deposit' },
  { value: 'balance', label: 'Balance Payment' },
  { value: 'excess', label: 'Insurance Excess' },
  { value: 'other', label: 'Other' },
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

  async function handleRecordPayment() {
    if (!payAmount || parseFloat(payAmount) <= 0) {
      setPayError('Enter a valid amount');
      return;
    }
    setPayLoading(true);
    setPayError('');
    try {
      await api.post(`/money/${jobId}/record-payment`, {
        payment_type: payType,
        amount: parseFloat(payAmount),
        payment_method: payMethod,
        payment_reference: payRef || undefined,
        notes: payNotes || undefined,
        excess_id: payType === 'excess' && payExcessId ? payExcessId : undefined,
        push_to_hirehop: payPushToHH,
      });
      setShowPaymentForm(false);
      setPayAmount('');
      setPayRef('');
      setPayNotes('');
      loadData();
    } catch (err: any) {
      setPayError(err.message || 'Failed to record payment');
    } finally {
      setPayLoading(false);
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
    ? Math.min(100, (financial.total_deposits / financial.hire_value_inc_vat) * 100)
    : 0;

  return (
    <div className="space-y-6">
      {/* Financial Summary */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">Financial Summary</h3>

        {financial.hire_value_ex_vat > 0 ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              <div>
                <p className="text-xs text-gray-500">Hire Value (ex VAT)</p>
                <p className="text-lg font-bold text-gray-900">£{financial.hire_value_ex_vat.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">VAT</p>
                <p className="text-lg font-bold text-gray-900">£{financial.vat_amount.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Total (inc VAT)</p>
                <p className="text-lg font-bold text-gray-900">£{financial.hire_value_inc_vat.toFixed(2)}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Deposits Received</p>
                <p className="text-lg font-bold text-green-700">£{financial.total_deposits.toFixed(2)}</p>
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

      {/* Insurance Excess */}
      {excess.records.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Insurance Excess</h3>
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
                    {record.dispatch_override && (
                      <span className="text-[10px] text-amber-600 font-medium">overridden</span>
                    )}
                    {record.suggested_collection_method === 'pre_auth' && record.excess_status === 'pending' && (
                      <span className="text-[10px] text-blue-600 font-medium">pre-auth suggested</span>
                    )}
                  </div>
                  <p className="text-sm text-gray-900 mt-1">
                    {record.driver_name || 'Unknown driver'}
                    {record.vehicle_reg && ` — ${record.vehicle_reg}`}
                  </p>
                  <p className="text-xs text-gray-500">
                    Required: £{Number(record.excess_amount_required || 0).toFixed(2)}
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
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">Payment History</h3>
          <button
            onClick={() => setShowPaymentForm(true)}
            className="px-3 py-1.5 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md"
          >
            Record Payment
          </button>
        </div>

        {/* Payment history — read from HireHop (source of truth) */}
        {(() => {
          // Separate hire and excess deposits
          const hireDeposits = financial.deposits.filter(d => !d.is_excess);
          const excessDeposits = financial.deposits.filter(d => d.is_excess);

          if (financial.deposits.length === 0) {
            return <p className="text-sm text-gray-500">No payments recorded yet.</p>;
          }

          const renderDeposit = (dep: typeof financial.deposits[0]) => (
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
          );

          return (
            <div className="space-y-4">
              {hireDeposits.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Hire Payments</p>
                  <div className="divide-y divide-gray-100">
                    {hireDeposits.map(renderDeposit)}
                  </div>
                </div>
              )}
              {excessDeposits.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Excess Payments</p>
                  <div className="divide-y divide-gray-100">
                    {excessDeposits.map(renderDeposit)}
                  </div>
                </div>
              )}
            </div>
          );
        })()}
      </div>

      {/* Record Payment Form */}
      {showPaymentForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPaymentForm(false)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Record Payment</h3>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Payment Type</label>
                <select
                  value={payType}
                  onChange={(e) => setPayType(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                >
                  {PAYMENT_TYPES.map((t) => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
              </div>

              {payType === 'excess' && excess.records.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Link to Excess Record</label>
                  <select
                    value={payExcessId}
                    onChange={(e) => setPayExcessId(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    <option value="">Select excess record...</option>
                    {excess.records.filter((r) => r.excess_status === 'pending' || r.excess_status === 'partial').map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.driver_name || 'Unknown'} — £{Number(r.excess_amount_required || 0).toFixed(2)} ({statusLabel(r.excess_status)})
                      </option>
                    ))}
                  </select>
                </div>
              )}

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

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value)}
                  className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                >
                  {PAYMENT_METHODS.map((m) => (
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

              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleRecordPayment}
                  disabled={payLoading}
                  className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50"
                >
                  {payLoading ? 'Recording...' : 'Record Payment'}
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
      )}

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
