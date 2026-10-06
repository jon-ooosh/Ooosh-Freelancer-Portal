/**
 * Start a lead search, optionally for a chosen window: "tours starting between
 * X and Y". Pre-filled with the settings default (today + min weeks → today +
 * max weeks); leaving it untouched runs the default search.
 */
import { useState } from 'react';
import { api } from '../../services/api';
import LeadModal from './LeadModal';

export default function RunSearchModal({ defaultWindow, maxDays, onClose, onStarted }: {
  defaultWindow: { from: string; to: string } | null;
  maxDays: number;
  onClose: () => void;
  onStarted: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultWindow?.from ?? today);
  const [to, setTo] = useState(defaultWindow?.to ?? today);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDefault = defaultWindow != null && from === defaultWindow.from && to === defaultWindow.to;
  const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  const problem = !from || !to ? 'Pick both dates'
    : from < today ? 'The search can’t start in the past'
    : to < from ? 'The end date is before the start date'
    : days > maxDays ? 'Keep the window to a year or less'
    : null;

  const start = async () => {
    setStarting(true); setError(null);
    try {
      // The default window goes as no window, so the run records it as a standard search.
      await api.post('/leads/run', isDefault ? {} : { from, to });
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start search');
      setStarting(false);
    }
  };

  return (
    <LeadModal
      title="Run a lead search"
      onClose={onClose}
      footer={(
        <>
          <button onClick={onClose} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
          <button onClick={start} disabled={starting || Boolean(problem)}
            className="px-4 py-2 rounded-lg bg-[#7B5EA7] text-white text-sm font-medium hover:bg-[#6a4f92] disabled:opacity-50">
            {starting ? 'Starting…' : '🔍 Search'}
          </button>
        </>
      )}
    >
      <p className="mb-3 text-gray-500">Find tours whose <b>first UK date</b> falls between:</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">From</span>
          <input type="date" value={from} min={today} onChange={(e) => setFrom(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </label>
        <label className="block">
          <span className="block text-xs text-gray-500 mb-1">To</span>
          <input type="date" value={to} min={from || today} onChange={(e) => setTo(e.target.value)}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm" />
        </label>
        {defaultWindow && !isDefault && (
          <button onClick={() => { setFrom(defaultWindow.from); setTo(defaultWindow.to); }}
            className="text-xs text-[#7B5EA7] hover:underline pb-2">Reset to default</button>
        )}
      </div>
      <p className="mt-3 text-xs text-gray-400">
        {isDefault ? 'This is the standard window from the Leads settings.' : 'A one-off window — the settings aren’t changed.'}
        {' '}It runs in the background and takes a few minutes.
      </p>
      {problem && <div className="mt-3 text-xs text-amber-700">{problem}</div>}
      {error && <div className="mt-3 rounded-lg bg-red-50 text-red-800 px-3 py-2">{error}</div>}
    </LeadModal>
  );
}
