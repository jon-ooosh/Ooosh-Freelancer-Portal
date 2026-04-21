import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';

/**
 * Staff-side completion override for a transport/crewed quote.
 *
 * Primary completion path is the freelancer portal on site — photos,
 * signature, notes. This modal is the fallback: when the freelancer
 * never submits, the portal malfunctions, or we're catching up legacy
 * data. Admin/manager only.
 *
 * Captures the WHY so we have an audit trail. Offers a one-click
 * "nudge the assigned crew first" button as a soft nudge before we
 * bypass them.
 */

interface CompleteQuoteOverrideModalProps {
  quoteId: string;
  /** Optional context for the banner / nudge button. Email isn't carried
   * through the quote-assignments JSON by default; the backend handles the
   * no-email case with a 400 if the nudge button is pressed on someone
   * missing an address. */
  assignees?: Array<{
    id: string;
    name: string;
    is_ooosh_crew: boolean;
  }>;
  onClose: () => void;
  onCompleted: () => void;
}

const MIN_REASON_LENGTH = 10;

export default function CompleteQuoteOverrideModal({
  quoteId,
  assignees = [],
  onClose,
  onCompleted,
}: CompleteQuoteOverrideModalProps) {
  const user = useAuthStore((s) => s.user);
  const canOverride = user?.role === 'admin' || user?.role === 'manager';

  const [reason, setReason] = useState('');
  const [extraNotes, setExtraNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [nudgeSending, setNudgeSending] = useState(false);
  const [nudgedPersonId, setNudgedPersonId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const realAssignees = assignees.filter((a) => !a.is_ooosh_crew);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !submitting) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  async function sendNudge(personId: string) {
    setNudgeSending(true);
    setError(null);
    try {
      await api.post(`/quotes/${quoteId}/nudge-completion`, { personId });
      setNudgedPersonId(personId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send nudge');
    } finally {
      setNudgeSending(false);
    }
  }

  async function handleSubmit() {
    if (reason.trim().length < MIN_REASON_LENGTH) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/quotes/${quoteId}/complete-override`, {
        reason: reason.trim(),
        notes: extraNotes.trim() || undefined,
      });
      onCompleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to mark complete');
      setSubmitting(false);
    }
  }

  if (!canOverride) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Refer to a manager</h3>
          <p className="text-sm text-gray-600 mb-4">
            Only admins and managers can mark a job as complete from here —
            jobs should normally be finished via the freelancer portal.
            Ask a manager to complete on your behalf if the portal isn't an option.
          </p>
          <div className="flex justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const reasonOk = reason.trim().length >= MIN_REASON_LENGTH;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => { if (!submitting) onClose(); }} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold text-gray-900 mb-1">Complete (override)</h3>
        <p className="text-xs text-gray-500 mb-4">
          Jobs should normally be completed by the crew via the freelancer
          portal (on site, with photos + signature). Use this only as a
          fallback — the reason you give here is logged to the job timeline.
        </p>

        {/* Nudge first */}
        {realAssignees.length > 0 && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-sm text-amber-800 mb-2">
              <strong>Try nudging first?</strong> Send the assigned crew a
              reminder before overriding.
            </p>
            <div className="flex flex-wrap gap-2">
              {realAssignees.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  disabled={nudgeSending || nudgedPersonId === a.id}
                  onClick={() => sendNudge(a.id)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white border border-amber-300 text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                >
                  {nudgedPersonId === a.id
                    ? `✓ Nudge sent to ${a.name}`
                    : `Nudge ${a.name}`}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reason — required */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Why are you completing this here instead of via the portal?{' '}
            <span className="text-red-500">*</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Driver has left the site without submitting, confirmed by phone. Catching up legacy job."
            rows={3}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500"
            autoFocus
          />
          {reason.length > 0 && !reasonOk && (
            <p className="text-xs text-amber-600 mt-1">
              A little more detail, please ({MIN_REASON_LENGTH - reason.trim().length} chars to go).
            </p>
          )}
        </div>

        {/* Extra notes */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Completion notes (optional)
          </label>
          <textarea
            value={extraNotes}
            onChange={(e) => setExtraNotes(e.target.value)}
            placeholder="Any issues on site? Delivered OK? Customer comments?"
            rows={2}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:ring-1 focus:ring-ooosh-500 focus:border-ooosh-500"
          />
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 bg-gray-100 text-gray-700 rounded-lg text-sm hover:bg-gray-200 font-medium disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!reasonOk || submitting}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm hover:bg-emerald-700 font-medium disabled:bg-gray-300 disabled:cursor-not-allowed"
          >
            {submitting ? 'Marking complete…' : 'Mark complete'}
          </button>
        </div>
      </div>
    </div>
  );
}
