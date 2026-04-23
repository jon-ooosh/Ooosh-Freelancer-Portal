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
}

type Mode = 'reschedule' | 'log';

function addHoursToNow(hours: number): string {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString().split('T')[0];
}

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
  // Default to 'reschedule' when a chase date already exists — that's the
  // common case ("I just want to shift it by a few days"). If there's no
  // date yet, default to 'log' because logging the first chase is the
  // natural way to set the schedule going.
  const [mode, setMode] = useState<Mode>('reschedule');
  const [chaseMethod, setChaseMethod] = useState<string>('phone');
  const [content, setContent] = useState('');
  const [chaseResponse, setChaseResponse] = useState('');
  const [nextChaseDate, setNextChaseDate] = useState('');
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>(null);
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [teamUsers, setTeamUsers] = useState<{ id: string; email: string; first_name: string; last_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && job) {
      // If the job already has a chase date, pre-fill with it (so editing is
      // a true nudge rather than a jump to today+5). Otherwise default to 5d.
      const existing = job.next_chase_date;
      if (existing) {
        setNextChaseDate(existing.slice(0, 10));
        setSelectedChasePreset(null);
        setMode('reschedule');
      } else {
        setNextChaseDate(addDaysToDate(5));
        setSelectedChasePreset('5 days');
        setMode('log');
      }
      setContent('');
      setChaseResponse('');
      setChaseMethod('phone');
      setChaseAlertUserId('');
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
        // Just shift the chase date — no interaction, no chase_count bump.
        await api.patch(`/pipeline/${job.id}`, {
          next_chase_date: nextChaseDate || null,
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
            onClick={() => setMode('reschedule')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              isReschedule ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Just reschedule
          </button>
          <button
            type="button"
            onClick={() => setMode('log')}
            className={`px-3 py-1.5 rounded-md transition-colors ${
              !isReschedule ? 'bg-white shadow-sm text-gray-900 font-medium' : 'text-gray-600 hover:text-gray-800'
            }`}
          >
            Log a chase
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
                { label: '2 hrs', fn: () => addHoursToNow(2) },
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
                <option value="">No alert</option>
                {teamUsers.map(u => (
                  <option key={u.id} value={u.id}>
                    Alert: {u.first_name} {u.last_name}
                  </option>
                ))}
              </select>
            </div>
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
