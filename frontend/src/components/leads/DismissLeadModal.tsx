/**
 * Dismiss a lead — or several ticked ones at once — with a reason. "Not a fit"
 * stops the band ever coming back. One lead goes through `/leads/:id/dismiss`,
 * several through `/leads/dismiss-bulk` (the same dismiss for each).
 */
import { useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import { DISMISS_REASONS, Lead } from './leadTypes';

export default function DismissLeadModal({ leads, onClose, onDone }: {
  leads: Lead[];
  onClose: () => void;
  /** `dismissed` = how many were dismissed. */
  onDone: (dismissed: number) => void;
}) {
  const [reason, setReason] = useState<string>('timing');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = reason === 'other' && !note.trim();
  const bulk = leads.length > 1;
  const one = leads[0];

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      if (bulk) {
        const r = await api.post<{ data: { dismissed: number; skipped: number } }>('/leads/dismiss-bulk', {
          ids: leads.map((l) => l.id), reason, note: note.trim() || null,
        });
        onDone(r.data.dismissed);
      } else {
        await api.post(`/leads/${one.id}/dismiss`, { reason, note: note.trim() || null });
        onDone(1);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dismiss');
      setSaving(false);
    }
  };

  return (
    <LeadModal
      title={bulk ? `Dismiss ${leads.length} leads` : `Dismiss ${one.artist_name}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={saving || needsNote}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {saving ? 'Dismissing…' : bulk ? `Dismiss ${leads.length}` : 'Dismiss'}
          </button>
        </>
      )}
    >
      <p className="mb-3 text-gray-500">
        {bulk
          ? <>Why? One reason for all {leads.length} — it decides whether each band comes back on a later search.</>
          : <>Why? This decides whether {one.artist_name} comes back on a later search.</>}
      </p>
      {bulk && (
        <p className="mb-3 text-xs text-gray-500">
          {leads.slice(0, 8).map((l) => l.artist_name).join(', ')}{leads.length > 8 ? ` and ${leads.length - 8} more` : ''}
        </p>
      )}
      <div className="space-y-2">
        {DISMISS_REASONS.map((r) => (
          <label key={r.key} className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer ${reason === r.key ? 'border-[#7B5EA7] bg-purple-50' : 'border-gray-200 hover:bg-gray-50'}`}>
            <input type="radio" name="dismiss-reason" className="mt-0.5" checked={reason === r.key} onChange={() => setReason(r.key)} />
            <span>
              <span className="block font-medium text-gray-900">{r.label}</span>
              <span className="block text-xs text-gray-500">{r.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {bulk && reason === 'not_a_fit' && (
        <div className="mt-3 rounded-lg bg-amber-50 text-amber-800 px-3 py-2 text-xs">
          This stops all {leads.length} bands coming back on later searches, and dismisses any other open tours of theirs.
          Restore on the Dismissed tab undoes it.
        </div>
      )}
      <label className="block mt-3">
        <span className="block text-xs text-gray-500 mb-1">Note {reason === 'other' ? '(required)' : '(optional)'}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000}
          placeholder={reason === 'next_time' ? 'e.g. said to try again for the spring tour' : ''}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
      </label>
      {error && <div className="mt-3 rounded-lg bg-red-50 text-red-800 px-3 py-2">{error}</div>}
    </LeadModal>
  );
}
