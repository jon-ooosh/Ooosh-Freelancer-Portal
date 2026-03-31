import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import DatePicker from '../components/DatePicker';
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
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
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
  onCreateNew,
}: {
  value: string;
  onChange: (name: string) => void;
  onSelect: (result: SearchResult) => void;
  onCreateNew?: (name: string) => void;
}) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
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
    if (term.length < 2) { setResults([]); setShowDropdown(false); setHasSearched(false); return; }
    setSearching(true);
    try {
      const data = await api.get<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(term)}&limit=10`);
      // Only show people and organisations (not venues)
      const filtered = data.results.filter(r => r.type === 'person' || r.type === 'organisation');
      setResults(filtered);
      setHasSearched(true);
      // Show dropdown if there are results OR if we can offer "create new"
      const hasExactOrgMatch = filtered.some(r => r.type === 'organisation' && r.name.toLowerCase() === term.toLowerCase());
      setShowDropdown(filtered.length > 0 || (!hasExactOrgMatch && onCreateNew != null));
    } catch {
      setResults([]);
      setHasSearched(true);
      if (term.length >= 2 && onCreateNew) setShowDropdown(true);
    } finally {
      setSearching(false);
    }
  }, [onCreateNew]);

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

  // Determine whether to show "Create new" option
  const trimmedValue = value.trim();
  const hasExactOrgMatch = results.some(r => r.type === 'organisation' && r.name.toLowerCase() === trimmedValue.toLowerCase());
  const showCreateNew = onCreateNew && hasSearched && trimmedValue.length >= 2 && !hasExactOrgMatch && !searching;

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={() => { if (results.length > 0 || showCreateNew) setShowDropdown(true); }}
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
          {showCreateNew && showDropdown && (
            <>
              {results.length > 0 && <div className="border-t border-gray-100" />}
              <button
                onClick={() => {
                  onCreateNew!(trimmedValue);
                  setShowDropdown(false);
                }}
                className="w-full text-left px-3 py-2 hover:bg-green-50 flex items-center gap-2"
              >
                <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-green-100 text-green-700">
                  + New
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-gray-900 truncate">
                    Create &ldquo;{trimmedValue}&rdquo; as new client
                  </div>
                </div>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Pipeline Card ──────────────────────────────────────────────────────────

interface ReqProgress {
  total: number;
  done: number;
  blocked: number;
}

function PipelineCard({
  job,
  onDragStart,
  onClick,
  onChase,
  progress,
}: {
  job: Job;
  onDragStart: (e: React.DragEvent, job: Job) => void;
  onClick: (job: Job) => void;
  onChase: (job: Job) => void;
  progress?: ReqProgress;
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
      <div className="text-xs text-gray-500 truncate mb-0.5">
        {job.company_name || job.client_name || '—'}
      </div>

      {/* Row 3b: Band (if linked) */}
      {(job as any).band_name && (
        <div className="text-xs text-purple-600 truncate mb-1">
          <span className="text-purple-400">Band:</span> {(job as any).band_name}
        </div>
      )}

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

      {/* Requirements progress */}
      {progress && progress.total > 0 && (() => {
        const pct = Math.round((progress.done / progress.total) * 100);
        return (
          <div className="flex items-center gap-1.5 mb-1">
            <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${progress.blocked > 0 ? 'bg-red-500' : pct === 100 ? 'bg-green-500' : 'bg-amber-400'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className={`text-xs ${progress.blocked > 0 ? 'text-red-600' : progress.done === progress.total ? 'text-green-600' : 'text-gray-400'}`}>
              {progress.blocked > 0 ? `${progress.blocked} blocked` : `${progress.done}/${progress.total}`}
            </span>
          </div>
        );
      })()}

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
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>(null);
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [teamUsers, setTeamUsers] = useState<{ id: string; email: string; first_name: string; last_name: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && job) {
      const days = job.chase_interval_days || 5;
      const next = new Date();
      next.setDate(next.getDate() + days);
      setNextChaseDate(next.toISOString().split('T')[0]);
      setContent('');
      setChaseResponse('');
      setChaseMethod('phone');
      setSelectedChasePreset(null);
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

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

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
                { label: '2 hrs', fn: () => addHoursToNow(2) },
                { label: '2 days', fn: () => addDaysToDate(2) },
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
  onCreated: (jobId?: string) => void;
}) {
  const [clientName, setClientName] = useState('');
  const [clientId, setClientId] = useState<string | null>(null);
  const [isNewClient, setIsNewClient] = useState(false);
  const [newClientEmail, setNewClientEmail] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');
  const [details, setDetails] = useState('');
  const [serviceTypes, setServiceTypes] = useState<string[]>([]);
  const [outDate, setOutDate] = useState('');
  const [jobDate, setJobDate] = useState('');
  const [jobEnd, setJobEnd] = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [outLinked, setOutLinked] = useState(true);   // Outgoing locked to Job Start
  const [returnLinked, setReturnLinked] = useState(true); // Returning locked to Job Finish
  const [jobName, setJobName] = useState('');
  const [jobValue, setJobValue] = useState('');
  const [likelihood, setLikelihood] = useState<Likelihood>('warm');
  const [enquirySource, setEnquirySource] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  // Band picker
  const [bandName, setBandName] = useState('');
  const [bandId, setBandId] = useState<string | null>(null);
  const [bandSearch, setBandSearch] = useState('');
  const [bandResults, setBandResults] = useState<Array<{ id: string; name: string; type: string }>>([]);

  // File staging
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([]);
  const [fileTag, setFileTag] = useState('');
  const [fileComment, setFileComment] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chase scheduling
  const [nextChaseDate, setNextChaseDate] = useState(() => addDaysToDate(5));
  const [selectedChasePreset, setSelectedChasePreset] = useState<string | null>('5 days');
  const [chaseAlertUserId, setChaseAlertUserId] = useState('');
  const [teamUsers, setTeamUsers] = useState<TeamUser[]>([]);

  // Client trading history
  const [clientHistory, setClientHistory] = useState<{
    jobs: Array<{
      id: string; hh_job_number: number | null; job_name: string | null;
      status: number; pipeline_status: string | null; job_date: string | null;
      job_end: string | null; job_value: number | null; likelihood: string | null;
    }>;
    stats: {
      total_jobs: string; confirmed_jobs: string; lost_jobs: string;
      total_confirmed_value: string; total_value: string;
      first_job_date: string | null; last_job_date: string | null;
    };
    client_info?: {
      id: string; name: string;
      do_not_hire: boolean; do_not_hire_reason: string | null;
      working_terms_type: string | null; working_terms_credit_days: number | null;
      working_terms_notes: string | null; internal_notes: string | null;
    } | null;
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchClientHistory = useCallback(async (orgId: string | null, name: string) => {
    if (!name || name.length < 2) { setClientHistory(null); return; }
    setHistoryLoading(true);
    try {
      const params = orgId
        ? `client_id=${encodeURIComponent(orgId)}`
        : `client_name=${encodeURIComponent(name)}`;
      const data = await api.get<typeof clientHistory>(`/pipeline/client-history?${params}`);
      setClientHistory(data);
    } catch {
      setClientHistory(null);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // Load team users for alert dropdown
  useEffect(() => {
    if (isOpen && teamUsers.length === 0) {
      api.get<{ data: TeamUser[] }>('/users')
        .then(res => setTeamUsers(res.data))
        .catch(() => {});
    }
  }, [isOpen]);

  // Band search
  useEffect(() => {
    if (bandSearch.length < 2) { setBandResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string }> }>(
          `/organisations?search=${encodeURIComponent(bandSearch)}&limit=8`
        );
        setBandResults(data.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [bandSearch]);

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleClientSelect = (result: SearchResult) => {
    setClientName(result.name);
    // Reset new client state when selecting an existing result
    setIsNewClient(false);
    setNewClientEmail('');
    setNewClientPhone('');
    if (result.type === 'organisation') {
      setClientId(result.id);
      fetchClientHistory(result.id, result.name);
    } else {
      setClientId(null);
      fetchClientHistory(null, result.name);
    }
  };

  const handleCreateNewClient = (name: string) => {
    setClientName(name);
    setClientId(null);
    setIsNewClient(true);
    setNewClientEmail('');
    setNewClientPhone('');
    // Fetch history by name in case there are jobs under this name already
    fetchClientHistory(null, name);
  };

  // Today's date for min constraint (no past dates)
  const today = new Date().toISOString().split('T')[0];

  // Helper: add N days to a date string
  const addDays = (dateStr: string, days: number): string => {
    const d = new Date(dateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
  };

  // HireHop-style date linking: Outgoing=Job Start, Returning=Job Finish by default
  // Constraint: Outgoing ≤ Job Start ≤ Job Finish ≤ Returning
  const handleOutDateChange = (val: string) => {
    // Allow clearing, but block setting after job start
    if (val && jobDate && val > jobDate) return;
    setOutDate(val);
    if (outLinked && val) {
      setJobDate(val);
      // Auto-set job end if empty, or push forward if before new start
      if (!jobEnd || jobEnd <= val) {
        const nextDay = addDays(val, 1);
        setJobEnd(nextDay);
        if (returnLinked) setReturnDate(nextDay);
      }
    }
  };

  const handleJobDateChange = (val: string) => {
    setJobDate(val);
    if (outLinked) {
      setOutDate(val);
    } else {
      // If unlinked outgoing is after new job start, pull it back
      if (outDate && outDate > val) setOutDate(val);
    }
    if (val) {
      // Auto-set job end to day after start if empty, or push forward if before start
      if (!jobEnd || jobEnd < val) {
        const nextDay = addDays(val, 1);
        setJobEnd(nextDay);
        if (returnLinked) setReturnDate(nextDay);
      }
    }
  };

  const handleJobEndChange = (val: string) => {
    // Allow clearing (empty string), but block setting before start date
    if (val && jobDate && val < jobDate) return;
    setJobEnd(val);
    if (returnLinked) {
      setReturnDate(val);
    } else {
      // If unlinked returning is before new job end, push it forward
      if (returnDate && returnDate < val) setReturnDate(val);
    }
  };

  const handleReturnDateChange = (val: string) => {
    // Allow clearing, but block setting before job end
    if (val && jobEnd && val < jobEnd) return;
    setReturnDate(val);
    if (returnLinked) {
      setJobEnd(val);
    }
  };

  const toggleOutLink = () => {
    if (!outLinked) {
      // Re-linking: sync outgoing to job start
      setOutDate(jobDate);
    }
    setOutLinked(!outLinked);
  };

  const toggleReturnLink = () => {
    if (!returnLinked) {
      // Re-linking: sync returning to job finish
      setReturnDate(jobEnd);
    }
    setReturnLinked(!returnLinked);
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

  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const handleSave = async (alsoCreateInHH = false) => {
    if (!clientName || !details) {
      setError('Client and description are required');
      return;
    }
    if (isNewClient && newClientEmail.trim() && !EMAIL_REGEX.test(newClientEmail.trim())) {
      setError('Please enter a valid email address for the new client');
      return;
    }
    setSaving(true);
    setError('');
    try {
      // Create new client organisation if needed
      let resolvedClientId = clientId;
      if (isNewClient && clientName.trim()) {
        try {
          const newOrg = await api.post<{ id: string }>('/organisations', {
            name: clientName.trim(),
            type: 'client',
            email: newClientEmail.trim() || undefined,
            phone: newClientPhone.trim() || undefined,
          });
          resolvedClientId = newOrg.id;
        } catch (orgErr) {
          setError(orgErr instanceof Error ? orgErr.message : 'Failed to create client organisation');
          setSaving(false);
          return;
        }
      }

      // Create the enquiry
      const created = await api.post<{ id: string }>('/pipeline/enquiry', {
        client_name: clientName,
        client_id: resolvedClientId || undefined,
        details,
        service_types: serviceTypes.length > 0 ? serviceTypes : undefined,
        out_date: outDate || undefined,
        job_date: jobDate || undefined,
        job_end: jobEnd || undefined,
        return_date: returnDate || undefined,
        job_name: jobName || undefined,
        job_value: jobValue ? parseFloat(jobValue) : undefined,
        likelihood,
        enquiry_source: enquirySource || undefined,
        notes: notes || undefined,
        next_chase_date: nextChaseDate || undefined,
        chase_alert_user_id: chaseAlertUserId || undefined,
        band_name: bandName || undefined,
      });

      // Link band if selected
      if (bandId && created.id) {
        try {
          await api.post(`/pipeline/${created.id}/organisations`, {
            organisation_id: bandId,
            role: 'band',
          });
        } catch (err) {
          console.error('Failed to link band:', err);
        }
      }

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

      // Push to HireHop if requested
      if (alsoCreateInHH && created.id) {
        if (!jobDate || !jobEnd) {
          alert('Enquiry created, but start and end dates are required to push to HireHop. You can push from the Job Detail page after adding dates.');
        } else {
          try {
            await api.post(`/pipeline/${created.id}/push-hirehop`, {});
          } catch (hhErr) {
            console.error('HireHop push failed:', hhErr);
            // Don't block — enquiry was created, HH push can be retried from Job Detail
          }
        }
      }

      // Reset form
      setClientName(''); setClientId(null); setIsNewClient(false); setNewClientEmail(''); setNewClientPhone(''); setDetails('');
      setOutDate(''); setJobDate(''); setJobEnd(''); setReturnDate('');
      setOutLinked(true); setReturnLinked(true);
      setJobName(''); setJobValue(''); setLikelihood('warm');
      setClientHistory(null);
      setBandName(''); setBandId(null); setBandSearch(''); setBandResults([]);
      setEnquirySource(''); setNotes(''); setShowOptional(false);
      setStagedFiles([]); setFileTag(''); setFileComment('');
      setNextChaseDate(addDaysToDate(5)); setSelectedChasePreset('5 days'); setChaseAlertUserId('');
      onCreated(created.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create enquiry');
    } finally {
      setSaving(false);
    }
  };

  const hasHistory = clientHistory && (parseInt(clientHistory.stats.total_jobs) > 0 || clientHistory.client_info);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className={`relative bg-white rounded-xl shadow-xl w-full mx-4 max-h-[90vh] flex transition-all duration-300 ${hasHistory ? 'max-w-4xl' : 'max-w-lg'}`}>
        {/* Left side: form */}
        <div className="flex-1 min-w-0 p-6 overflow-y-auto">
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
              onChange={(name) => { setClientName(name); setClientId(null); setIsNewClient(false); }}
              onSelect={handleClientSelect}
              onCreateNew={handleCreateNewClient}
            />
            {clientId && (
              <p className="text-xs text-green-600 mt-1">Linked to organisation</p>
            )}
            {isNewClient && (
              <div className="mt-2 p-3 bg-green-50 border border-green-200 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-green-800">
                    New client: <span className="font-semibold">{clientName}</span>
                  </p>
                  <button
                    type="button"
                    onClick={() => { setIsNewClient(false); setNewClientEmail(''); setNewClientPhone(''); }}
                    className="text-xs text-green-500 hover:text-green-700"
                  >
                    &times; Cancel
                  </button>
                </div>
                <div className="space-y-2">
                  <input
                    type="email"
                    value={newClientEmail}
                    onChange={(e) => setNewClientEmail(e.target.value)}
                    placeholder="Email (optional)"
                    className={`w-full border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-1 bg-white ${newClientEmail.trim() && !EMAIL_REGEX.test(newClientEmail.trim()) ? 'border-red-400 focus:border-red-500 focus:ring-red-500' : 'border-green-200 focus:border-green-400 focus:ring-green-400'}`}
                  />
                  {newClientEmail.trim() && !EMAIL_REGEX.test(newClientEmail.trim()) && (
                    <p className="text-xs text-red-500 mt-0.5">Please enter a valid email address</p>
                  )}
                  <input
                    type="tel"
                    value={newClientPhone}
                    onChange={(e) => setNewClientPhone(e.target.value)}
                    placeholder="Phone (optional)"
                    className="w-full border border-green-200 rounded px-3 py-1.5 text-sm focus:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400 bg-white"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Band picker (optional) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Band / Act <span className="text-gray-400 font-normal">(optional)</span>
            </label>
            {bandId ? (
              <div className="flex items-center gap-2 bg-purple-50 border border-purple-200 rounded px-3 py-2">
                <span className="text-sm font-medium text-purple-700">{bandName}</span>
                <button
                  onClick={() => { setBandId(null); setBandName(''); setBandSearch(''); }}
                  className="ml-auto text-xs text-purple-400 hover:text-purple-600"
                >
                  &times; Remove
                </button>
              </div>
            ) : (
              <div className="relative">
                <input
                  type="text"
                  value={bandSearch}
                  onChange={(e) => setBandSearch(e.target.value)}
                  placeholder="Search for band or organisation..."
                  className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
                {bandResults.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                    {bandResults.map((o) => (
                      <button
                        key={o.id}
                        onClick={async () => {
                          setBandId(o.id); setBandName(o.name); setBandResults([]); setBandSearch('');
                          // Auto-suggest client from org graph if client is empty
                          if (!clientName && !clientId) {
                            try {
                              const suggestions = await api.get<{ data: Array<{ org_id: string; org_name: string; suggested_role: string; relationship_type: string }> }>(`/organisations/${o.id}/suggestions`);
                              const clientSuggestion = suggestions.data.find(s => s.suggested_role === 'client' || s.suggested_role === 'management');
                              if (clientSuggestion) {
                                setClientName(clientSuggestion.org_name);
                                setClientId(clientSuggestion.org_id);
                              }
                            } catch { /* suggestions are nice-to-have */ }
                          }
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm flex items-center gap-2 border-b border-gray-50 last:border-b-0"
                      >
                        <span className="font-medium">{o.name}</span>
                        <span className="text-xs text-gray-400">{o.type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What do they want / what is it? *</label>
            <div className="flex gap-2 mb-2">
              {([
                { key: 'self_drive_van', label: 'Self-drive van', icon: '🚐' },
                { key: 'backline', label: 'Backline', icon: '🎸' },
                { key: 'rehearsal', label: 'Rehearsal', icon: '🎵' },
              ] as const).map(({ key, label, icon }) => {
                const selected = serviceTypes.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setServiceTypes(prev =>
                      prev.includes(key) ? prev.filter(t => t !== key) : [...prev, key]
                    )}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                      selected
                        ? 'bg-ooosh-100 border-ooosh-400 text-ooosh-700'
                        : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                    }`}
                  >
                    {icon} {label}
                  </button>
                );
              })}
            </div>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="e.g. 3x sprinter vans + backline for festival"
              rows={2}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
          </div>

          {/* Dates — HireHop-style 4-date system with linking */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700">Dates</label>
            <div className="border border-gray-200 rounded-lg overflow-hidden">
              {/* Row 1: Outgoing */}
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-200">
                <span className="text-xs text-gray-500 w-20 shrink-0">Outgoing</span>
                <DatePicker
                  value={outDate}
                  min={today}
                  max={jobDate || undefined}
                  onChange={(val) => handleOutDateChange(val)}
                  disabled={outLinked}
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={toggleOutLink}
                  className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${outLinked ? 'text-ooosh-600 bg-ooosh-50' : 'text-gray-400 hover:text-gray-600'}`}
                  title={outLinked ? 'Linked to Job Start — click to unlink' : 'Click to link to Job Start'}
                >
                  {outLinked ? '🔗' : '🔓'}
                </button>
              </div>
              {/* Row 2: Job Start */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
                <span className="text-xs text-gray-500 w-20 shrink-0">Job start</span>
                <DatePicker
                  value={jobDate}
                  min={today}
                  max={jobEnd || undefined}
                  onChange={(val) => handleJobDateChange(val)}
                  className="flex-1"
                />
                <div className="w-[52px]" />
              </div>
              {/* Row 3: Job Finish */}
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-200">
                <span className="text-xs text-gray-500 w-20 shrink-0">Job finish</span>
                <DatePicker
                  value={jobEnd}
                  min={jobDate || today}
                  onChange={(val) => handleJobEndChange(val)}
                  className="flex-1"
                />
                <div className="w-[52px]" />
              </div>
              {/* Row 4: Returning */}
              <div className="flex items-center gap-2 px-3 py-2 bg-gray-50">
                <span className="text-xs text-gray-500 w-20 shrink-0">Returning</span>
                <DatePicker
                  value={returnDate}
                  min={jobEnd || today}
                  onChange={(val) => handleReturnDateChange(val)}
                  disabled={returnLinked}
                  className="flex-1"
                />
                <button
                  type="button"
                  onClick={toggleReturnLink}
                  className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${returnLinked ? 'text-ooosh-600 bg-ooosh-50' : 'text-gray-400 hover:text-gray-600'}`}
                  title={returnLinked ? 'Linked to Job Finish — click to unlink' : 'Click to link to Job Finish'}
                >
                  {returnLinked ? '🔗' : '🔓'}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-400">
              {jobDate && jobEnd ? (() => {
                const start = new Date(jobDate);
                const end = new Date(jobEnd);
                const days = Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
                return days > 0 ? <span className="text-gray-600 font-medium">{days} day{days !== 1 ? 's' : ''}</span> : null;
              })() : 'Leave blank if dates not yet known'}
            </p>
          </div>

          {/* Chase scheduling */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">First chase</label>
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              {[
                { label: '2 hrs', fn: () => addHoursToNow(2) },
                { label: '2 days', fn: () => addDaysToDate(2) },
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
            onClick={() => handleSave(false)}
            disabled={saving}
            className="px-4 py-2 text-sm bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50"
          >
            {saving ? (stagedFiles.length > 0 ? 'Creating & uploading...' : 'Creating...') : 'Create Enquiry'}
          </button>
          <button
            onClick={() => handleSave(true)}
            disabled={saving}
            className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
            title="Create enquiry and also create the job in HireHop"
          >
            {saving ? 'Creating...' : 'Create & Push to HireHop'}
          </button>
        </div>
        </div>

        {/* Right side: client trading history */}
        {hasHistory && (
          <div className="hidden lg:block w-80 border-l border-gray-200 bg-gray-50 p-4 overflow-y-auto rounded-r-xl">
            <h4 className="text-sm font-semibold text-gray-700 mb-3">Client History</h4>

            {/* Do Not Hire warning */}
            {clientHistory!.client_info?.do_not_hire && (
              <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                  <span className="text-sm font-bold text-red-700">DO NOT HIRE</span>
                </div>
                {clientHistory!.client_info.do_not_hire_reason && (
                  <p className="text-xs text-red-600 mt-1">{clientHistory!.client_info.do_not_hire_reason}</p>
                )}
              </div>
            )}

            {/* Working Terms */}
            {clientHistory!.client_info?.working_terms_type && (
              <div className="mb-3 p-2.5 bg-white border border-gray-200 rounded-lg">
                <div className="text-xs font-semibold text-gray-500 uppercase mb-1">Working Terms</div>
                <div className="flex items-center gap-2">
                  <span className={`inline-block px-2.5 py-1 rounded text-sm font-semibold text-white ${
                    { usual: 'bg-green-600', flex_balance: 'bg-emerald-500', no_deposit: 'bg-blue-800', credit: 'bg-purple-600', custom: 'bg-orange-500' }[clientHistory!.client_info.working_terms_type] || 'bg-gray-500'
                  }`}>{
                    { usual: 'USUAL', flex_balance: 'FLEX BALANCE', no_deposit: 'NO DEPOSIT', credit: 'CREDIT', custom: 'CUSTOM' }[clientHistory!.client_info.working_terms_type] || clientHistory!.client_info.working_terms_type
                  }</span>
                  {clientHistory!.client_info.working_terms_credit_days && (
                    <span className="text-sm text-gray-500">{clientHistory!.client_info.working_terms_credit_days} day credit</span>
                  )}
                </div>
                {clientHistory!.client_info.working_terms_notes && (
                  <p className="text-xs text-gray-500 mt-1">{clientHistory!.client_info.working_terms_notes}</p>
                )}
              </div>
            )}

            {/* Internal Notes */}
            {clientHistory!.client_info?.internal_notes && (
              <div className="mb-3 p-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="text-xs font-semibold text-amber-700 uppercase mb-1">Internal Notes</div>
                <p className="text-xs text-gray-700 whitespace-pre-wrap">{clientHistory!.client_info.internal_notes}</p>
              </div>
            )}

            {/* Stats summary */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              <div className="bg-white rounded-lg p-2 text-center border border-gray-200">
                <div className="text-lg font-bold text-gray-900">{clientHistory!.stats.total_jobs}</div>
                <div className="text-xs text-gray-500">Total Jobs</div>
              </div>
              <div className="bg-white rounded-lg p-2 text-center border border-gray-200">
                <div className="text-lg font-bold text-green-600">{clientHistory!.stats.confirmed_jobs}</div>
                <div className="text-xs text-gray-500">Confirmed</div>
              </div>
              <div className="bg-white rounded-lg p-2 text-center border border-gray-200">
                <div className="text-lg font-bold text-gray-900">
                  {formatCurrency(parseFloat(clientHistory!.stats.total_confirmed_value))}
                </div>
                <div className="text-xs text-gray-500">Confirmed Value</div>
              </div>
              <div className="bg-white rounded-lg p-2 text-center border border-gray-200">
                <div className="text-lg font-bold text-red-500">{clientHistory!.stats.lost_jobs}</div>
                <div className="text-xs text-gray-500">Lost</div>
              </div>
            </div>

            {/* Recent jobs list */}
            <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Recent Jobs</h5>
            <div className="space-y-2">
              {clientHistory!.jobs.map((j) => {
                const pStatus = j.pipeline_status;
                const pConfig = pStatus
                  ? PIPELINE_STATUS_CONFIG[pStatus as PipelineStatus]
                  : null;
                // Fallback to HireHop status for completed/cancelled/dispatched etc.
                const hhStatusBadge = !pConfig && j.status != null ? (() => {
                  const HH_STATUS_MAP: Record<number, { label: string; colour: string }> = {
                    3: { label: 'Prepped', colour: '#8B5CF6' },
                    4: { label: 'Part Dispatched', colour: '#F97316' },
                    5: { label: 'On Hire', colour: '#0EA5E9' },
                    6: { label: 'Returned (Incomplete)', colour: '#F59E0B' },
                    7: { label: 'Returned', colour: '#6366F1' },
                    8: { label: 'Needs Attention', colour: '#EF4444' },
                    9: { label: 'Cancelled', colour: '#9CA3AF' },
                    10: { label: 'Not Interested', colour: '#6B7280' },
                    11: { label: 'Completed', colour: '#059669' },
                  };
                  return HH_STATUS_MAP[j.status] || null;
                })() : null;
                const statusBadge = pConfig || hhStatusBadge;
                return (
                  <div key={j.id} className="bg-white rounded-lg p-2.5 border border-gray-200 text-xs">
                    <div className="flex items-center justify-between mb-1">
                      {j.hh_job_number ? (
                        <a
                          href={`https://myhirehop.com/job.php?id=${j.hh_job_number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline"
                        >
                          J-{j.hh_job_number}
                        </a>
                      ) : (
                        <span className="text-gray-400">NEW</span>
                      )}
                      {statusBadge && (
                        <span
                          className="px-1.5 py-0.5 rounded-full text-[10px] font-medium"
                          style={{ backgroundColor: statusBadge.colour + '20', color: statusBadge.colour }}
                        >
                          {statusBadge.label}
                        </span>
                      )}
                    </div>
                    <div className="font-medium text-gray-900 truncate">{j.job_name || 'Untitled'}</div>
                    {j.job_date && (
                      <div className="text-gray-400 mt-0.5">
                        {formatDateRange(j.job_date, j.job_end)}
                      </div>
                    )}
                    {j.job_value != null && (
                      <div className="text-gray-600 font-medium mt-0.5">{formatCurrency(j.job_value)}</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {historyLoading && (
          <div className="hidden lg:flex w-80 border-l border-gray-200 bg-gray-50 items-center justify-center rounded-r-xl">
            <div className="animate-spin h-6 w-6 border-2 border-ooosh-500 border-t-transparent rounded-full" />
          </div>
        )}
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
  const [reqProgress, setReqProgress] = useState<Record<string, ReqProgress>>({});
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

  // Load requirements progress when jobs change
  useEffect(() => {
    if (jobs.length === 0) return;
    const jobIds = jobs.map(j => j.id);
    api.post<{ data: Record<string, ReqProgress> }>('/requirements/bulk', { job_ids: jobIds })
      .then(res => setReqProgress(res.data))
      .catch(() => { /* requirements table may not exist yet */ });
  }, [jobs]);

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
              <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                <span className="text-sm text-gray-500">
                  Active pipeline: <span className="font-semibold text-gray-900">{formatCurrency(stats.active_pipeline_value)}</span>
                </span>
                {stats.chase.overdue !== '0' && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">
                    <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                    {stats.chase.overdue} overdue
                  </span>
                )}
                {stats.chase.due_today !== '0' && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">
                    {stats.chase.due_today} due today
                  </span>
                )}
              </div>
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
                          progress={reqProgress[job.id]}
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
        /* List view — grouped by urgency */
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {(() => {
            const sorted = sortJobs(jobs, sortMode);
            const today = new Date(); today.setHours(0, 0, 0, 0);

            // Group jobs into sections
            const actionRequired: Job[] = []; // overdue, due today, new enquiries with no chase date
            const waiting: Job[] = [];        // chasing with future chase date
            const paused: Job[] = [];         // paused status
            const provisional: Job[] = [];    // provisional
            const other: Job[] = [];          // everything else

            sorted.forEach(job => {
              const status = job.pipeline_status || 'new_enquiry';
              if (status === 'paused') {
                paused.push(job);
              } else if (status === 'provisional') {
                provisional.push(job);
              } else {
                const chase = job.next_chase_date ? new Date(job.next_chase_date) : null;
                if (chase) chase.setHours(0, 0, 0, 0);
                const isOverdue = chase && chase.getTime() <= today.getTime();
                const isNew = status === 'new_enquiry' && !chase;

                if (isOverdue || isNew) {
                  actionRequired.push(job);
                } else if (chase && chase.getTime() > today.getTime()) {
                  waiting.push(job);
                } else {
                  other.push(job);
                }
              }
            });

            const renderListRow = (job: Job) => {
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
            };

            const tableHead = (
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
            );

            const sections = [
              { key: 'action', label: 'Action Required', jobs: actionRequired, bgHeader: 'bg-red-50', textColor: 'text-red-700', borderColor: 'border-red-200 border-l-red-500' },
              { key: 'waiting', label: 'Waiting', jobs: waiting, bgHeader: 'bg-amber-50', textColor: 'text-amber-700', borderColor: 'border-amber-200 border-l-amber-500' },
              { key: 'provisional', label: 'Provisional', jobs: provisional, bgHeader: 'bg-blue-50', textColor: 'text-blue-700', borderColor: 'border-blue-200 border-l-blue-500' },
              { key: 'other', label: 'Other', jobs: other, bgHeader: 'bg-gray-50', textColor: 'text-gray-700', borderColor: 'border-gray-200 border-l-gray-400' },
              { key: 'paused', label: 'Paused', jobs: paused, bgHeader: 'bg-gray-100', textColor: 'text-gray-500', borderColor: 'border-gray-200 border-l-gray-300' },
            ];

            return (
              <>
                {/* Overdue alert banner */}
                {actionRequired.length > 0 && (
                  <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-3 flex items-center gap-3">
                    <span className="text-red-600 text-lg">!</span>
                    <div>
                      <span className="text-sm font-semibold text-red-700">
                        {actionRequired.length} enquir{actionRequired.length === 1 ? 'y' : 'ies'} need{actionRequired.length === 1 ? 's' : ''} attention
                      </span>
                      <span className="text-sm text-red-600 ml-2">
                        — overdue chases, due today, or new enquiries without a chase date
                      </span>
                    </div>
                  </div>
                )}

                {sections.map(section => {
                  if (section.jobs.length === 0) return null;
                  return (
                    <div key={section.key} className={`bg-white rounded-xl shadow-sm border border-l-4 ${section.borderColor} overflow-hidden`}>
                      <div className={`${section.bgHeader} px-4 py-2.5 border-b border-gray-200`}>
                        <span className={`text-xs font-semibold ${section.textColor} uppercase tracking-wide`}>
                          {section.label} ({section.jobs.length})
                        </span>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full">
                          {tableHead}
                          <tbody className="divide-y divide-gray-200">
                            {section.jobs.map(renderListRow)}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}

                {jobs.length === 0 && (
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 px-4 py-12 text-center text-sm text-gray-400">
                    No jobs match your filters
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* Modals */}
      <NewEnquiryModal
        isOpen={showNewEnquiry}
        onClose={() => setShowNewEnquiry(false)}
        onCreated={(jobId) => {
          fetchPipeline();
          if (jobId) navigate(`/jobs/${jobId}`);
        }}
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
