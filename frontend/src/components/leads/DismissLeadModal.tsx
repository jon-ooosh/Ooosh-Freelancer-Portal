/** Dismiss a lead with a reason. "Not a fit" stops the band ever coming back. */
import { useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';
import { DISMISS_REASONS, Lead } from './leadTypes';

export default function DismissLeadModal({ lead, onClose, onDone }: {
  lead: Lead;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<string>('timing');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsNote = reason === 'other' && !note.trim();

  const submit = async () => {
    setSaving(true); setError(null);
    try {
      await api.post(`/leads/${lead.id}/dismiss`, { reason, note: note.trim() || null });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to dismiss');
      setSaving(false);
    }
  };

  return (
    <LeadModal
      title={`Dismiss ${lead.artist_name}`}
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={submit} disabled={saving || needsNote}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {saving ? 'Dismissing…' : 'Dismiss'}
          </button>
        </>
      )}
    >
      <p className="mb-3 text-gray-500">Why? This decides whether {lead.artist_name} comes back on a later search.</p>
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
