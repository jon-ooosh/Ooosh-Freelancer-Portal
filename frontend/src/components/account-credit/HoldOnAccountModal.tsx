import { useState } from 'react';
import { api } from '../../services/api';
import { type CloseOutPlan, publishCloseOutPlan } from '../../lib/closeOutPlan';
import { acMoney, acError } from '../../lib/accountCredit';

/**
 * "Hold on account" — the third thing to do with money a client overpaid, beside Refund
 * and Apply to another job (docs/CREDIT-ON-ACCOUNT-SPEC.md). It holds ALL of the job's
 * unallocated hire money, whichever payment it sits on: the server reads the figure from
 * HireHop, the amount here is only what the page last saw. Nothing moves in HireHop or
 * Xero, so any staff role can do it.
 */
export default function HoldOnAccountModal({ jobId, amount, clientName, cancelled = false, onClose, onDone }: {
  jobId: string;
  amount: number;
  clientName?: string | null;
  /** A cancelled job: the money is the refund due after the fee, and its pending refund is cleared. */
  cancelled?: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const who = clientName || 'the client';

  async function save() {
    setSaving(true);
    setError('');
    try {
      const r = await api.post<{ data: { plan: CloseOutPlan } }>('/account-credit/hold', { job_id: jobId, note: note.trim() || null });
      publishCloseOutPlan(jobId, r.data.plan);
      onDone?.();
      onClose();
    } catch (e) {
      setError(acError(e, 'Could not hold it on account.'));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => { if (!saving) onClose(); }}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <h3 className="text-lg font-semibold text-gray-900">Hold {acMoney(amount)} on account</h3>
          <p className="text-sm text-gray-600 mt-1">
            {cancelled
              ? <>Keep what is due back to {who} after the cancellation fee for their next booking, instead of refunding it.</>
              : <>Keep what {who} overpaid on this job for their next hire, instead of refunding it.</>}
          </p>
        </div>
        <div className="px-5 py-4 space-y-4">
          <ul className="text-sm text-gray-700 space-y-1.5 list-disc pl-5">
            <li>The money stays where it is, on this job's payments. Nothing changes in HireHop or Xero.</li>
            <li>It shows on {who}'s other jobs and enquiries, with a "Use on this job" button.</li>
            <li>It comes off that job's invoice when it is invoiced. Whatever isn't needed stays on account.</li>
            {cancelled && <li>The pending refund on this job is cleared, marked "held on account". It comes back if a manager stops holding it.</li>}
            <li>It can still be refunded at any time.</li>
          </ul>
          <div>
            <label htmlFor="ac-note" className="block text-xs font-semibold text-gray-700 mb-1">Note (staff only, optional)</label>
            <textarea id="ac-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" placeholder="e.g. Louise asked us to keep it for the March tour" />
          </div>
          {error && <div className="text-sm text-red-600">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} disabled={saving} className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="button" onClick={() => void save()} disabled={saving}
              className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Hold on account'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
