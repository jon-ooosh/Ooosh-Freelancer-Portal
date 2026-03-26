/**
 * ExcessPaymentModal — Slide panel for recording actions against an excess record.
 *
 * Supports: Record Payment, Record Claim, Reimburse, Waive, Roll Over, Move to different entity.
 */
import { useState } from 'react';
import { api } from '../services/api';
import type { JobExcess, ExcessStatus } from '../../../shared/types';

type ModalAction = 'payment' | 'claim' | 'reimburse' | 'waive' | 'rollover' | 'move';

interface ExcessPaymentModalProps {
  excess: JobExcess;
  onClose: () => void;
  onUpdated: () => void;
  initialAction?: ModalAction;
}

const PAYMENT_METHODS = [
  { value: 'payment_portal', label: 'Payment Portal (Stripe)' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'card_in_office', label: 'Card in Office' },
  { value: 'cash', label: 'Cash' },
  { value: 'rolled_over', label: 'Rolled Over from Previous Hire' },
];

const REIMBURSE_METHODS = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'card_refund', label: 'Card Refund' },
  { value: 'cash', label: 'Cash' },
];

function statusLabel(status: ExcessStatus): string {
  const labels: Record<ExcessStatus, string> = {
    not_required: 'Not Required',
    pending: 'Pending',
    taken: 'Collected',
    partial: 'Partial',
    waived: 'Waived',
    claimed: 'Claimed',
    reimbursed: 'Reimbursed',
    rolled_over: 'Rolled Over',
  };
  return labels[status] || status;
}

function statusColor(status: ExcessStatus): string {
  const colors: Record<ExcessStatus, string> = {
    not_required: 'bg-gray-100 text-gray-700',
    pending: 'bg-amber-100 text-amber-800',
    taken: 'bg-green-100 text-green-800',
    partial: 'bg-yellow-100 text-yellow-800',
    waived: 'bg-blue-100 text-blue-800',
    claimed: 'bg-red-100 text-red-800',
    reimbursed: 'bg-emerald-100 text-emerald-800',
    rolled_over: 'bg-purple-100 text-purple-800',
  };
  return colors[status] || 'bg-gray-100 text-gray-700';
}

export { statusLabel, statusColor };

export default function ExcessPaymentModal({ excess, onClose, onUpdated, initialAction }: ExcessPaymentModalProps) {
  const [action, setAction] = useState<ModalAction | null>(initialAction || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Payment form
  const [payAmount, setPayAmount] = useState(
    excess.excess_amount_required
      ? (Number(excess.excess_amount_required) - Number(excess.excess_amount_taken || 0)).toFixed(2)
      : ''
  );
  const [payMethod, setPayMethod] = useState('payment_portal');
  const [payReference, setPayReference] = useState('');

  // Claim form
  const [claimAmount, setClaimAmount] = useState('');
  const [claimNotes, setClaimNotes] = useState('');

  // Reimburse form
  const amountHeld = Number(excess.excess_amount_taken || 0) - Number(excess.claim_amount || 0) - Number(excess.reimbursement_amount || 0);
  const [reimburseAmount, setReimburseAmount] = useState(amountHeld > 0 ? amountHeld.toFixed(2) : '');
  const [reimburseMethod, setReimburseMethod] = useState('bank_transfer');

  // Waive form
  const [waiveReason, setWaiveReason] = useState('');

  // Move form
  const [moveXeroId, setMoveXeroId] = useState('');
  const [moveXeroName, setMoveXeroName] = useState('');
  const [moveReason, setMoveReason] = useState('');

  async function handleSubmit() {
    setLoading(true);
    setError('');
    try {
      switch (action) {
        case 'payment':
          await api.post(`/excess/${excess.id}/payment`, {
            amount: parseFloat(payAmount),
            method: payMethod,
            reference: payReference || null,
          });
          break;
        case 'claim':
          await api.post(`/excess/${excess.id}/claim`, {
            amount: parseFloat(claimAmount),
            notes: claimNotes || null,
          });
          break;
        case 'reimburse':
          await api.post(`/excess/${excess.id}/reimburse`, {
            amount: parseFloat(reimburseAmount),
            method: reimburseMethod,
          });
          break;
        case 'waive':
          await api.post(`/excess/${excess.id}/waive`, {
            reason: waiveReason,
          });
          break;
        case 'rollover':
          await api.put(`/excess/${excess.id}`, {
            excess_status: 'rolled_over',
          });
          break;
        case 'move':
          await api.post(`/excess/${excess.id}/move`, {
            xero_contact_id: moveXeroId,
            xero_contact_name: moveXeroName,
            reason: moveReason || undefined,
          });
          break;
      }
      onUpdated();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Action failed');
    } finally {
      setLoading(false);
    }
  }

  // Available actions based on current status
  const availableActions: { action: ModalAction; label: string; icon: string }[] = [];
  const s = excess.excess_status;

  if (s === 'pending' || s === 'partial') {
    availableActions.push({ action: 'payment', label: 'Record Payment', icon: '£' });
  }
  if (s === 'taken' || s === 'partial') {
    availableActions.push({ action: 'claim', label: 'Record Claim (Damage)', icon: '!' });
    availableActions.push({ action: 'reimburse', label: 'Reimburse', icon: '<' });
    availableActions.push({ action: 'rollover', label: 'Roll Over to Next Hire', icon: '>' });
  }
  if (s === 'claimed' && amountHeld > 0) {
    availableActions.push({ action: 'reimburse', label: 'Reimburse Remainder', icon: '<' });
  }
  if (s === 'pending') {
    availableActions.push({ action: 'waive', label: 'Waive Excess', icon: '~' });
  }
  availableActions.push({ action: 'move', label: 'Move to Different Entity', icon: '>' });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Insurance Excess</h2>
              <p className="text-sm text-gray-500 mt-0.5">
                {excess.driver_name || 'Unknown driver'}
                {excess.vehicle_reg && ` — ${excess.vehicle_reg}`}
                {excess.hirehop_job_name && ` — ${excess.hirehop_job_name}`}
              </p>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="px-6 py-4 bg-gray-50 border-b border-gray-200">
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-xs text-gray-500">Required</p>
              <p className="text-lg font-semibold text-gray-900">
                {excess.excess_amount_required != null ? `£${Number(excess.excess_amount_required).toFixed(2)}` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Collected</p>
              <p className="text-lg font-semibold text-green-700">
                £{Number(excess.excess_amount_taken || 0).toFixed(2)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Status</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusColor(excess.excess_status)}`}>
                {statusLabel(excess.excess_status)}
              </span>
            </div>
          </div>
          {excess.dispatch_override && (
            <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md">
              <p className="text-xs text-amber-700">
                <span className="font-medium">Dispatch override active</span>
                {excess.dispatch_override_reason && ` — ${excess.dispatch_override_reason}`}
              </p>
            </div>
          )}
          {excess.suggested_collection_method === 'pre_auth' && excess.excess_status === 'pending' && (
            <div className="mt-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md">
              <p className="text-xs text-blue-700">
                Short hire — pre-authorisation suggested to save card fees
              </p>
            </div>
          )}
        </div>

        {/* Action selection */}
        {!action && (
          <div className="px-6 py-4">
            <p className="text-sm font-medium text-gray-700 mb-3">Choose an action:</p>
            <div className="space-y-2">
              {availableActions.map((a) => (
                <button
                  key={a.action}
                  onClick={() => setAction(a.action)}
                  className="w-full text-left px-4 py-3 rounded-lg border border-gray-200 hover:border-ooosh-300 hover:bg-ooosh-50 transition-colors"
                >
                  <span className="inline-block w-6 text-center text-gray-400 mr-2 font-mono">{a.icon}</span>
                  <span className="text-sm font-medium text-gray-900">{a.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Action forms */}
        {action && (
          <div className="px-6 py-4">
            <button
              onClick={() => { setAction(null); setError(''); }}
              className="text-xs text-gray-500 hover:text-gray-700 mb-3 flex items-center gap-1"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
              </svg>
              Back to actions
            </button>

            {action === 'payment' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Record Payment</h3>
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
                    value={payReference}
                    onChange={(e) => setPayReference(e.target.value)}
                    placeholder="Stripe ID, transfer ref, etc."
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'claim' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Record Damage Claim</h3>
                <p className="text-xs text-gray-500">
                  Amount currently held: £{amountHeld.toFixed(2)}
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Claim Amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      max={amountHeld}
                      value={claimAmount}
                      onChange={(e) => setClaimAmount(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Notes</label>
                  <textarea
                    value={claimNotes}
                    onChange={(e) => setClaimNotes(e.target.value)}
                    placeholder="Describe the damage..."
                    rows={3}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'reimburse' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Reimburse Excess</h3>
                <p className="text-xs text-gray-500">
                  Amount available to reimburse: £{amountHeld.toFixed(2)}
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reimburse Amount</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500">£</span>
                    <input
                      type="number"
                      step="0.01"
                      max={amountHeld}
                      value={reimburseAmount}
                      onChange={(e) => setReimburseAmount(e.target.value)}
                      className="w-full pl-7 pr-3 py-2 text-sm border border-gray-300 rounded-md"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Method</label>
                  <select
                    value={reimburseMethod}
                    onChange={(e) => setReimburseMethod(e.target.value)}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  >
                    {REIMBURSE_METHODS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {action === 'waive' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Waive Excess</h3>
                <p className="text-xs text-red-600">This will permanently mark this excess as not required.</p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason</label>
                  <textarea
                    value={waiveReason}
                    onChange={(e) => setWaiveReason(e.target.value)}
                    placeholder="Why is this excess being waived?"
                    rows={2}
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {action === 'rollover' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Roll Over to Next Hire</h3>
                <p className="text-xs text-gray-500">
                  Mark £{Number(excess.excess_amount_taken || 0).toFixed(2)} as held on account for the client's next hire.
                  This amount will appear as a credit on their next excess requirement.
                </p>
              </div>
            )}

            {action === 'move' && (
              <div className="space-y-3">
                <h3 className="text-sm font-semibold text-gray-900">Move to Different Entity</h3>
                <p className="text-xs text-gray-500">
                  Reassign this excess record to a different Xero contact (e.g. if the paying entity changed).
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Xero Contact ID</label>
                  <input
                    type="text"
                    value={moveXeroId}
                    onChange={(e) => setMoveXeroId(e.target.value)}
                    placeholder="Xero contact ID"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Contact Name</label>
                  <input
                    type="text"
                    value={moveXeroName}
                    onChange={(e) => setMoveXeroName(e.target.value)}
                    placeholder="Company / person name"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</label>
                  <input
                    type="text"
                    value={moveReason}
                    onChange={(e) => setMoveReason(e.target.value)}
                    placeholder="Why is this being moved?"
                    className="w-full text-sm border border-gray-300 rounded-md px-3 py-2"
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="mt-3 text-xs text-red-600">{error}</p>
            )}

            <div className="mt-4 flex gap-2">
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-ooosh-600 hover:bg-ooosh-700 rounded-md disabled:opacity-50"
              >
                {loading ? 'Processing...' : 'Confirm'}
              </button>
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 border border-gray-300 rounded-md"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
