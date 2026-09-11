import { useState, useEffect } from 'react';
import { api } from '../services/api';
import DatePicker from './DatePicker';
import { hasManagerRole } from '../lib/roles';
import { useAuthStore } from '../hooks/useAuthStore';

interface ChaseableJob {
  id: string;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  chase_count: number;
  next_chase_date?: string | null;
  chase_alert_user_id?: string | null;
  chase_alert_delivery?: 'bell' | 'bell_email' | 'none' | null;
  auto_chase_mode?: 'off' | 'draft' | 'send' | null;
}

type AutoChaseMode = 'off' | 'draft' | 'send';

type Mode = 'reschedule' | 'log';
type Delivery = 'bell' | 'bell_email' | 'none';

function addDaysToDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export default function ChaseModal({
  isOpen,
  job,
  onClose,
  onChaseLogged,
}: {
  isOpen: boolean;
  job: ChaseableJob | null;
  onClose: () => void;
  onChaseLogged: () => void;
}) {
  // Default to 'log' — the common case is "I just chased them, record it".
  // Users switch to 'reschedule' via the tab when they only want to shift
  // the next-chase date without logging an interaction.
  const [mode, setMode] = useState<Mode>('log');
  const [chaseMethod, setChaseMethod] = useState<string>('phone');
  const [content, setContent] = useState('');
  const [nextChaseDate, setNextChaseDate] = useState('');
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>(null);
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [delivery, setDelivery] = useState<Delivery>('none');
  const [autoChaseMode, setAutoChaseMode] = useState<AutoChaseMode>('off');
  const [teamUsers, setTeamUsers] = useState<{ id: string; email: string; first_name: string; last_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const user = useAuthStore(s => s.user);
  const canDraftChase = hasManagerRole(user?.role);
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState<{ to: string; subject: string; threaded: boolean } | null>(null);
  const [draftError, setDraftError] = useState('');
  // Whether auto-SEND is enabled globally — the "Send" option is only offered
  // when it is, so there's no confusing "Send that secretly only drafts".
  const [autoSendEnabled, setAutoSendEnabled] = useState(false);

  useEffect(() => {
    if (isOpen && job) {
      setNextChaseDate(addDaysToDate(5));
      setSelectedChasePreset('5 days');
      setMode('log');
      setContent('');
      setChaseMethod('phone');
      setChaseAlertUserId(job.chase_alert_user_id || '');
      setDelivery(job.chase_alert_delivery || 'none');
      setAutoChaseMode((job.auto_chase_mode as AutoChaseMode) || 'off');
      setError('');
      setDraftResult(null);
      setDraftError('');
      setDrafting(false);
    }
  }, [isOpen, job]);

  useEffect(() => {
    if (isOpen && teamUsers.length === 0) {
      api.get<{ data: { id: string; email: string; first_name: string; last_name: string }[] }>('/users')
        .then(res => setTeamUsers(res.data))
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && canDraftChase) {
      api.get<{ data: { key: string; value: string | null }[] }>('/system-settings?category=chase')
        .then(res => setAutoSendEnabled(res.data.find(s => s.key === 'auto_chase_send_enabled')?.value === 'true'))
        .catch(() => {});
    }
  }, [isOpen, canDraftChase]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen || !job) return null;

  const handleSubmit = async () => {
    if (mode === 'log' && !content.trim()) {
      setError('Please describe what happened');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (mode === 'reschedule') {
        await api.patch(`/pipeline/${job.id}`, {
          next_chase_date: nextChaseDate || null,
          chase_alert_user_id: chaseAlertUserId || null,
          chase_alert_delivery: delivery,
        });
      } else {
        await api.post('/interactions', {
          type: 'chase',
          content: content.trim(),
          job_id: job.id,
          chase_method: chaseMethod,
          next_chase_date: nextChaseDate || undefined,
          chase_alert_user_id: chaseAlertUserId || undefined,
          chase_alert_delivery: delivery,
        });
      }
      // Persist the per-job auto-chase mode if it changed (manager-tier control).
      if (canDraftChase && autoChaseMode !== ((job.auto_chase_mode as AutoChaseMode) || 'off')) {
        await api.patch(`/pipeline/${job.id}`, { auto_chase_mode: autoChaseMode });
      }
      onChaseLogged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDraftChase = async () => {
    if (!job) return;
    setDrafting(true);
    setDraftError('');
    setDraftResult(null);
    try {
      const res = await api.post<{ data: { to: string; subject: string; threaded: boolean } }>(
        `/auto-chase/create-draft/${job.id}`,
        {},
      );
      setDraftResult({ to: res.data.to, subject: res.data.subject, threaded: res.data.threaded });
      // Auto-populate the chase as a logged email (not saved until they click
      // Log Chase). Keep any note they'd already typed.
      setMode('log');
      setChaseMethod('email');
      setContent((prev) => (prev.trim() ? prev : 'Generated auto-chase email — draft created in info@ for review.'));
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Failed to draft chase');
    } finally {
      setDrafting(false);
    }
  };

  const isReschedule = mode === 'reschedule';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] flex flex-col">
        <div className="px-6 pt-6 pb-3">
          <h3 className="text-lg font-semibold mb-1">
            {isReschedule ? 'Reschedule Chase' : 'Log Chase'}
          </h3>
          <p className="text-sm text-gray-500">
            {job.job_name} — {job.company_name || job.client_name}
            {!isReschedule && job.chase_count > 0 && <span className="ml-2 text-gray-400">(chase #{job.chase_count + 1})</span>}
          </p>
        </div>

        <div className="px-6 pb-4 overflow-y-auto flex-1">
        {/* Chase actions — a one-off "chase now" (manual draft) vs setting up
            auto-chase for the due date. Two clearly-separate things. Manager
            tier, and only on the "Log a chase" view (irrelevant to rescheduling). */}
        {canDraftChase && !isReschedule && (
          <div className="mb-3 rounded-lg border border-indigo-200 bg-indigo-50/60 overflow-hidden">
            {/* Chase now — immediate, manual. */}
            <div className="p-2.5 flex items-center justify-between gap-3">
              <div className="text-xs min-w-0">
                <p className="font-medium text-indigo-800">Chase now</p>
                {draftResult ? (
                  <p className="text-indigo-700 mt-0.5">✓ Draft in info@ to {draftResult.to}{draftResult.threaded ? ' (in their thread)' : ''} — send it from Gmail.</p>
                ) : (
                  <p className="text-indigo-600 mt-0.5">Write a chase as a Gmail draft for you to send.</p>
                )}
                {draftError && <p className="text-red-600 mt-0.5">{draftError}</p>}
              </div>
              <button
                type="button"
                onClick={handleDraftChase}
                disabled={drafting}
                className="shrink-0 px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {drafting ? 'Drafting…' : '✨ Draft chase'}
              </button>
            </div>

            {/* Auto-chase — what happens automatically on the due date. */}
            <div className="px-2.5 py-2 border-t border-indigo-100 bg-white/40">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-indigo-800">Auto-chase when due</span>
                <div className="inline-flex p-0.5 bg-white border border-indigo-200 rounded-lg text-xs">
                  {([
                    { k: 'off', label: 'Off' },
                    { k: 'draft', label: 'Draft' },
                    { k: 'send', label: 'Send' },
                  ] as const).map((m) => {
                    const lockedSend = m.k === 'send' && !autoSendEnabled && autoChaseMode !== 'send';
                    return (
                      <button
                        key={m.k}
                        type="button"
                        disabled={lockedSend}
                        title={lockedSend ? 'Turn on auto-send in Settings → Auto-Chase first' : undefined}
                        onClick={() => setAutoChaseMode(m.k)}
                        className={`px-2.5 py-1 rounded-md transition-colors ${
                          autoChaseMode === m.k ? 'bg-indigo-600 text-white font-medium' : 'text-indigo-600 hover:bg-indigo-50'
                        } ${lockedSend ? 'opacity-40 cursor-not-allowed hover:bg-transparent' : ''}`}
                      >
                        {m.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <p className="text-[11px] text-indigo-500 mt-1.5">
                {autoChaseMode === 'off'
                  ? 'Off — you chase it yourself (manually, or with “Chase now” above).'
                  : autoChaseMode === 'draft'
                  ? 'On the chase date, a Gmail draft is auto-written for you to review + send.'
                  : autoSendEnabled
                  ? 'On the chase date, the chase is auto-written and sent. A client reply pauses it; after 3 silent chases it comes back to you.'
                  : 'Auto-send is off globally, so this will only draft until you enable it in Settings → Auto-Chase.'}
              </p>
            </div>
          </div>
        )}

        {/* Mode toggle */}
        <div className="inline-flex p-0.5 mb-4 bg-gray-100 rounded-lg text-xs">
          <button
            type="button"
            onClick={() => setMode('log')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              !isReschedule ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Log a chase
          </button>
          <button
            type="button"
            onClick={() => setMode('reschedule')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              isReschedule ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Just reschedule
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-4">
          {!isReschedule && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">How did you chase?</label>
                <div className="flex gap-2">
                  {(['phone', 'email', 'text', 'whatsapp'] as const).map((method) => (
                    <button
                      key={method}
                      onClick={() => setChaseMethod(method)}
                      className={`px-3 py-1.5 text-sm rounded-lg border ${
                        chaseMethod === method
                          ? 'bg-ooosh-600 text-white border-ooosh-600'
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      {method.charAt(0).toUpperCase() + method.slice(1)}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">What happened? *</label>
                <textarea
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="e.g. Called, left voicemail. Will try again Thursday."
                  rows={3}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {isReschedule ? 'Next chase date' : 'Next chase'}
            </label>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {[
                { label: '2 days', fn: () => addDaysToDate(2) },
                { label: '3 days', fn: () => addDaysToDate(3) },
                { label: '5 days', fn: () => addDaysToDate(5) },
                { label: '14 days', fn: () => addDaysToDate(14) },
              ].map(({ label, fn }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => { setNextChaseDate(fn()); setSelectedChasePreset(label); }}
                  className={`px-2.5 py-1 text-xs border rounded-lg transition-colors ${
                    selectedChasePreset === label
                      ? 'bg-ooosh-600 text-white border-ooosh-600'
                      : 'border-gray-300 hover:bg-gray-50 text-gray-600'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <DatePicker
                value={nextChaseDate}
                onChange={(val) => { setNextChaseDate(val); setSelectedChasePreset(null); }}
              />
              <select
                value={chaseAlertUserId}
                onChange={(e) => setChaseAlertUserId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              >
                <option value="">No one specific</option>
                {teamUsers.map(u => (
                  <option key={u.id} value={u.id}>
                    Alert: {u.first_name} {u.last_name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Delivery preference — how the chase-due alert gets delivered */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">When chase is due, send</label>
            <div className="inline-flex p-0.5 bg-gray-100 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setDelivery('bell')}
                className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                  delivery === 'bell' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                Bell only
              </button>
              <button
                type="button"
                onClick={() => setDelivery('bell_email')}
                className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                  delivery === 'bell_email' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Bell + email
              </button>
              <button
                type="button"
                onClick={() => setDelivery('none')}
                className={`px-3 py-1.5 rounded-md transition-colors flex items-center gap-1.5 ${
                  delivery === 'none' ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
                }`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                None
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mt-1.5">
              {delivery === 'bell'
                ? 'Bell notification only. Email may still follow after 4 hours if unread.'
                : delivery === 'bell_email'
                ? 'Bell plus immediate email when the chase date arrives.'
                : 'No alert. Job will still move into the Chasing pile when the date arrives.'}
            </p>
          </div>
        </div>

        </div>{/* end scrollable body */}

        <div className="flex gap-3 justify-end px-6 py-4 border-t border-gray-100">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : (isReschedule ? 'Save chase date' : 'Log Chase')}
          </button>
        </div>
      </div>
    </div>
  );
}
