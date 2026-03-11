import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import type {
  Job, PipelineStatus, Likelihood, HoldReason, ConfirmedMethod,
} from '@shared/index';
import { PIPELINE_STATUS_CONFIG, HOLD_REASON_LABELS, LOST_REASON_OPTIONS } from '@shared/index';

// ── Types ──────────────────────────────────────────────────────────────────

interface PipelineStats {
  by_status: Array<{ pipeline_status: string; count: string; total_value: string }>;
  chase: { overdue: string; due_today: string; due_this_week: string };
  active_pipeline_value: number;
}

interface PipelineResponse {
  data: Job[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

interface SearchResult {
  id: string;
  name: string;
  subtitle: string | null;
  type: 'person' | 'organisation' | 'venue';
}

type SortMode = 'chase_date' | 'job_date_nearest' | 'job_date_furthest' | 'value_high' | 'value_low' | 'newest';

// ── Column order ───────────────────────────────────────────────────────────

const COLUMN_ORDER: PipelineStatus[] = [
  'new_enquiry', 'chasing', 'provisional', 'paused', 'confirmed', 'lost',
];

// ── Helpers ────────────────────────────────────────────────────────────────

function formatCurrency(value: number | null): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 0 }).format(value);
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return '';
  const s = new Date(start);
  const startStr = s.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (!end) return startStr;
  const e = new Date(end);
  const sameMonth = s.getMonth() === e.getMonth() && s.getFullYear() === e.getFullYear();
  if (sameMonth) return `${s.getDate()}–${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  return `${startStr} – ${e.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
}

function chaseDueLabel(nextChaseDate: string | null): { text: string; urgency: 'overdue' | 'today' | 'upcoming' | 'none' } {
  if (!nextChaseDate) return { text: '', urgency: 'none' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const chase = new Date(nextChaseDate); chase.setHours(0, 0, 0, 0);
  const diffDays = Math.round((chase.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return { text: `${Math.abs(diffDays)}d overdue`, urgency: 'overdue' };
  if (diffDays === 0) return { text: 'Due today', urgency: 'today' };
  if (diffDays === 1) return { text: 'Tomorrow', urgency: 'upcoming' };
  return { text: `In ${diffDays}d`, urgency: 'upcoming' };
}

function likelihoodColour(l: Likelihood | null): string {
  if (l === 'hot') return 'text-red-600 bg-red-50';
  if (l === 'warm') return 'text-amber-600 bg-amber-50';
  if (l === 'cold') return 'text-blue-600 bg-blue-50';
  return 'text-gray-400 bg-gray-50';
}

function getInitials(name: string | null): string {
  if (!name) return '';
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2);
}

function sortJobs(jobs: Job[], mode: SortMode): Job[] {
  const sorted = [...jobs];
  sorted.sort((a, b) => {
    switch (mode) {
      case 'chase_date': {
        const aDate = a.next_chase_date ? new Date(a.next_chase_date).getTime() : Infinity;
        const bDate = b.next_chase_date ? new Date(b.next_chase_date).getTime() : Infinity;
        if (aDate !== bDate) return aDate - bDate;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      case 'job_date_nearest': {
        const aDate = a.job_date ? new Date(a.job_date).getTime() : Infinity;
        const bDate = b.job_date ? new Date(b.job_date).getTime() : Infinity;
        return aDate - bDate;
      }
      case 'job_date_furthest': {
        const aDate = a.job_date ? new Date(a.job_date).getTime() : -Infinity;
        const bDate = b.job_date ? new Date(b.job_date).getTime() : -Infinity;
        return bDate - aDate;
      }
      case 'value_high': {
        return (b.job_value || 0) - (a.job_value || 0);
      }
      case 'value_low': {
        return (a.job_value || 0) - (b.job_value || 0);
      }
      case 'newest': {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
      default:
        return 0;
    }
  });
  return sorted;
}

// ── Client Picker (search People & Organisations) ──────────────────────────

function ClientPicker({
  value,
  onChange,
  onSelect,
}: {
  value: string;
  onChange: (name: string) => void;
  onSelect: (result: SearchResult) => void;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const doSearch = useCallback(async (term: string) => {
    if (term.length < 2) { setResults([]); setShowDropdown(false); return; }
    setSearching(true);
    try {
      const data = await api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}&limit=10`);
      // Only show people and organisations (not venues)
      const filtered = data.results.filter(r => r.type === 'person' || r.type === 'organisation');
      setResults(filtered);
      setShowDropdown(filtered.length > 0);
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleChange = (text: string) => {
    onChange(text);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(text), 250);
  };

  const handleSelect = (result: SearchResult) => {
    onSelect(result);
    onChange(result.name);
    setShowDropdown(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => { if (results.length > 0) setShowDropdown(true); }}
        placeholder="Search people or organisations..."
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
      />
      {searching && (
        <div className="absolute right-3 top-2.5">
          <div className="animate-spin h-4 w-4 border-2 border-ooosh-500 border-t-transparent rounded-full" />
        </div>
      )}
      {showDropdown && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-y-auto">
          {results.map((r) => (
            <button
              key={`${r.type}-${r.id}`}
              onClick={() => handleSelect(r)}
              className="w-full text-left px-3 py-2 hover:bg-gray-50 flex items-center gap-2"
            >
              <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                r.type === 'organisation' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'
              }`}>
                {r.type === 'organisation' ? 'Org' : 'Person'}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{r.name}</div>
                {r.subtitle && <div className="text-xs text-gray-400 truncate">{r.subtitle}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Pipeline Card ──────────────────────────────────────────────────────────

function PipelineCard({
  job,
  onDragStart,
  onClick,
  onChase,
}: {
  job: Job;
  onDragStart: (e: React.DragEvent, job: Job) => void;
  onClick: (job: Job) => void;
  onChase: (job: Job) => void;
}) {
  const chase = chaseDueLabel(job.next_chase_date);
  const borderClass =
    chase.urgency === 'overdue' ? 'border-l-4 border-l-red-500' :
    chase.urgency === 'today' ? 'border-l-4 border-l-amber-400' :
    'border-l-4 border-l-transparent';

  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, job)}
      onClick={() => onClick(job)}
      className={`bg-white rounded-lg shadow-sm border border-gray-200 p-3 cursor-grab active:cursor-grabbing
        hover:shadow-md transition-shadow ${borderClass}`}
    >
      {/* Row 1: Job number + value */}
      <div className="flex items-center justify-between mb-1">
        {job.hh_job_number ? (
          <a
            href={`https://myhirehop.com/job.php?id=${job.hh_job_number}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline"
            title="Open in HireHop"
          >
            J-{job.hh_job_number}
          </a>
        ) : (
          <span className="text-xs font-mono text-gray-400">NEW</span>
        )}
        <span className="text-sm font-semibold text-gray-900">
          {formatCurrency(job.job_value)}
        </span>
      </div>

      {/* Row 2: Job name */}
      <div className="text-sm font-medium text-gray-900 truncate mb-0.5">
        {job.job_name || 'Untitled'}
      </div>

      {/* Row 3: Client */}
      <div className="text-xs text-gray-500 truncate mb-2">
        {job.company_name || job.client_name || '—'}
      </div>

      {/* Row 4: Dates */}
      {job.job_date && (
        <div className="text-xs text-gray-400 mb-2">
          {formatDateRange(job.job_date, job.job_end)}
        </div>
      )}

      {/* Row 5: Likelihood + chase count + file count */}
      <div className="flex items-center gap-2 mb-1">
        {job.likelihood && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${likelihoodColour(job.likelihood)}`}>
            {job.likelihood.charAt(0).toUpperCase() + job.likelihood.slice(1)}
          </span>
        )}
        {job.chase_count > 0 && (
          <span className="text-xs text-gray-400">
            Chased x{job.chase_count}
          </span>
        )}
        {job.files && job.files.length > 0 && (
          <span className="text-xs text-gray-400" title={`${job.files.length} file${job.files.length !== 1 ? 's' : ''} attached`}>
            {job.files.length} file{job.files.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Row 6: Chase due + chase button + manager */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {chase.text ? (
            <span className={`text-xs font-medium ${
              chase.urgency === 'overdue' ? 'text-red-600' :
              chase.urgency === 'today' ? 'text-amber-600' : 'text-gray-400'
            }`}>
              {chase.text}
            </span>
          ) : <span />}
          <button
            onClick={(e) => { e.stopPropagation(); onChase(job); }}
            className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium hover:underline"
            title="Log a chase"
          >
            Chase
          </button>
        </div>
        {job.manager1_name && (
          <span className="text-xs text-gray-400 font-medium">
            {getInitials(job.manager1_name)}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Status Transition Modal ────────────────────────────────────────────────

function TransitionModal({
  isOpen,
  targetStatus,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  targetStatus: PipelineStatus | null;
  onConfirm: (data: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [holdReason, setHoldReason] = useState<HoldReason>('client_undecided');
  const [holdDetail, setHoldDetail] = useState('');
  const [confirmedMethod, setConfirmedMethod] = useState<ConfirmedMethod>('deposit');
  const [lostReason, setLostReason] = useState('Price');
  const [lostDetail, setLostDetail] = useState('');
  const [note, setNote] = useState('');

  if (!isOpen || !targetStatus) return null;

  const handleSubmit = () => {
    const data: Record<string, string> = {};
    if (targetStatus === 'paused') {
      data.hold_reason = holdReason;
      if (holdDetail) data.hold_reason_detail = holdDetail;
    } else if (targetStatus === 'confirmed') {
      data.confirmed_method = confirmedMethod;
    } else if (targetStatus === 'lost') {
      data.lost_reason = lostReason;
      if (lostDetail) data.lost_detail = lostDetail;
    }
    if (note) data.transition_note = note;
    onConfirm(data);
  };

  const config = PIPELINE_STATUS_CONFIG[targetStatus];
  const needsPrompt = ['paused', 'confirmed', 'lost'].includes(targetStatus);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-4">
          Move to <span style={{ color: config.colour }}>{config.label}</span>
        </h3>

        {targetStatus === 'paused' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">Reason for pausing</label>
            <select
              value={holdReason}
              onChange={(e) => setHoldReason(e.target.value as HoldReason)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              {Object.entries(HOLD_REASON_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            {holdReason === 'other' && (
              <input
                type="text"
                placeholder="Details..."
                value={holdDetail}
                onChange={(e) => setHoldDetail(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            )}
          </div>
        )}

        {targetStatus === 'confirmed' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">How was this confirmed?</label>
            <select
              value={confirmedMethod}
              onChange={(e) => setConfirmedMethod(e.target.value as ConfirmedMethod)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              <option value="deposit">Deposit received</option>
              <option value="full_payment">Full payment received</option>
              <option value="po">Purchase order received</option>
              <option value="manual">Manual confirmation</option>
            </select>
          </div>
        )}

        {targetStatus === 'lost' && (
          <div className="space-y-3 mb-4">
            <label className="block text-sm font-medium text-gray-700">Why was this lost?</label>
            <select
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              {LOST_REASON_OPTIONS.map((reason) => (
                <option key={reason} value={reason}>{reason}</option>
              ))}
            </select>
            <textarea
              placeholder="Any details..."
              value={lostDetail}
              onChange={(e) => setLostDetail(e.target.value)}
              rows={2}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>
        )}

        {!needsPrompt && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 mb-1">Note (optional)</label>
            <input
              type="text"
              placeholder="Why are you moving this?"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>
        )}

        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700"
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Chase Modal ────────────────────────────────────────────────────────────

function ChaseModal({
  isOpen,
  job,
  onClose,
  onChaseLogged,
}: {
  isOpen: boolean;
  job: Job | null;
  onClose: () => void;
  onChaseLogged: () => void;
}) {
  const [chaseMethod, setChaseMethod] = useState<string>('phone');
  const [content, setContent] = useState('');
  const [chaseResponse, setChaseResponse] = useState('');
  const [nextChaseDate, setNextChaseDate] = useState('');
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [teamUsers, setTeamUsers] = useState<{ id: string; email: string; first_name: string; last_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && job) {
      const days = job.chase_interval_days || 3;
      const next = new Date();
      next.setDate(next.getDate() + days);
      setNextChaseDate(next.toISOString().split('T')[0]);
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

  if (!isOpen || !job) return null;

  const handleSubmit = async () => {
    if (!content.trim()) {
      setError('Please describe what happened');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/interactions', {
        type: 'chase',
        content: content.trim(),
        job_id: job.id,
        chase_method: chaseMethod,
        chase_response: chaseResponse || undefined,
        next_chase_date: nextChaseDate || undefined,
        chase_alert_user_id: chaseAlertUserId || undefined,
      });
      onChaseLogged();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to log chase');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
        <h3 className="text-lg font-semibold mb-1">Log Chase</h3>
        <p className="text-sm text-gray-500 mb-4">
          {job.job_name} — {job.company_name || job.client_name}
          {job.chase_count > 0 && <span className="ml-2 text-gray-400">(chase #{job.chase_count + 1})</span>}
        </p>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-4">
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

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Next chase</label>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {[
                { label: '2 hrs', fn: () => setNextChaseDate(addHoursToNow(2)) },
                { label: '2 days', fn: () => setNextChaseDate(addDaysToDate(2)) },
                { label: '5 days', fn: () => setNextChaseDate(addDaysToDate(5)) },
                { label: '14 days', fn: () => setNextChaseDate(addDaysToDate(14)) },
              ].map(({ label, fn }) => (
                <button
                  key={label}
                  type="button"
                  onClick={fn}
                  className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="date"
                value={nextChaseDate}
                onChange={(e) => setNextChaseDate(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
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
            {saving ? 'Logging...' : 'Log Chase'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── File tag constants ────────────────────────────────────────────────────

const FILE_TAGS = [
  'Stage Plot', 'Rider', 'Tour Dates', 'Quote', 'Invoice',
  'Contract', 'Production Schedule', 'Site Map', 'Risk Assessment', 'Other',
] as const;

// ── Chase date helper ─────────────────────────────────────────────────────

function addDaysToDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function addHoursToNow(hours: number): string {
  const d = new Date();
  d.setHours(d.getHours() + hours);
  return d.toISOString().split('T')[0]; // Chase dates are date-only in DB
}

// ── New Enquiry Modal ──────────────────────────────────────────────────────

interface StagedFile {
  file: File;
  tag: string;
  comment: string;
}

interface TeamUser {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
}

function NewEnquiryModal({
  isOpen,
  onClose,
  onCreated,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [clientName, setClientName] = useState('');
  const [clientId, setClientId] = useState<string | null>(null);
  const [details, setDetails] = useState('');
  const [jobDate, setJobDate] = useState('');
  const [jobEnd, setJobEnd] = useState('');
  const [jobName, setJobName] = useState('');
  const [jobValue, setJobValue] = useState('');
  const [likelihood, setLikelihood] = useState<Likelihood>('warm');
  const [enquirySource, setEnquirySource] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  // File staging
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [fileTag, setFileTag] = useState('');
  const [fileComment, setFileComment] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chase scheduling
  const [nextChaseDate, setNextChaseDate] = useState(() => addDaysToDate(3));
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);

  // Load team users for alert dropdown
  useEffect(() => {
    if (isOpen && teamUsers.length === 0) {
      api.get<{ data: TeamUser[] }>('/users')
        .then(res => setTeamUsers(res.data))
        .catch(() => {});
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleClientSelect = (result: SearchResult) => {
    setClientName(result.name);
    if (result.type === 'organisation') {
      setClientId(result.id);
    } else {
      setClientId(null);
    }
  };

  // Date logic: setting start date auto-sets end date to same day, end date can't be before start
  const handleStartDateChange = (val: string) => {
    setJobDate(val);
    if (!jobEnd || jobEnd < val) {
      setJobEnd(val);
    }
  };

  const handleEndDateChange = (val: string) => {
    if (jobDate && val < jobDate) return; // Don't allow end before start
    setJobEnd(val);
  };

  const handleFileStage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setStagedFiles(prev => [...prev, { file, tag: fileTag, comment: fileComment }]);
    setFileTag('');
    setFileComment('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeStagedFile = (index: number) => {
    setStagedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (!clientName || !details || !jobDate || !jobEnd) {
      setError('Client, description, and dates are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Create the enquiry
      const created = await api.post<{ id: string }>('/pipeline/enquiry', {
        client_name: clientName,
        client_id: clientId || undefined,
        details,
        job_date: jobDate,
        job_end: jobEnd,
        job_name: jobName || undefined,
        job_value: jobValue ? parseFloat(jobValue) : undefined,
        likelihood,
        enquiry_source: enquirySource || undefined,
        notes: notes || undefined,
        next_chase_date: nextChaseDate || undefined,
        chase_alert_user_id: chaseAlertUserId || undefined,
      });

      // Upload staged files
      if (stagedFiles.length > 0 && created.id) {
        for (const staged of stagedFiles) {
          const formData = new FormData();
          formData.append('file', staged.file);
          formData.append('entity_type', 'jobs');
          formData.append('entity_id', created.id);
          if (staged.tag) formData.append('label', staged.tag);
          if (staged.comment) formData.append('comment', staged.comment);
          try {
            await api.upload('/files/upload', formData);
          } catch (uploadErr) {
            console.error('File upload failed:', uploadErr);
          }
        }
      }

      // Reset form
      setClientName(''); setClientId(null); setDetails(''); setJobDate(''); setJobEnd('');
      setJobName(''); setJobValue(''); setLikelihood('warm');
      setEnquirySource(''); setNotes(''); setShowOptional(false);
      setStagedFiles([]); setFileTag(''); setFileComment('');
      setNextChaseDate(addDaysToDate(3)); setChaseAlertUserId('');
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create enquiry');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl p-6 w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold mb-4">New Enquiry</h3>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>
        )}

        <div className="space-y-4">
          {/* Client picker */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client *</label>
            <ClientPicker
              value={clientName}
              onChange={(name) => { setClientName(name); setClientId(null); }}
              onSelect={handleClientSelect}
            />
            {clientId && (
              <p className="text-xs text-green-600 mt-1">Linked to organisation</p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What do they want? *</label>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="e.g. 3x sprinter vans + backline for festival"
              rows={2}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Start date *</label>
              <input
                type="date"
                value={jobDate}
                onChange={(e) => handleStartDateChange(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End date *</label>
              <input
                type="date"
                value={jobEnd}
                min={jobDate || undefined}
                onChange={(e) => handleEndDateChange(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
          </div>

          {/* Chase scheduling */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">First chase</label>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {[
                { label: '2 hrs', fn: () => setNextChaseDate(addHoursToNow(2)) },
                { label: '2 days', fn: () => setNextChaseDate(addDaysToDate(2)) },
                { label: '5 days', fn: () => setNextChaseDate(addDaysToDate(5)) },
                { label: '14 days', fn: () => setNextChaseDate(addDaysToDate(14)) },
              ].map(({ label, fn }) => (
                <button
                  key={label}
                  type="button"
                  onClick={fn}
                  className="px-2.5 py-1 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 text-gray-600"
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="date"
                value={nextChaseDate}
                onChange={(e) => setNextChaseDate(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
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

          {/* Files */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Files</label>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={fileTag}
                  onChange={(e) => setFileTag(e.target.value)}
                  className="border border-gray-300 rounded px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                >
                  <option value="">No tag</option>
                  {FILE_TAGS.map(tag => (
                    <option key={tag} value={tag}>{tag}</option>
                  ))}
                </select>
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileStage}
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.rtf,.jpg,.jpeg,.png,.gif,.webp,.svg,.zip,.rar"
                  className="hidden"
                  id="enquiry-file"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="px-3 py-1.5 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  + Add file
                </button>
              </div>
              <input
                type="text"
                value={fileComment}
                onChange={(e) => setFileComment(e.target.value)}
                placeholder="File comment (optional)"
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            {stagedFiles.length > 0 && (
              <div className="mt-2 space-y-1">
                {stagedFiles.map((sf, i) => (
                  <div key={i} className="flex items-center gap-2 text-sm text-gray-600 bg-gray-50 rounded px-2 py-1">
                    <div className="truncate flex-1">
                      <span>{sf.file.name}</span>
                      {sf.comment && (
                        <span className="text-xs text-gray-400 ml-1">— {sf.comment}</span>
                      )}
                    </div>
                    {sf.tag && (
                      <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">{sf.tag}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeStagedFile(i)}
                      className="text-red-400 hover:text-red-600 text-xs font-medium"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-400 mt-1">Stage plot, rider, tour dates, etc. Max 10MB each.</p>
          </div>

          {/* Optional toggle */}
          <button
            type="button"
            onClick={() => setShowOptional(!showOptional)}
            className="text-sm text-ooosh-600 hover:text-ooosh-700"
          >
            {showOptional ? '- Hide optional fields' : '+ More fields'}
          </button>

          {showOptional && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Job name</label>
                <input
                  type="text"
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                  placeholder="Auto-generated if blank"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Estimated value</label>
                  <input
                    type="number"
                    value={jobValue}
                    onChange={(e) => setJobValue(e.target.value)}
                    placeholder="£"
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Likelihood</label>
                  <select
                    value={likelihood}
                    onChange={(e) => setLikelihood(e.target.value as Likelihood)}
                    className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                  >
                    <option value="hot">Hot</option>
                    <option value="warm">Warm</option>
                    <option value="cold">Cold</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Enquiry source</label>
                <select
                  value={enquirySource}
                  onChange={(e) => setEnquirySource(e.target.value)}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                >
                  <option value="">—</option>
                  <option value="phone">Phone</option>
                  <option value="email">Email</option>
                  <option value="web_form">Website</option>
                  <option value="referral">Referral</option>
                  <option value="repeat">Returning client</option>
                  <option value="forum">Forum / social</option>
                  <option value="cold_lead">Cold lead</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex gap-3 justify-end mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
          >
            {saving ? (stagedFiles.length > 0 ? 'Creating & uploading...' : 'Creating...') : 'Create Enquiry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Pipeline Page ─────────────────────────────────────────────────────

export default function PipelinePage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');

  // Sort
  const [sortMode, setSortMode] = useState<SortMode>('chase_date');

  // Filters
  const [filterLikelihood, setFilterLikelihood] = useState<string>('');
  const [filterChase, setFilterChase] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [showConfirmed, setShowConfirmed] = useState(false);
  const [showLost, setShowLost] = useState(false);

  // Modals
  const [showNewEnquiry, setShowNewEnquiry] = useState(false);
  const [transitionModal, setTransitionModal] = useState<{
    jobId: string;
    targetStatus: PipelineStatus;
  } | null>(null);
  const [chaseModal, setChaseModal] = useState<Job | null>(null);

  // Drag state
  const dragJobRef = useRef<Job | null>(null);

  // Check if we came from a query param (e.g. ?newEnquiry=1)
  useEffect(() => {
    if (searchParams.get('newEnquiry')) {
      setShowNewEnquiry(true);
    }
  }, [searchParams]);

  // ── Fetch data ─────────────────────────────────────────────────────────

  const fetchPipeline = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '500' });
      if (filterLikelihood) params.set('likelihood', filterLikelihood);
      if (filterChase) params.set('chase_status', filterChase);
      if (filterSearch) params.set('search', filterSearch);

      // Build status filter based on toggles
      const statuses = ['new_enquiry', 'quoting', 'chasing', 'paused', 'provisional'];
      if (showConfirmed) statuses.push('confirmed');
      if (showLost) statuses.push('lost');
      params.set('status', statuses.join(','));

      const [jobsRes, statsRes] = await Promise.all([
        api.get<PipelineResponse>(`/pipeline?${params}`),
        api.get<PipelineStats>('/pipeline/stats'),
      ]);

      setJobs(jobsRes.data);
      setStats(statsRes);
    } catch (err) {
      console.error('Failed to fetch pipeline:', err);
    } finally {
      setLoading(false);
    }
  }, [filterLikelihood, filterChase, filterSearch, showConfirmed, showLost]);

  useEffect(() => {
    fetchPipeline();
  }, [fetchPipeline]);

  // ── Drag and drop ──────────────────────────────────────────────────────

  const handleDragStart = (e: React.DragEvent, job: Job) => {
    dragJobRef.current = job;
    e.dataTransfer.effectAllowed = 'move';
    const target = e.target as HTMLElement;
    target.style.opacity = '0.5';
    setTimeout(() => { target.style.opacity = '1'; }, 0);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: React.DragEvent, targetStatus: PipelineStatus) => {
    e.preventDefault();
    const job = dragJobRef.current;
    if (!job || job.pipeline_status === targetStatus) return;

    if (['paused', 'confirmed', 'lost'].includes(targetStatus)) {
      setTransitionModal({ jobId: job.id, targetStatus });
      return;
    }

    try {
      await api.patch(`/pipeline/${job.id}/status`, { pipeline_status: targetStatus });
      fetchPipeline();
    } catch (err) {
      console.error('Status update failed:', err);
    }
  };

  const handleTransitionConfirm = async (data: Record<string, string>) => {
    if (!transitionModal) return;
    try {
      await api.patch(`/pipeline/${transitionModal.jobId}/status`, {
        pipeline_status: transitionModal.targetStatus,
        ...data,
      });
      setTransitionModal(null);
      fetchPipeline();
    } catch (err) {
      console.error('Status transition failed:', err);
    }
  };

  const handleCardClick = (job: Job) => {
    // Navigate with state so job detail can return here
    navigate(`/jobs/${job.id}`, { state: { from: '/pipeline' } });
  };

  // ── Group jobs by status ───────────────────────────────────────────────

  const jobsByStatus: Record<PipelineStatus, Job[]> = {
    new_enquiry: [], quoting: [], chasing: [], paused: [],
    provisional: [], confirmed: [], lost: [],
  };
  for (const job of jobs) {
    // Merge quoting into new_enquiry (now "Enquiries")
    const status = job.pipeline_status === 'quoting' ? 'new_enquiry' : (job.pipeline_status || 'new_enquiry');
    if (jobsByStatus[status]) {
      jobsByStatus[status].push(job);
    }
  }

  // Sort each column
  for (const status of COLUMN_ORDER) {
    jobsByStatus[status] = sortJobs(jobsByStatus[status], sortMode);
  }

  // ── Visible columns ───────────────────────────────────────────────────

  const visibleColumns = COLUMN_ORDER.filter(status => {
    if (status === 'confirmed' && !showConfirmed) return false;
    if (status === 'lost' && !showLost) return false;
    return true;
  });

  // ── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin h-8 w-8 border-4 border-ooosh-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Pipeline</h1>
            {stats && (
              <p className="text-sm text-gray-500 mt-0.5">
                Active pipeline: <span className="font-semibold text-gray-900">{formatCurrency(stats.active_pipeline_value)}</span>
                {stats.chase.overdue !== '0' && (
                  <span className="ml-3 text-red-600 font-medium">{stats.chase.overdue} overdue chases</span>
                )}
                {stats.chase.due_today !== '0' && (
                  <span className="ml-3 text-amber-600 font-medium">{stats.chase.due_today} due today</span>
                )}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* View toggle */}
            <div className="flex border border-gray-300 rounded-lg overflow-hidden">
              <button
                onClick={() => setView('kanban')}
                className={`px-3 py-1.5 text-sm ${view === 'kanban' ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                Board
              </button>
              <button
                onClick={() => setView('list')}
                className={`px-3 py-1.5 text-sm ${view === 'list' ? 'bg-ooosh-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >
                List
              </button>
            </div>
            <button
              onClick={() => setShowNewEnquiry(true)}
              className="px-4 py-2 bg-ooosh-600 text-white text-sm font-medium rounded-lg hover:bg-ooosh-700"
            >
              + New Enquiry
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="text"
            placeholder="Search jobs..."
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm w-48 focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as SortMode)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          >
            <option value="chase_date">Sort: Chase date</option>
            <option value="job_date_nearest">Sort: Nearest job date</option>
            <option value="job_date_furthest">Sort: Furthest job date</option>
            <option value="value_high">Sort: Highest value</option>
            <option value="value_low">Sort: Lowest value</option>
            <option value="newest">Sort: Newest first</option>
          </select>
          <select
            value={filterLikelihood}
            onChange={(e) => setFilterLikelihood(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          >
            <option value="">All likelihood</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
          </select>
          <select
            value={filterChase}
            onChange={(e) => setFilterChase(e.target.value)}
            className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          >
            <option value="">All chases</option>
            <option value="overdue">Overdue</option>
            <option value="due_today">Due today</option>
            <option value="due_this_week">Due this week</option>
          </select>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showConfirmed}
              onChange={(e) => setShowConfirmed(e.target.checked)}
              className="rounded border-gray-300"
            />
            Confirmed
          </label>
          <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={showLost}
              onChange={(e) => setShowLost(e.target.checked)}
              className="rounded border-gray-300"
            />
            Lost
          </label>
        </div>
      </div>

      {/* Board */}
      {view === 'kanban' ? (
        <div className="flex-1 overflow-x-auto p-4">
          <div className="flex gap-4 h-full" style={{ minWidth: `${visibleColumns.length * 280}px` }}>
            {visibleColumns.map((status) => {
              const config = PIPELINE_STATUS_CONFIG[status];
              const columnJobs = jobsByStatus[status];
              const columnValue = columnJobs.reduce((sum, j) => sum + (j.job_value || 0), 0);

              return (
                <div
                  key={status}
                  className="flex-1 min-w-[260px] max-w-[340px] flex flex-col bg-gray-50 rounded-xl"
                  onDragOver={handleDragOver}
                  onDrop={(e) => handleDrop(e, status)}
                >
                  {/* Column header */}
                  <div className="flex-shrink-0 px-3 py-2.5 border-b-2" style={{ borderBottomColor: config.colour }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ backgroundColor: config.colour }}
                        />
                        <span className="text-sm font-semibold text-gray-900">{config.label}</span>
                        <span className="text-xs text-gray-400 bg-gray-200 px-1.5 py-0.5 rounded-full">
                          {columnJobs.length}
                        </span>
                      </div>
                      {columnValue > 0 && (
                        <span className="text-xs font-medium text-gray-500">
                          {formatCurrency(columnValue)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Cards */}
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {columnJobs.length === 0 ? (
                      <div className="text-center text-xs text-gray-400 py-8">
                        No jobs
                      </div>
                    ) : (
                      columnJobs.map((job) => (
                        <PipelineCard
                          key={job.id}
                          job={job}
                          onDragStart={handleDragStart}
                          onClick={handleCardClick}
                          onChase={(j) => setChaseModal(j)}
                        />
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        /* List view */
        <div className="flex-1 overflow-y-auto p-4">
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Job</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Client</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Status</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Dates</th>
                  <th className="text-right text-xs font-medium text-gray-500 uppercase px-4 py-3">Value</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Likelihood</th>
                  <th className="text-left text-xs font-medium text-gray-500 uppercase px-4 py-3">Chase</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {sortJobs(jobs, sortMode).map((job) => {
                  const statusConfig = PIPELINE_STATUS_CONFIG[job.pipeline_status || 'new_enquiry'];
                  const chase = chaseDueLabel(job.next_chase_date);
                  return (
                    <tr
                      key={job.id}
                      onClick={() => handleCardClick(job)}
                      className="hover:bg-gray-50 cursor-pointer"
                    >
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-gray-900">{job.job_name || 'Untitled'}</div>
                        <div className="text-xs font-mono">
                          {job.hh_job_number ? (
                            <a
                              href={`https://myhirehop.com/job.php?id=${job.hh_job_number}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-ooosh-600 hover:text-ooosh-700 hover:underline"
                            >
                              J-{job.hh_job_number}
                            </a>
                          ) : (
                            <span className="text-gray-400">NEW</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {job.company_name || job.client_name || '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium text-white"
                          style={{ backgroundColor: statusConfig?.colour }}
                        >
                          {statusConfig?.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">
                        {formatDateRange(job.job_date, job.job_end)}
                      </td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
                        {formatCurrency(job.job_value)}
                      </td>
                      <td className="px-4 py-3">
                        {job.likelihood && (
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${likelihoodColour(job.likelihood)}`}>
                            {job.likelihood.charAt(0).toUpperCase() + job.likelihood.slice(1)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-xs">
                          {chase.text && (
                            <span className={`font-medium ${
                              chase.urgency === 'overdue' ? 'text-red-600' :
                              chase.urgency === 'today' ? 'text-amber-600' : 'text-gray-500'
                            }`}>
                              {chase.text}
                            </span>
                          )}
                          {job.chase_count > 0 && (
                            <span className="text-gray-400">x{job.chase_count}</span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); setChaseModal(job); }}
                            className="text-ooosh-600 hover:text-ooosh-700 font-medium hover:underline"
                          >
                            Chase
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-sm text-gray-400">
                      No jobs match your filters
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Modals */}
      <NewEnquiryModal
        isOpen={showNewEnquiry}
        onClose={() => setShowNewEnquiry(false)}
        onCreated={fetchPipeline}
      />
      <TransitionModal
        isOpen={!!transitionModal}
        targetStatus={transitionModal?.targetStatus || null}
        onConfirm={handleTransitionConfirm}
        onCancel={() => setTransitionModal(null)}
      />
      <ChaseModal
        isOpen={!!chaseModal}
        job={chaseModal}
        onClose={() => setChaseModal(null)}
        onChaseLogged={fetchPipeline}
      />
    </div>
  );
}
