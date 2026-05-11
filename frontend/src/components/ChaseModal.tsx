import { useState, useEffect } from 'react';
import { api } from '../services/api';
import DatePicker from './DatePicker';

interface ChaseableJob {
  id: string;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
  chase_count: number;
  next_chase_date?: string | null;
  chase_alert_user_id?: string | null;
  chase_alert_delivery?: 'bell' | 'bell_email' | 'none' | null;
}

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
  const [chaseResponse, setChaseResponse] = useState('');
  const [nextChaseDate, setNextChaseDate] = useState('');
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>(null);
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [delivery, setDelivery] = useState<Delivery>('none');
  const [teamUsers, setTeamUsers] = useState<{ id: string; email: string; first_name: string; last_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && job) {
      const existing = job.next_chase_date;
      if (existing) {
        setNextChaseDate(existing.slice(0, 10));
        setSelectedChasePreset(null);
      } else {
        setNextChaseDate(addDaysToDate(5));
        setSelectedChasePreset('5 days');
      }
      setMode('log');
      setContent('');
      setChaseResponse('');
      setChaseMethod('phone');
      setChaseAlertUserId(job.chase_alert_user_id || '');
      setDelivery(job.chase_alert_delivery || 'none');
      setError('');
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
          chase_response: chaseResponse || undefined,
          next_chase_date: nextChaseDate || undefined,
          chase_alert_user_id: chaseAlertUserId || undefined,
          chase_alert_delivery: delivery,
        });
      }
      onChaseLogged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const isReschedule = mode === 'reschedule';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-1">
          {isReschedule ? 'Reschedule Chase' : 'Log Chase'}
        </h3>
        <p className="text-sm text-gray-500 mb-4">
          {job.job_name} — {job.company_name || job.client_name}
          {!isReschedule && job.chase_count > 0 && <span className="ml-2 text-gray-400">(chase #{job.chase_count + 1})</span>}
        </p>

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

        {/* Fixed min-height prevents the dialog jumping when switching modes */}
        <div className="space-y-4 min-h-[360px]">
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

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Response (optional)</label>
                <input
                  type="text"
                  value={chaseResponse}
                  onChange={(e) => setChaseResponse(e.target.value)}
                  placeholder="e.g. No answer / Waiting on budget sign-off / Will confirm Friday"
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

        <div className="flex gap-3 justify-end mt-6">
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
