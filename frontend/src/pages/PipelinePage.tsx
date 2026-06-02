import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';
import DatePicker from '../components/DatePicker';
import ChaseModal from '../components/ChaseModal';
import CancelOpenRequirementsSection from '../components/CancelOpenRequirementsSection';
import type {
  Job, PipelineStatus, Likelihood, HoldReason, ConfirmedMethod,
} from '@shared/index';
import { PIPELINE_STATUS_CONFIG, LOST_REASON_OPTIONS, PAUSED_REASON_OPTIONS, PERSON_ORG_ROLES } from '@shared/index';

// Roles available for the "Linked organisations" picker on a job. These map
// to `job_organisations.role` (VARCHAR(50), free-text). Keep aligned with the
// comment in migration 027 listing band / client / promoter / venue_operator
// / supplier / management / label / other.
const LINKED_ORG_ROLES: Array<{ value: string; label: string }> = [
  { value: 'band', label: 'Band / Act' },
  { value: 'management', label: 'Management Company' },
  { value: 'promoter', label: 'Promoter' },
  { value: 'label', label: 'Label' },
  { value: 'venue_operator', label: 'Venue Operator' },
  { value: 'supplier', label: 'Supplier' },
  { value: 'other', label: 'Other' },
];

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

// ── View/filter persistence ────────────────────────────────────────────────
// Pipeline page remembers each user's preferred view, sort, and filter
// toggles across sessions. Search box is intentionally NOT persisted —
// users expect a fresh search each visit.

const PIPELINE_PREFS_KEY = 'ooosh.pipeline.prefs';

// Status pill keys correspond to the Kanban columns. 'enquiry' bundles
// new_enquiry + quoting (they render in the same Enquiries column).
type StatusPill = 'enquiry' | 'paused' | 'provisional';
type ValueBucket = '' | 'under_500' | '500_2000' | '2000_10000' | 'over_10000';
type ChaseCountBucket = '' | 'never' | '1_2' | '3_plus';
type ServiceTypePill = 'vehicle' | 'backline' | 'rehearsal';
// 'all' = no filter; 'yes' = only HireHop-linked; 'no' = only OP-native (no HH job number)
type HHJobFilter = 'all' | 'yes' | 'no';

interface PipelinePrefs {
  view: 'kanban' | 'list';
  sortMode: SortMode;
  filterLikelihood: string;
  filterChase: string;
  filterStatuses: StatusPill[];        // Multi-select status pills (empty = all)
  filterManager: string;               // person UUID or ''
  filterDateFrom: string;              // YYYY-MM-DD or ''
  filterDateTo: string;                // YYYY-MM-DD or ''
  filterHasHHJob: HHJobFilter;         // 3-state: All / In HireHop / OP-only
  filterServiceTypes: ServiceTypePill[];
  filterValueBucket: ValueBucket;
  filterChaseCount: ChaseCountBucket;
}

const PIPELINE_PREFS_DEFAULTS: PipelinePrefs = {
  view: 'kanban',
  sortMode: 'chase_date',
  filterLikelihood: '',
  filterChase: '',
  filterStatuses: [],
  filterManager: '',
  filterDateFrom: '',
  filterDateTo: '',
  filterHasHHJob: 'all',                // Default: show everything regardless of HH link
  filterServiceTypes: [],
  filterValueBucket: '',
  filterChaseCount: '',
};

function loadPipelinePrefs(): PipelinePrefs {
  if (typeof window === 'undefined') return PIPELINE_PREFS_DEFAULTS;
  try {
    const raw = window.localStorage.getItem(PIPELINE_PREFS_KEY);
    if (!raw) return PIPELINE_PREFS_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PipelinePrefs>;
    return { ...PIPELINE_PREFS_DEFAULTS, ...parsed };
  } catch {
    return PIPELINE_PREFS_DEFAULTS;
  }
}

// ── Column order ───────────────────────────────────────────────────────────
//
// Pipeline shows ENQUIRY-STAGE columns only (no Confirmed, no Lost — those
// have dedicated pages: /jobs and /jobs/lost-cancelled). Chasing is the
// virtual column for jobs with overdue chase dates.

const COLUMN_ORDER: PipelineStatus[] = [
  'new_enquiry', 'chasing', 'provisional', 'paused',
];

// Map a status pill → which COLUMN_ORDER entries it controls
const PILL_TO_COLUMNS: Record<StatusPill, PipelineStatus[]> = {
  enquiry: ['new_enquiry'],          // 'chasing' is its own pill-independent column
  paused: ['paused'],
  provisional: ['provisional'],
};

// Map a status pill → which pipeline_status DB values it covers
const PILL_TO_DB_STATUSES: Record<StatusPill, string[]> = {
  enquiry: ['new_enquiry', 'quoting'],
  paused: ['paused'],
  provisional: ['provisional'],
};

const VALUE_BUCKETS: Record<ValueBucket, { min: number | null; max: number | null; label: string }> = {
  '': { min: null, max: null, label: 'All values' },
  under_500: { min: null, max: 500, label: 'Under £500' },
  '500_2000': { min: 500, max: 2000, label: '£500 – £2k' },
  '2000_10000': { min: 2000, max: 10000, label: '£2k – £10k' },
  over_10000: { min: 10000, max: null, label: 'Over £10k' },
};

const CHASE_COUNT_BUCKETS: Record<ChaseCountBucket, { min: number | null; max: number | null; label: string }> = {
  '': { min: null, max: null, label: 'Any chase count' },
  never: { min: 0, max: 0, label: 'Never chased' },
  '1_2': { min: 1, max: 2, label: 'Chased 1–2×' },
  '3_plus': { min: 3, max: null, label: 'Chased 3+×' },
};

const SERVICE_TYPE_LABELS: Record<ServiceTypePill, string> = {
  vehicle: 'Vehicles',
  backline: 'Backline',
  rehearsal: 'Rehearsals',
};

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
      // If the user typed an exact-name match for exactly one organisation,
      // auto-link it. Avoids the "I typed the right thing but forgot to click
      // the dropdown row" trap. Only fires for unique matches; ambiguous
      // names (multiple orgs with the same name) still require manual pick.
      const exactOrgMatches = filtered.filter(
        r => r.type === 'organisation' && r.name.toLowerCase() === term.toLowerCase()
      );
      if (exactOrgMatches.length === 1) {
        onSelect(exactOrgMatches[0]);
        setShowDropdown(false);
      } else {
        const hasExactOrgMatch = exactOrgMatches.length > 0;
        setShowDropdown(filtered.length > 0 || (!hasExactOrgMatch && onCreateNew != null));
      }
    } catch {
      setResults([]);
      setHasSearched(true);
      if (term.length >= 2 && onCreateNew) setShowDropdown(true);
    } finally {
      setSearching(false);
    }
  }, [onCreateNew, onSelect]);

  const handleChange = (text: string) => {
    onChange(text);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => doSearch(text), 250);
  };

  const handleSelect = (result: SearchResult) => {
    // onSelect (handleClientSelect in the parent) sets both clientName AND
    // clientId via the dedicated path. Calling onChange() here too would
    // re-route through the parent's typing handler which clears clientId,
    // wiping the link the user just made.
    onSelect(result);
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
                {r.type === 'organisation' ? 'Org' : 'Contact'}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-900 truncate">{r.name}</div>
                {r.type === 'person' && (
                  <div className="text-xs text-gray-400 truncate italic">
                    Person — picks their organisation as client
                  </div>
                )}
                {r.type === 'organisation' && r.subtitle && (
                  <div className="text-xs text-gray-400 truncate">{r.subtitle}</div>
                )}
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
  const isLost = job.pipeline_status === 'lost';
  const chase = isLost ? { text: '', urgency: 'none' as const } : chaseDueLabel(job.next_chase_date);
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
      {/* Row 1: Job number + (real status badge if visiting Chasing) + value */}
      <div className="flex items-center justify-between mb-1 gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
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
          {/* Underlying status badge: shown when card is visiting the Chasing
              virtual column so the real lifecycle state stays visible. */}
          {job.is_chasing && job.pipeline_status && PIPELINE_STATUS_CONFIG[(job.pipeline_status === 'quoting' ? 'new_enquiry' : job.pipeline_status) as PipelineStatus] && (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded text-white"
              style={{ backgroundColor: PIPELINE_STATUS_CONFIG[(job.pipeline_status === 'quoting' ? 'new_enquiry' : job.pipeline_status) as PipelineStatus].colour }}
              title="Underlying status"
            >
              {PIPELINE_STATUS_CONFIG[(job.pipeline_status === 'quoting' ? 'new_enquiry' : job.pipeline_status) as PipelineStatus].label}
            </span>
          )}
        </div>
        <span className="text-sm font-semibold text-gray-900">
          {formatCurrency(job.job_value)}
        </span>
      </div>

      {/* Row 2: Job name */}
      <div className="text-sm font-medium text-gray-900 truncate mb-0.5">
        {job.job_name || 'Untitled'}
      </div>

      {/* Row 3: Band (if linked) takes top slot, else Client */}
      {(job as any).band_name ? (
        <>
          <div className="text-xs text-purple-700 font-medium truncate mb-0.5">
            {(job as any).band_name} <span className="text-purple-400 font-normal">(Band)</span>
          </div>
          {(job.company_name || job.client_name) && (
            <div className="text-xs text-gray-400 truncate mb-1">
              Billed to: {job.company_name || job.client_name}
            </div>
          )}
        </>
      ) : (
        <div className="text-xs text-gray-500 truncate mb-1">
          {job.company_name || job.client_name || '—'}
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
  jobId,
  onConfirm,
  onCancel,
}: {
  isOpen: boolean;
  targetStatus: PipelineStatus | null;
  jobId?: string;
  onConfirm: (data: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [holdReason, setHoldReason] = useState<HoldReason>('fully_booked');
  const [holdDetail, setHoldDetail] = useState('');
  const [setRevisit, setSetRevisit] = useState(false);
  const [revisitDate, setRevisitDate] = useState('');
  const [confirmedMethod, setConfirmedMethod] = useState<ConfirmedMethod>('deposit');
  const [lostReason, setLostReason] = useState('Price');
  const [lostDetail, setLostDetail] = useState('');
  const [note, setNote] = useState('');
  const [keepRequirementIds, setKeepRequirementIds] = useState<Set<string>>(new Set());

  if (!isOpen || !targetStatus) return null;

  const handleSubmit = () => {
    const data: Record<string, unknown> = {};
    if (targetStatus === 'paused') {
      data.hold_reason = holdReason;
      if (holdDetail) data.hold_reason_detail = holdDetail;
      // Optional revisit date — clears chase by default; staff opt-in here.
      if (setRevisit && revisitDate) data.revisit_date = revisitDate;
    } else if (targetStatus === 'confirmed') {
      data.confirmed_method = confirmedMethod;
    } else if (targetStatus === 'lost') {
      data.lost_reason = lostReason;
      if (lostDetail) data.lost_detail = lostDetail;
      if (keepRequirementIds.size > 0) data.keep_requirement_ids = Array.from(keepRequirementIds);
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
              {PAUSED_REASON_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
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
            <div className="border-t border-gray-200 pt-3 mt-2">
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={setRevisit}
                  onChange={(e) => setSetRevisit(e.target.checked)}
                  className="rounded border-gray-300 text-ooosh-600 focus:ring-ooosh-500"
                />
                Set a revisit date?
              </label>
              <p className="text-xs text-gray-500 mt-1">
                By default, paused jobs drop out of the Chasing pile. Set a date here and it'll come back when due — useful if you want another swing later (e.g. quieter period than expected).
              </p>
              {setRevisit && (
                <input
                  type="date"
                  value={revisitDate}
                  onChange={(e) => setRevisitDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="mt-2 w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
                />
              )}
            </div>
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
            {jobId && (
              <CancelOpenRequirementsSection
                jobId={jobId}
                targetStatus="lost"
                keepIds={keepRequirementIds}
                onChange={setKeepRequirementIds}
              />
            )}
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

  // Contacts cascade — once a client org is picked we surface the people
  // already linked to it (read-only chip list), and let staff add new ones
  // inline without leaving the modal. Contacts entered for a NEW client are
  // staged and created in sequence after the org itself is created on
  // submit. Phase 3 doesn't yet write a per-job contact link (that's the
  // Phase 4 `job_contacts` work) — for now everything attaches to the org
  // via `person_organisation_roles`. The cascade is the UX win on its own.
  const [clientPeople, setClientPeople] = useState<Array<{
    id: string; person_id: string; person_name: string; person_email: string | null;
    role: string; is_primary: boolean; status: string;
  }>>([]);
  const [clientPeopleLoading, setClientPeopleLoading] = useState(false);

  // Pending contacts staged in the modal. Two flavours both routed through
  // POST /api/organisations/:orgId/people on submit:
  //   - `existing_person_id` set → "link existing person to this org"
  //     (search-first Add Contact path, when staff picks an existing person)
  //   - `existing_person_id` null → "create + link new person"
  //     (search-first Add Contact path, when staff clicks "Create new")
  // Both end up as job contacts via job_contacts after the link succeeds.
  const [pendingContacts, setPendingContacts] = useState<Array<{
    _tempId: string;
    target: 'client' | string;        // 'client' or a linked-org tempId
    existing_person_id: string | null;
    first_name: string; last_name: string;
    email: string; phone: string;
    role: string;
  }>>([]);

  // Per-job contact selection (writes to job_contacts on submit).
  //   - tickedExistingPersonIds: of the client org's existing people, which
  //     ones did staff tick as contacts on THIS hire.
  //   - leadContactKey: stable key for the lead contact across both buckets.
  //     For ticked existing people, key = person_id. For pending entries,
  //     key = _tempId. Resolved to a real person_id at submit time.
  //   - First-clicked auto-becomes lead. Subsequent clicks on a non-lead
  //     selected chip promote it to lead. X removes.
  const [tickedExistingPersonIds, setTickedExistingPersonIds] = useState<Set<string>>(new Set());
  const [leadContactKey, setLeadContactKey] = useState<string | null>(null);
  // When staff arrives at the client via the person-first flow (searched
  // a person → clicked → their org got promoted), remember which person
  // they originally clicked so the cascade can auto-tick them when it
  // loads. Otherwise the modal would surface their org's contacts but
  // make staff manually pick the person they just searched for — one of
  // those small UX gaps that's obvious in hindsight.
  const [personFirstClickedId, setPersonFirstClickedId] = useState<string | null>(null);

  // Add-contact UX (search-first, mirrors Org Detail "Add Person")
  const [showAddContact, setShowAddContact] = useState(false);
  const [addContactSearch, setAddContactSearch] = useState('');
  const [addContactResults, setAddContactResults] = useState<Array<{
    id: string; name: string; subtitle: string | null; type: string;
  }>>([]);
  const [addContactSearching, setAddContactSearching] = useState(false);
  // Inline "create new" form (revealed when staff clicks the "+ Create new
  // contact" affordance after a search)
  const [showCreateContactForm, setShowCreateContactForm] = useState(false);
  const [contactFirstName, setContactFirstName] = useState('');
  const [contactLastName, setContactLastName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactRole, setContactRole] = useState('General Contact');

  // Linked organisations — replaces the old single-org "Band / Act" picker.
  // A job can now have N linked orgs (band, management, promoter, label,
  // venue operator, supplier...) — same place sales used to type the band
  // name. Existing orgs get a `orgId`; orgs typed for the first time get
  // `isNew=true` and are created on submit. The first linked org with
  // role='band' is used for band trading history (preserves existing UX).
  const [linkedOrgs, setLinkedOrgs] = useState<Array<{
    _tempId: string;
    orgId: string | null;
    orgName: string;
    role: string;
    isNew: boolean;
  }>>([]);
  const [showAddLinkedOrg, setShowAddLinkedOrg] = useState(false);
  const [linkedOrgSearch, setLinkedOrgSearch] = useState('');
  const [linkedOrgResults, setLinkedOrgResults] = useState<Array<{ id: string; name: string; type: string; email?: string | null }>>([]);
  const [linkedOrgPickedId, setLinkedOrgPickedId] = useState<string | null>(null);
  const [linkedOrgPickedName, setLinkedOrgPickedName] = useState('');
  const [linkedOrgRole, setLinkedOrgRole] = useState<string>('band');

  // Backwards-compat shims for client history (which keys off the band's
  // org_id). Derived from linkedOrgs — first band wins.
  const bandLink = linkedOrgs.find(l => l.role === 'band' && l.orgId);
  const bandId = bandLink?.orgId ?? null;
  const bandName = bandLink?.orgName ?? '';

  // Person-picked-as-client prompt. Clients must be organisations; if the
  // user selects a person, we show their orgs as quick-picks rather than
  // letting the person end up as client_name.
  const [pendingPerson, setPendingPerson] = useState<{
    id: string;
    name: string;
    orgs: Array<{ id: string; name: string; role: string | null }>;
  } | null>(null);

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
    band_history?: {
      jobs: Array<{
        id: string; hh_job_number: number | null; job_name: string | null;
        status: number; pipeline_status: string | null; job_date: string | null;
        job_end: string | null; job_value: number | null;
      }>;
      stats: {
        total_jobs: string; confirmed_jobs: string; lost_jobs: string;
        total_confirmed_value: string; total_value: string;
      };
      band_info?: { id: string; name: string; do_not_hire: boolean; do_not_hire_reason: string | null; internal_notes: string | null } | null;
    } | null;
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const fetchClientHistory = useCallback(async (orgId: string | null, name: string, currentBandId?: string | null) => {
    if (!name || name.length < 2) { setClientHistory(null); return; }
    setHistoryLoading(true);
    try {
      let params = orgId
        ? `client_id=${encodeURIComponent(orgId)}`
        : `client_name=${encodeURIComponent(name)}`;
      if (currentBandId) params += `&band_id=${encodeURIComponent(currentBandId)}`;
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

  // Linked-organisation search (replaces the old band-only search). Same
  // org-only filter as before — we don't want people surfaced here, since
  // a linked entity on a job is always an organisation.
  useEffect(() => {
    if (linkedOrgSearch.length < 2) { setLinkedOrgResults([]); return; }
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ data: Array<{ id: string; name: string; type: string; email?: string | null }> }>(
          `/organisations?search=${encodeURIComponent(linkedOrgSearch)}&limit=10`
        );
        setLinkedOrgResults(data.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(timeout);
  }, [linkedOrgSearch]);

  // Cascade: when a client org is picked, fetch its existing people so we
  // can surface "Contacts at [Client]" without staff having to leave the
  // modal. Skipped for new-client mode (no org exists yet) and when the
  // field is cleared.
  //
  // Auto-tick a sensible default per cascade load (one-shot, not sticky):
  //   1. Person-first flow → the originally-clicked person (most direct
  //      signal of intent — staff literally just searched for them).
  //   2. Org has exactly one contact → that one (no decision to make).
  //   3. Org has multiple contacts AND one is marked primary at org
  //      level → that one (the "main contact" signal).
  //   4. Otherwise → no auto-tick, staff picks deliberately.
  // Staff can always untick and pick a different one — auto-tick fires
  // ONCE per client switch, not on every render. If they untick then
  // submit, that's a deliberate "no lead" choice we respect.
  useEffect(() => {
    if (!clientId) { setClientPeople([]); return; }
    let cancelled = false;
    setClientPeopleLoading(true);
    api.get<{ people?: Array<{ id: string; person_id: string; person_name: string; person_email: string | null; role: string; is_primary: boolean; status: string }> | null }>(`/organisations/${clientId}`)
      .then(data => {
        if (cancelled) return;
        const active = (data.people || []).filter(p => p.status === 'active');
        setClientPeople(active);

        // Auto-tick default (only when nothing is currently ticked — don't
        // override a manual selection mid-load if state somehow lingers).
        if (tickedExistingPersonIds.size === 0 && pendingContacts.filter(c => c.target === 'client').length === 0) {
          let defaultId: string | null = null;
          // Rule 1: person-first flow — honour the user's click even if
          // emailless (they explicitly picked this person). The lead-contact
          // emailless guard below catches it before they hit Submit.
          if (personFirstClickedId && active.some(p => p.person_id === personFirstClickedId)) {
            defaultId = personFirstClickedId;
          } else {
            // Rules 2 & 3 prefer reachable contacts so the auto-default
            // doesn't land on someone who can't receive emails (Issue 1 —
            // splatter-gun fix companion). If every candidate is
            // emailless, fall back to today's behaviour so SOMETHING gets
            // ticked.
            const reachable = active.filter(p => p.person_email && p.person_email.trim());
            const pool = reachable.length > 0 ? reachable : active;
            // Rule 2: single contact
            if (pool.length === 1) {
              defaultId = pool[0].person_id;
            }
            // Rule 3: org-level primary
            else if (pool.length > 1) {
              const primary = pool.find(p => p.is_primary);
              if (primary) defaultId = primary.person_id;
            }
          }
          if (defaultId) {
            setTickedExistingPersonIds(new Set([defaultId]));
            setLeadContactKey(defaultId);
          }
        }
        // Consume the person-first signal regardless of whether it matched —
        // it's a one-shot per client switch.
        if (personFirstClickedId) setPersonFirstClickedId(null);
      })
      .catch(() => { if (!cancelled) setClientPeople([]); })
      .finally(() => { if (!cancelled) setClientPeopleLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  // Escape key to close
  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  // Add-contact search — debounced /api/search lookup for the search-first
  // affordance. People-only filter so staff land on a known person rather
  // than misclicking an org.
  useEffect(() => {
    if (!showAddContact || addContactSearch.length < 2) {
      setAddContactResults([]);
      return;
    }
    setAddContactSearching(true);
    const timeout = setTimeout(async () => {
      try {
        const data = await api.get<{ results: Array<{ id: string; name: string; subtitle: string | null; type: string }> }>(
          `/search?q=${encodeURIComponent(addContactSearch)}&limit=10`
        );
        setAddContactResults((data.results || []).filter(r => r.type === 'person'));
      } catch {
        setAddContactResults([]);
      } finally {
        setAddContactSearching(false);
      }
    }, 250);
    return () => clearTimeout(timeout);
  }, [addContactSearch, showAddContact]);

  if (!isOpen) return null;

  // Drop client-target pending contacts AND ticks whenever the client
  // identity changes. Otherwise a contact staged for ATC Live could end
  // up attached to a different org if staff switch the client mid-modal.
  const clearClientContacts = () => {
    setPendingContacts(prev => prev.filter(c => c.target !== 'client'));
    setTickedExistingPersonIds(new Set());
    setLeadContactKey(null);
    setPersonFirstClickedId(null);
  };

  // Chip click handler — implements the click-once-select /
  // click-again-promote-to-lead pattern. First-clicked auto-becomes lead
  // (only if no lead exists yet). Subsequent clicks on a non-lead chip
  // promote it. Click on the current lead is a no-op (use X to deselect).
  //
  // `hasEmail` defaults to true. When false (emailless contact), the
  // promote-to-lead step is blocked — the contact can still be ticked as
  // a CC but won't become the star. Mirrors the JobContactsCard guard
  // and stops staff inadvertently selecting an unreachable primary
  // (Issue 1 — splatter-gun fix companion).
  const handleChipClick = (key: string, hasEmail = true) => {
    // Is this an existing person (key looks like a UUID) or a pending entry
    // (key looks like _tempId)? The toggle logic differs slightly.
    const isPending = key.startsWith('c-');
    const isTicked = isPending
      ? pendingContacts.some(c => c._tempId === key)
      : tickedExistingPersonIds.has(key);

    if (!isTicked) {
      // Select. Become lead if no current lead AND the contact is reachable.
      if (!isPending) {
        setTickedExistingPersonIds(prev => new Set(prev).add(key));
      }
      // (Pending entries are already in the array; "selected" === "exists")
      if (hasEmail) {
        setLeadContactKey(prev => prev ?? key);
      }
      return;
    }

    // Already selected. If lead, no-op (use X to deselect).
    if (leadContactKey === key) return;
    // Promote to lead — blocked if emailless.
    if (!hasEmail) return;
    setLeadContactKey(key);
  };

  // Deselect a contact entirely (X button). If it was the lead, promote
  // the next still-selected contact to lead.
  const handleChipRemove = (key: string) => {
    const isPending = key.startsWith('c-');
    if (isPending) {
      setPendingContacts(prev => prev.filter(c => c._tempId !== key));
    } else {
      setTickedExistingPersonIds(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
    if (leadContactKey === key) {
      // Pick next available lead — first remaining ticked existing or
      // first remaining pending, in that order.
      const nextExisting = [...tickedExistingPersonIds].find(id => id !== key);
      const nextPending = pendingContacts.find(c => c.target === 'client' && c._tempId !== key);
      setLeadContactKey(nextExisting ?? nextPending?._tempId ?? null);
    }
  };

  const handleClientSelect = async (result: SearchResult) => {
    setIsNewClient(false);
    clearClientContacts();
    if (result.type === 'organisation') {
      setPendingPerson(null);
      setClientName(result.name);
      setClientId(result.id);
      fetchClientHistory(result.id, result.name, bandId);
      return;
    }
    // Person selected — clients must be orgs. Clear the field and surface
    // their orgs as quick-picks. Stash the clicked person so the cascade
    // auto-ticks them once their org is picked + people load.
    setPersonFirstClickedId(result.id);
    setClientName('');
    setClientId(null);
    try {
      const personData = await api.get<{
        organisations: Array<{ organisation_id: string; organisation_name: string; status: string; role: string | null }> | null;
      }>(`/people/${result.id}`);
      const activeOrgs = (personData.organisations || [])
        .filter(o => o.status === 'active')
        .map(o => ({ id: o.organisation_id, name: o.organisation_name, role: o.role }));
      setPendingPerson({ id: result.id, name: result.name, orgs: activeOrgs });
    } catch {
      setPendingPerson({ id: result.id, name: result.name, orgs: [] });
    }
  };

  const handleCreateNewClient = (name: string) => {
    setClientName(name);
    setClientId(null);
    setIsNewClient(true);
    clearClientContacts();
    // Fetch history by name in case there are jobs under this name already
    fetchClientHistory(null, name, bandId);
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
    if (pendingPerson) {
      setError('Pick an organisation for the client, or dismiss the person warning.');
      return;
    }
    if (!clientName || (!details && serviceTypes.length === 0)) {
      setError('Client and description are required');
      return;
    }

    // Auto-save any unsaved form data the user left dangling — the
    // forgot-to-click-Save trap. If the contact form has data, treat
    // staff's intent as "yes, save this contact" and roll it in. Same
    // for the linked-org form. State setters are async (won't apply
    // until next render), so we build local copies of the lists and
    // use those for the remainder of this submit cycle.
    const finalPendingContacts = [...pendingContacts];
    let effectiveLeadKey = leadContactKey;
    if (showAddContact && showCreateContactForm && (
      contactFirstName.trim() || contactLastName.trim() ||
      contactEmail.trim() || contactPhone.trim()
    )) {
      if (!contactFirstName.trim() || !contactLastName.trim()) {
        setError('You have an unsaved contact missing first or last name. Click "Save contact" or Cancel before submitting.');
        return;
      }
      if (contactEmail.trim() && !EMAIL_REGEX.test(contactEmail.trim())) {
        setError('You have an unsaved contact with an invalid email. Fix or cancel it before submitting.');
        return;
      }
      const tempId = `c-${Date.now()}-auto-${Math.random().toString(36).slice(2, 5)}`;
      finalPendingContacts.push({
        _tempId: tempId,
        target: 'client',
        existing_person_id: null,
        first_name: contactFirstName.trim(),
        last_name: contactLastName.trim(),
        email: contactEmail.trim(),
        phone: contactPhone.trim(),
        role: contactRole,
      });
      if (!effectiveLeadKey) effectiveLeadKey = tempId;
    }

    const finalLinkedOrgs = [...linkedOrgs];
    if (showAddLinkedOrg && linkedOrgPickedName.trim()) {
      const dup = finalLinkedOrgs.some(lo =>
        lo.orgId && lo.orgId === linkedOrgPickedId && lo.role === linkedOrgRole
      );
      if (!dup) {
        finalLinkedOrgs.push({
          _tempId: `lo-${Date.now()}-auto-${Math.random().toString(36).slice(2, 5)}`,
          orgId: linkedOrgPickedId,
          orgName: linkedOrgPickedName.trim(),
          role: linkedOrgRole,
          isNew: !linkedOrgPickedId,
        });
      }
    }

    setSaving(true);
    setError('');
    try {
      // Create new client organisation if needed.
      // Email + phone are deliberately NOT collected here any more — those
      // belong on a Person, not the Org. Staff add org-level catchall comms
      // via Org Detail later if needed. (See discussion 13 May 2026.)
      let resolvedClientId = clientId;
      if (isNewClient && clientName.trim()) {
        try {
          const newOrg = await api.post<{ id: string }>('/organisations', {
            name: clientName.trim(),
            type: 'client',
          });
          resolvedClientId = newOrg.id;
        } catch (orgErr) {
          setError(orgErr instanceof Error ? orgErr.message : 'Failed to create client organisation');
          setSaving(false);
          return;
        }
      }

      // Create / link any staged contacts on the client org, and build a
      // mapping from each contact's modal-time key (person_id for existing
      // people, _tempId for staged ones) to the resolved real person_id.
      // The job_contacts writes on the backend need real UUIDs.
      const tempIdToPersonId = new Map<string, string>();
      const failedContacts: string[] = [];
      if (resolvedClientId) {
        const clientContacts = finalPendingContacts.filter(c => c.target === 'client');
        for (const c of clientContacts) {
          try {
            // Existing-person link: pass person_id. Otherwise: create + link.
            const body = c.existing_person_id
              ? { person_id: c.existing_person_id, role: c.role, is_primary: false }
              : {
                  new_person: {
                    first_name: c.first_name,
                    last_name: c.last_name,
                    email: c.email || undefined,
                    mobile: c.phone || undefined,
                  },
                  role: c.role,
                  is_primary: false,
                };
            const result = await api.post<{
              role: { person_id: string };
              person?: { id: string } | null;
            }>(`/organisations/${resolvedClientId}/people`, body);
            // Resolve the person_id from either the created person or the
            // role row (which carries person_id whether new or existing).
            const resolvedId = result.person?.id || result.role.person_id;
            tempIdToPersonId.set(c._tempId, resolvedId);
          } catch (contactErr) {
            const errMsg = contactErr instanceof Error ? contactErr.message : String(contactErr);
            const displayName = `${c.first_name} ${c.last_name}`.trim() || c.email || 'unknown';
            failedContacts.push(displayName);
            // Verbose log so the user → developer handoff has the
            // request body + error if this surfaces again.
            console.error('[New Enquiry] Failed to create/link contact:', {
              contact: {
                first_name: c.first_name,
                last_name: c.last_name,
                email: c.email,
                role: c.role,
                existing_person_id: c.existing_person_id,
              },
              orgId: resolvedClientId,
              error: errMsg,
            });
          }
        }
      }

      // Build the per-job contact list. Existing-org-people who got ticked
      // contribute their person_id directly; staged entries contribute the
      // newly-resolved person_id (looked up via tempIdToPersonId).
      const contactPersonIds: string[] = [
        ...tickedExistingPersonIds,
        ...finalPendingContacts
          .filter(c => c.target === 'client')
          .map(c => tempIdToPersonId.get(c._tempId))
          .filter((id): id is string => !!id),
      ];

      // Resolve the lead contact key to a real person_id. The key is
      // either a person_id directly (for existing-org chips) or a _tempId
      // (for pending entries) — the latter needs the mapping built above.
      let primaryContactPersonId: string | null = null;
      if (effectiveLeadKey) {
        if (effectiveLeadKey.startsWith('c-')) {
          primaryContactPersonId = tempIdToPersonId.get(effectiveLeadKey) ?? null;
        } else {
          primaryContactPersonId = effectiveLeadKey;
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
        contact_person_ids: contactPersonIds.length > 0 ? contactPersonIds : undefined,
        primary_contact_person_id: primaryContactPersonId || undefined,
      });

      // Link any organisations the user added — bands, promoters, labels,
      // venue operators, suppliers. New orgs get created here too.
      const failedLinkedOrgs: string[] = [];
      if (created.id && finalLinkedOrgs.length > 0) {
        for (const lo of finalLinkedOrgs) {
          try {
            let resolvedLinkedOrgId = lo.orgId;
            if (!resolvedLinkedOrgId && lo.orgName.trim()) {
              // Map the linked-org role to the most sensible default org type.
              // Free-text orgs typed here usually need their type set later
              // anyway, so we pick a coarse default rather than asking.
              const orgTypeForRole: Record<string, string> = {
                band: 'band',
                management: 'management',
                promoter: 'promoter',
                label: 'label',
                venue_operator: 'venue_operator',
                supplier: 'supplier',
                other: 'other',
              };
              const newOrg = await api.post<{ id: string }>('/organisations', {
                name: lo.orgName.trim(),
                type: orgTypeForRole[lo.role] || 'other',
              });
              resolvedLinkedOrgId = newOrg.id;
            }
            if (resolvedLinkedOrgId) {
              await api.post(`/pipeline/${created.id}/organisations`, {
                organisation_id: resolvedLinkedOrgId,
                role: lo.role,
              });
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            failedLinkedOrgs.push(lo.orgName);
            console.error('[New Enquiry] Failed to link organisation:', { org: lo, error: errMsg });
          }
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
      setClientName(''); setClientId(null); setIsNewClient(false); setDetails('');
      setOutDate(''); setJobDate(''); setJobEnd(''); setReturnDate('');
      setOutLinked(true); setReturnLinked(true);
      setJobName(''); setJobValue(''); setLikelihood('warm');
      setClientHistory(null);
      setLinkedOrgs([]); setShowAddLinkedOrg(false);
      setLinkedOrgPickedId(null); setLinkedOrgPickedName('');
      setLinkedOrgSearch(''); setLinkedOrgResults([]); setLinkedOrgRole('band');
      setPendingContacts([]); setShowAddContact(false); setShowCreateContactForm(false);
      setContactFirstName(''); setContactLastName(''); setContactEmail('');
      setContactPhone(''); setContactRole('General Contact');
      setAddContactSearch(''); setAddContactResults([]);
      setTickedExistingPersonIds(new Set()); setLeadContactKey(null);
      setPersonFirstClickedId(null);
      setClientPeople([]);
      setPendingPerson(null);
      setEnquirySource(''); setNotes(''); setShowOptional(false);
      setStagedFiles([]); setFileTag(''); setFileComment('');
      setNextChaseDate(addDaysToDate(5)); setSelectedChasePreset('5 days'); setChaseAlertUserId('');
      // Close first (clears `?newEnquiry=1` search param via setSearchParams)
      // before navigating away — otherwise the relative `setSearchParams` call
      // can race with the navigate and bounce us back to /pipeline.
      onClose();
      onCreated(created.id);

      // Defensive alert if any sub-creations silently failed (contacts /
      // linked orgs). The enquiry itself was created, so we don't want to
      // block the success path — but staff need to know to fix things up
      // on the org page rather than assuming everything landed. The
      // verbose console logs above carry the detail for diagnosis.
      if (failedContacts.length > 0 || failedLinkedOrgs.length > 0) {
        // setTimeout so the alert fires AFTER the modal closes — otherwise
        // the alert and the modal transition compete for focus.
        setTimeout(() => {
          const lines: string[] = ['Enquiry created — but the following did NOT save:'];
          if (failedContacts.length > 0) {
            lines.push('', 'Contacts:');
            failedContacts.forEach(n => lines.push(`  • ${n}`));
          }
          if (failedLinkedOrgs.length > 0) {
            lines.push('', 'Linked organisations:');
            failedLinkedOrgs.forEach(n => lines.push(`  • ${n}`));
          }
          lines.push('', 'Add them manually from the relevant page. Full details in browser console (F12).');
          alert(lines.join('\n'));
        }, 200);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create enquiry');
    } finally {
      setSaving(false);
    }
  };

  const hasHistory = clientHistory && (parseInt(clientHistory.stats.total_jobs) > 0 || clientHistory.client_info || clientHistory.band_history);

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
              onChange={(name) => { setClientName(name); setClientId(null); setIsNewClient(false); setPendingPerson(null); clearClientContacts(); }}
              onSelect={handleClientSelect}
              onCreateNew={handleCreateNewClient}
            />
            {pendingPerson && (
              <div className="mt-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div>
                    <p className="text-sm font-medium text-amber-900">
                      <span className="font-semibold">{pendingPerson.name}</span> is a person — clients must be an organisation.
                    </p>
                    {pendingPerson.orgs.length > 0 ? (
                      <p className="text-xs text-amber-700 mt-1">Pick one of their organisations as the client:</p>
                    ) : (
                      <p className="text-xs text-amber-700 mt-1">
                        They aren't linked to any organisations. Search again for the client org, or type a new name to create one.
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingPerson(null)}
                    className="text-amber-500 hover:text-amber-700 text-lg leading-none"
                    title="Dismiss"
                  >
                    &times;
                  </button>
                </div>
                {pendingPerson.orgs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {pendingPerson.orgs.map(org => (
                      <button
                        key={org.id}
                        type="button"
                        onClick={() => {
                          setClientName(org.name);
                          setClientId(org.id);
                          setIsNewClient(false);
                          setPendingPerson(null);
                          clearClientContacts();
                          fetchClientHistory(org.id, org.name, bandId);
                        }}
                        className="px-2.5 py-1 bg-white border border-amber-300 rounded text-xs text-amber-900 hover:bg-amber-100 transition-colors"
                      >
                        {org.name}
                        {org.role && <span className="text-amber-500 ml-1">({org.role})</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {clientId && !pendingPerson && (
              <p className="text-xs text-green-600 mt-1">Linked to organisation</p>
            )}
            {isNewClient && (
              <div className="mt-2 p-2 bg-green-50 border border-green-200 rounded-lg flex items-center justify-between">
                <p className="text-sm text-green-800">
                  Will create new client: <span className="font-semibold">{clientName}</span>
                </p>
                <button
                  type="button"
                  onClick={() => { setIsNewClient(false); }}
                  className="text-xs text-green-500 hover:text-green-700"
                >
                  &times; Cancel
                </button>
              </div>
            )}
          </div>

          {/* Contacts cascade — surface people at the picked client and let
              staff TICK who's on this hire (writes to job_contacts) +
              "+ Add contact" to attach more (search-first to avoid
              duplicates). First-clicked chip auto-becomes lead; click
              another to promote it. X to deselect. */}
          {(clientId || isNewClient) && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-gray-700">
                  Contacts at {clientName || 'this client'} <span className="text-gray-400 font-normal">(optional — tick who's on this hire)</span>
                </label>
                {!showAddContact && (
                  <button
                    type="button"
                    onClick={() => { setShowAddContact(true); setAddContactSearch(''); setAddContactResults([]); setShowCreateContactForm(false); }}
                    className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                  >
                    + Add contact
                  </button>
                )}
              </div>

              {/* Empty state */}
              {clientId && !clientPeopleLoading && clientPeople.length === 0 && pendingContacts.filter(c => c.target === 'client').length === 0 && (
                <p className="text-xs text-gray-400 italic">No contacts on file yet — add one here or via the organisation page later.</p>
              )}
              {clientId && clientPeopleLoading && (
                <p className="text-xs text-gray-400 italic">Loading contacts…</p>
              )}

              {/* Tickable chips. Renders existing org people + any
                  pending entries the user added in this session. */}
              {(clientPeople.length > 0 || pendingContacts.filter(c => c.target === 'client').length > 0) && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {clientPeople.map(p => {
                    const ticked = tickedExistingPersonIds.has(p.person_id);
                    const isLead = leadContactKey === p.person_id;
                    const hasEmail = !!(p.person_email && p.person_email.trim());
                    return (
                      <span
                        key={p.id}
                        className={`inline-flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-pointer transition-colors ${
                          isLead
                            ? 'bg-blue-100 border-blue-400 text-blue-900'
                            : ticked
                              ? 'bg-blue-50 border-blue-200 text-blue-800'
                              : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
                        }`}
                        onClick={() => handleChipClick(p.person_id, hasEmail)}
                        title={
                          isLead
                            ? 'Lead contact'
                            : ticked
                              ? (hasEmail ? 'Click again to make lead contact' : 'No email — can\'t be lead contact')
                              : (hasEmail ? 'Click to select for this hire' : 'Click to add as CC (no email — can\'t be lead)')
                        }
                      >
                        {isLead && <span title="Lead contact">★</span>}
                        <span className={isLead ? 'font-bold' : 'font-medium'}>{p.person_name}</span>
                        {p.role && <span className="opacity-60">({p.role})</span>}
                        {!hasEmail && (
                          <span className="opacity-50 italic text-[10px]" title="No email on file">⚠ no email</span>
                        )}
                        {ticked && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); handleChipRemove(p.person_id); }}
                            className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
                            title="Remove from this hire"
                          >
                            &times;
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {pendingContacts.filter(c => c.target === 'client').map(c => {
                    const isLead = leadContactKey === c._tempId;
                    const displayName = c.existing_person_id
                      ? `${c.first_name} ${c.last_name}`.trim()
                      : `${c.first_name} ${c.last_name}`.trim() || c.email || 'New contact';
                    return (
                      <span
                        key={c._tempId}
                        className={`inline-flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-pointer transition-colors ${
                          isLead
                            ? 'bg-blue-100 border-blue-400 text-blue-900'
                            : 'bg-blue-50 border-blue-200 text-blue-800'
                        }`}
                        onClick={() => handleChipClick(c._tempId)}
                        title={isLead ? 'Lead contact' : 'Click again to make lead contact'}
                      >
                        {isLead && <span title="Lead contact">★</span>}
                        <span className={isLead ? 'font-bold' : 'font-medium'}>{displayName}</span>
                        {!c.existing_person_id && <span className="opacity-50 italic">— new</span>}
                        {c.role && <span className="opacity-60">({c.role})</span>}
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleChipRemove(c._tempId); }}
                          className="ml-0.5 opacity-50 hover:opacity-100 leading-none"
                          title="Remove"
                        >
                          &times;
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}

              {/* Search-first Add Contact. Mirrors the Org Detail "Add
                  Person" pattern — type to find existing people first, so
                  duplicates don't accumulate. "+ Create new" fallback if
                  no match. */}
              {showAddContact && !showCreateContactForm && (
                <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-blue-800 font-medium">Add a contact to {clientName || 'this client'}</p>
                    <button
                      type="button"
                      onClick={() => { setShowAddContact(false); setAddContactSearch(''); setAddContactResults([]); setError(''); }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                  </div>
                  <input
                    type="text"
                    value={addContactSearch}
                    onChange={e => setAddContactSearch(e.target.value)}
                    placeholder="Search existing people by name or email…"
                    className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    autoFocus
                  />
                  {addContactSearching && (
                    <p className="text-xs text-blue-400 italic">Searching…</p>
                  )}
                  {!addContactSearching && addContactSearch.length >= 2 && addContactResults.length > 0 && (
                    <div className="bg-white border border-blue-200 rounded max-h-48 overflow-y-auto">
                      {addContactResults.map(p => {
                        // Skip people already at this org (already shown as chips)
                        const alreadyAtOrg = clientPeople.some(cp => cp.person_id === p.id);
                        const alreadyStaged = pendingContacts.some(pc => pc.existing_person_id === p.id && pc.target === 'client');
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={alreadyAtOrg || alreadyStaged}
                            onClick={() => {
                              const tempId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                              const [firstName, ...rest] = p.name.split(' ');
                              const entry = {
                                _tempId: tempId,
                                target: 'client' as const,
                                existing_person_id: p.id,
                                first_name: firstName || '',
                                last_name: rest.join(' ') || '',
                                email: p.subtitle || '',
                                phone: '',
                                role: 'General Contact',
                              };
                              setPendingContacts(prev => [...prev, entry]);
                              setLeadContactKey(prev => prev ?? tempId);
                              setShowAddContact(false);
                              setAddContactSearch('');
                              setAddContactResults([]);
                            }}
                            className={`w-full text-left px-3 py-2 text-sm border-b border-blue-50 last:border-b-0 ${
                              alreadyAtOrg || alreadyStaged
                                ? 'opacity-50 cursor-not-allowed'
                                : 'hover:bg-blue-50'
                            }`}
                          >
                            <div className="font-medium">{p.name}</div>
                            {p.subtitle && <div className="text-xs text-gray-400">{p.subtitle}</div>}
                            {alreadyAtOrg && <div className="text-xs text-gray-400 italic">already at this org</div>}
                            {alreadyStaged && !alreadyAtOrg && <div className="text-xs text-gray-400 italic">already added</div>}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {!addContactSearching && addContactSearch.length >= 2 && addContactResults.length === 0 && (
                    <p className="text-xs text-gray-500 italic">No matching people found</p>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setShowCreateContactForm(true);
                      // Pre-fill if user typed a name in the search
                      if (addContactSearch.trim()) {
                        const parts = addContactSearch.trim().split(/\s+/);
                        setContactFirstName(parts[0] || '');
                        setContactLastName(parts.slice(1).join(' ') || '');
                      }
                    }}
                    className="text-xs text-blue-600 hover:text-blue-700 font-medium"
                  >
                    + Create new contact{addContactSearch.trim() ? ` "${addContactSearch.trim()}"` : ''}
                  </button>
                </div>
              )}

              {/* Create-new inline form (revealed from search step) */}
              {showAddContact && showCreateContactForm && (
                <div className="mt-2 p-3 bg-blue-50 border border-blue-200 rounded-lg space-y-2">
                  <p className="text-xs text-blue-800 font-medium">Create a new contact at {clientName || 'this client'}</p>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="text"
                      value={contactFirstName}
                      onChange={e => setContactFirstName(e.target.value)}
                      placeholder="First name *"
                      className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                      autoFocus
                    />
                    <input
                      type="text"
                      value={contactLastName}
                      onChange={e => setContactLastName(e.target.value)}
                      placeholder="Last name *"
                      className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="email"
                      value={contactEmail}
                      onChange={e => setContactEmail(e.target.value)}
                      placeholder="Email"
                      className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    />
                    <input
                      type="tel"
                      value={contactPhone}
                      onChange={e => setContactPhone(e.target.value)}
                      placeholder="Phone"
                      className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                    />
                  </div>
                  <select
                    value={contactRole}
                    onChange={e => setContactRole(e.target.value)}
                    className="w-full border border-blue-200 rounded px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400 bg-white"
                  >
                    {PERSON_ORG_ROLES.map(r => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                  {contactEmail.trim() && !EMAIL_REGEX.test(contactEmail.trim()) && (
                    <p className="text-xs text-red-500">Please enter a valid email address</p>
                  )}
                  <div className="flex justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setShowAddContact(false);
                        setShowCreateContactForm(false);
                        setContactFirstName(''); setContactLastName('');
                        setContactEmail(''); setContactPhone('');
                        setContactRole('General Contact');
                        setAddContactSearch(''); setAddContactResults([]);
                        setError('');
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!contactFirstName.trim() || !contactLastName.trim()) {
                          setError('Contact needs both a first and last name');
                          return;
                        }
                        if (contactEmail.trim() && !EMAIL_REGEX.test(contactEmail.trim())) {
                          setError('Please enter a valid email address for the contact');
                          return;
                        }
                        setError('');
                        const tempId = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                        setPendingContacts(prev => [...prev, {
                          _tempId: tempId,
                          target: 'client',
                          existing_person_id: null,
                          first_name: contactFirstName.trim(),
                          last_name: contactLastName.trim(),
                          email: contactEmail.trim(),
                          phone: contactPhone.trim(),
                          role: contactRole,
                        }]);
                        // First-added auto-becomes lead
                        setLeadContactKey(prev => prev ?? tempId);
                        setShowAddContact(false);
                        setShowCreateContactForm(false);
                        setContactFirstName(''); setContactLastName('');
                        setContactEmail(''); setContactPhone('');
                        setContactRole('General Contact');
                        setAddContactSearch(''); setAddContactResults([]);
                      }}
                      className="text-xs bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
                    >
                      Save contact
                    </button>
                  </div>
                </div>
              )}

              {/* Hint about the click-twice promote-to-lead pattern.
                  Only shown when there's at least one selectable chip and
                  no current lead. */}
              {(tickedExistingPersonIds.size > 0 || pendingContacts.filter(c => c.target === 'client').length > 0) && leadContactKey && (
                <p className="text-xs text-gray-400 italic mt-1">★ marks the lead contact. Click another chip to promote it.</p>
              )}
            </div>
          )}

          {/* Linked organisations — generalises the old single "Band / Act"
              picker. A job can carry N linked orgs (band, management,
              promoter, label, venue operator, supplier). The first linked
              org with role='band' is used for band trading history, so the
              old sidebar behaviour is preserved. New orgs typed here are
              created on submit. */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="block text-sm font-medium text-gray-700">
                Linked organisations <span className="text-gray-400 font-normal">(band, promoter, label, etc — optional)</span>
              </label>
              {!showAddLinkedOrg && (
                <button
                  type="button"
                  onClick={() => setShowAddLinkedOrg(true)}
                  className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium"
                >
                  + Add organisation
                </button>
              )}
            </div>

            {/* Already-linked orgs */}
            {linkedOrgs.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {linkedOrgs.map(lo => {
                  const roleLabel = LINKED_ORG_ROLES.find(r => r.value === lo.role)?.label || lo.role;
                  return (
                    <span key={lo._tempId} className="inline-flex items-center gap-1 px-2 py-1 bg-purple-50 border border-purple-200 rounded text-xs text-purple-800">
                      <span className="font-medium">{lo.orgName}</span>
                      <span className="text-purple-400">({roleLabel}{lo.isNew ? ' — new' : ''})</span>
                      <button
                        type="button"
                        onClick={() => {
                          setLinkedOrgs(prev => prev.filter(x => x._tempId !== lo._tempId));
                          // If we removed the band link, refresh client history without band context
                          if (lo.role === 'band' && clientName) {
                            const remainingBand = linkedOrgs.find(x => x._tempId !== lo._tempId && x.role === 'band' && x.orgId);
                            fetchClientHistory(clientId, clientName, remainingBand?.orgId ?? null);
                          }
                        }}
                        className="text-purple-400 hover:text-purple-600 leading-none ml-0.5"
                        title="Remove"
                      >
                        &times;
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {/* Inline add-organisation form */}
            {showAddLinkedOrg && (
              <div className="mt-2 p-3 bg-purple-50 border border-purple-200 rounded-lg space-y-2">
                {linkedOrgPickedId || (linkedOrgPickedName && !linkedOrgPickedId) ? (
                  <div className="flex items-center gap-2 bg-white border border-purple-200 rounded px-2 py-1.5">
                    <span className="text-sm font-medium text-purple-800 flex-1 truncate">{linkedOrgPickedName}</span>
                    {!linkedOrgPickedId && <span className="text-xs text-purple-400">(new)</span>}
                    <button
                      type="button"
                      onClick={() => { setLinkedOrgPickedId(null); setLinkedOrgPickedName(''); setLinkedOrgSearch(''); }}
                      className="text-xs text-purple-400 hover:text-purple-600"
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <input
                      type="text"
                      value={linkedOrgSearch}
                      onChange={e => setLinkedOrgSearch(e.target.value)}
                      placeholder="Search for organisation, or type a new name…"
                      className="w-full border border-purple-200 rounded px-2 py-1.5 text-sm focus:border-purple-400 focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white"
                    />
                    {linkedOrgResults.length > 0 && (
                      <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 max-h-48 overflow-y-auto">
                        {linkedOrgResults.map(o => (
                          <button
                            key={o.id}
                            type="button"
                            onClick={() => {
                              setLinkedOrgPickedId(o.id);
                              setLinkedOrgPickedName(o.name);
                              setLinkedOrgResults([]);
                              setLinkedOrgSearch('');
                              setError('');
                            }}
                            className="w-full text-left px-3 py-2 hover:bg-gray-50 text-sm border-b border-gray-50 last:border-b-0"
                          >
                            <span className="font-medium">{o.name}</span>
                            <span className="text-xs text-gray-400 ml-2">{o.type}</span>
                          </button>
                        ))}
                      </div>
                    )}
                    {linkedOrgSearch.trim().length >= 2 && linkedOrgResults.length === 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setLinkedOrgPickedName(linkedOrgSearch.trim());
                          setLinkedOrgPickedId(null);
                          setLinkedOrgSearch('');
                          setError('');
                        }}
                        className="mt-1 text-xs text-purple-600 hover:text-purple-700 font-medium"
                      >
                        + Create "{linkedOrgSearch.trim()}" as a new organisation
                      </button>
                    )}
                  </div>
                )}
                <select
                  value={linkedOrgRole}
                  onChange={e => setLinkedOrgRole(e.target.value)}
                  className="w-full border border-purple-200 rounded px-2 py-1.5 text-sm focus:border-purple-400 focus:outline-none focus:ring-1 focus:ring-purple-400 bg-white"
                >
                  {LINKED_ORG_ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddLinkedOrg(false);
                      setLinkedOrgPickedId(null); setLinkedOrgPickedName('');
                      setLinkedOrgSearch(''); setLinkedOrgRole('band');
                      setLinkedOrgResults([]);
                      setError('');
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      const name = linkedOrgPickedName.trim();
                      if (!name) { setError('Pick or type an organisation name'); return; }
                      // Block duplicate role-pair (same org + same role)
                      if (linkedOrgs.some(lo => lo.orgId && lo.orgId === linkedOrgPickedId && lo.role === linkedOrgRole)) {
                        setError(`${name} is already linked as ${LINKED_ORG_ROLES.find(r => r.value === linkedOrgRole)?.label || linkedOrgRole}`);
                        return;
                      }
                      setError('');
                      const newLink = {
                        _tempId: `lo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                        orgId: linkedOrgPickedId,
                        orgName: name,
                        role: linkedOrgRole,
                        isNew: !linkedOrgPickedId,
                      };
                      setLinkedOrgs(prev => [...prev, newLink]);

                      // Refresh band history if this is a band and we have a client
                      if (linkedOrgRole === 'band' && linkedOrgPickedId && clientName) {
                        fetchClientHistory(clientId, clientName, linkedOrgPickedId);
                      }
                      // Auto-suggest client from band's org graph when client is empty
                      if (linkedOrgRole === 'band' && linkedOrgPickedId && !clientName && !clientId) {
                        try {
                          const suggestions = await api.get<{ data: Array<{ org_id: string; org_name: string; suggested_role: string; relationship_type: string }> }>(`/organisations/${linkedOrgPickedId}/suggestions`);
                          const clientSuggestion = suggestions.data.find(s => s.suggested_role === 'client' || s.suggested_role === 'management');
                          if (clientSuggestion) {
                            setClientName(clientSuggestion.org_name);
                            setClientId(clientSuggestion.org_id);
                          }
                        } catch { /* suggestions are nice-to-have */ }
                      }

                      setShowAddLinkedOrg(false);
                      setLinkedOrgPickedId(null); setLinkedOrgPickedName('');
                      setLinkedOrgSearch(''); setLinkedOrgRole('band');
                      setLinkedOrgResults([]);
                    }}
                    className="text-xs bg-purple-600 text-white px-3 py-1 rounded hover:bg-purple-700"
                  >
                    Save organisation
                  </button>
                </div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">What do they want / what is it? {serviceTypes.length === 0 && '*'}</label>
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
                {/* +1 quick-action — most jobs return the day AFTER Job
                    Finish, so this skips the two-click "unlink then pick
                    tomorrow" dance. Unlinks the chain itself, since
                    returning a day later is by definition a deviation
                    from "same as job end". Disabled when there's no
                    Job Finish to add a day to. */}
                <button
                  type="button"
                  onClick={() => {
                    if (!jobEnd) return;
                    setReturnLinked(false);
                    setReturnDate(addDays(jobEnd, 1));
                  }}
                  disabled={!jobEnd}
                  className={`text-xs px-2 py-1 rounded font-medium ${
                    jobEnd
                      ? 'text-ooosh-600 bg-white border border-ooosh-200 hover:bg-ooosh-50'
                      : 'text-gray-300 bg-gray-50 border border-gray-200 cursor-not-allowed'
                  }`}
                  title={jobEnd ? 'Set Returning to Job Finish + 1 day' : 'Set a Job Finish date first'}
                >
                  +1
                </button>
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
            <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">{clientHistory!.band_history ? 'Client Jobs' : 'Recent Jobs'}</h5>
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

            {/* Band History Section */}
            {clientHistory!.band_history && parseInt(clientHistory!.band_history.stats.total_jobs) > 0 && (
              <>
                <div className="border-t border-purple-200 my-4" />
                <h4 className="text-sm font-semibold text-purple-700 mb-3">
                  Band History — {clientHistory!.band_history.band_info?.name || bandName}
                </h4>

                {clientHistory!.band_history.band_info?.do_not_hire && (
                  <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center gap-2 mb-1">
                      <svg className="w-4 h-4 text-red-600 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                      <span className="text-sm font-bold text-red-700">DO NOT HIRE</span>
                    </div>
                    {clientHistory!.band_history.band_info.do_not_hire_reason && (
                      <p className="text-xs text-red-600 mt-1">{clientHistory!.band_history.band_info.do_not_hire_reason}</p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 mb-4">
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-gray-900">{clientHistory!.band_history.stats.total_jobs}</div>
                    <div className="text-xs text-gray-500">Total Jobs</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-green-600">{clientHistory!.band_history.stats.confirmed_jobs}</div>
                    <div className="text-xs text-gray-500">Confirmed</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-gray-900">
                      {formatCurrency(parseFloat(clientHistory!.band_history.stats.total_confirmed_value))}
                    </div>
                    <div className="text-xs text-gray-500">Confirmed Value</div>
                  </div>
                  <div className="bg-purple-50 rounded-lg p-2 text-center border border-purple-200">
                    <div className="text-lg font-bold text-red-500">{clientHistory!.band_history.stats.lost_jobs}</div>
                    <div className="text-xs text-gray-500">Lost</div>
                  </div>
                </div>

                <h5 className="text-xs font-semibold text-purple-500 uppercase mb-2">Band Jobs</h5>
                <div className="space-y-2">
                  {clientHistory!.band_history.jobs.map((j) => {
                    const pStatus = j.pipeline_status;
                    const pConfig = pStatus
                      ? PIPELINE_STATUS_CONFIG[pStatus as PipelineStatus]
                      : null;
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
                      <div key={j.id} className="bg-white rounded-lg p-2.5 border border-purple-200 text-xs">
                        <div className="flex items-center justify-between mb-1">
                          {j.hh_job_number ? (
                            <a
                              href={`https://myhirehop.com/job.php?id=${j.hh_job_number}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-purple-600 hover:text-purple-700 hover:underline"
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
              </>
            )}
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
  const [searchParams, setSearchParams] = useSearchParams();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [reqProgress, setReqProgress] = useState<Record<string, ReqProgress>>({});
  // Persisted view/sort/filter prefs (from localStorage)
  const initialPrefs = loadPipelinePrefs();
  const [view, setView] = useState<'kanban' | 'list'>(initialPrefs.view);

  // Sort
  const [sortMode, setSortMode] = useState<SortMode>(initialPrefs.sortMode);

  // Filters — chase filter can be deep-linked via ?chase= so dashboard cards
  // can drop the user straight onto the right view.
  const [filterLikelihood, setFilterLikelihood] = useState<string>(initialPrefs.filterLikelihood);
  const VALID_CHASE_FILTERS = ['', 'overdue', 'due_today', 'due_this_week'];
  const chaseParam = searchParams.get('chase');
  const initialChase = VALID_CHASE_FILTERS.includes(chaseParam || '')
    ? (chaseParam as string)
    : initialPrefs.filterChase;
  const [filterChase, setFilterChase] = useState<string>(initialChase);
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [filterStatuses, setFilterStatuses] = useState<StatusPill[]>(initialPrefs.filterStatuses);
  const [filterManager, setFilterManager] = useState<string>(initialPrefs.filterManager);
  const [filterDateFrom, setFilterDateFrom] = useState<string>(initialPrefs.filterDateFrom);
  const [filterDateTo, setFilterDateTo] = useState<string>(initialPrefs.filterDateTo);
  // Migrate legacy boolean prefs (pre-3-state pill) to the new union type.
  const initialHHJob: HHJobFilter = (() => {
    const v = initialPrefs.filterHasHHJob as unknown;
    if (v === true) return 'yes';
    if (v === false) return 'all';     // legacy "off" meant unfiltered
    if (v === 'yes' || v === 'no' || v === 'all') return v;
    return 'all';
  })();
  const [filterHasHHJob, setFilterHasHHJob] = useState<HHJobFilter>(initialHHJob);
  const [filterServiceTypes, setFilterServiceTypes] = useState<ServiceTypePill[]>(initialPrefs.filterServiceTypes);
  const [filterValueBucket, setFilterValueBucket] = useState<ValueBucket>(initialPrefs.filterValueBucket);
  const [filterChaseCount, setFilterChaseCount] = useState<ChaseCountBucket>(initialPrefs.filterChaseCount);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  // Manager dropdown options — fetched once
  const [managerOptions, setManagerOptions] = useState<{ id: string; first_name: string; last_name: string }[]>([]);
  useEffect(() => {
    api.get<{ data: { id: string; first_name: string; last_name: string }[] }>('/pipeline/managers')
      .then(res => setManagerOptions(res.data))
      .catch(() => { /* non-critical, dropdown just stays empty */ });
  }, []);

  // Persist preferences whenever they change
  useEffect(() => {
    try {
      const prefs: PipelinePrefs = {
        view, sortMode, filterLikelihood, filterChase,
        filterStatuses, filterManager, filterDateFrom, filterDateTo,
        filterHasHHJob, filterServiceTypes, filterValueBucket, filterChaseCount,
      };
      window.localStorage.setItem(PIPELINE_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore quota / private mode errors
    }
  }, [view, sortMode, filterLikelihood, filterChase, filterStatuses, filterManager, filterDateFrom, filterDateTo, filterHasHHJob, filterServiceTypes, filterValueBucket, filterChaseCount]);

  // Toggle handlers for multi-select pills
  const toggleStatusPill = (pill: StatusPill) => {
    setFilterStatuses(prev => prev.includes(pill) ? prev.filter(p => p !== pill) : [...prev, pill]);
  };
  const toggleServiceTypePill = (pill: ServiceTypePill) => {
    setFilterServiceTypes(prev => prev.includes(pill) ? prev.filter(p => p !== pill) : [...prev, pill]);
  };

  // True if any filter beyond the defaults is active — used to show a "Clear all"
  // button + indicate to the user that results are filtered.
  const hasActiveFilters = filterLikelihood !== '' || filterChase !== '' || filterStatuses.length > 0
    || filterManager !== '' || filterDateFrom !== '' || filterDateTo !== ''
    || filterServiceTypes.length > 0 || filterValueBucket !== '' || filterChaseCount !== ''
    || filterHasHHJob !== 'all';

  const clearAllFilters = () => {
    setFilterLikelihood('');
    setFilterChase('');
    setFilterStatuses([]);
    setFilterManager('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setFilterHasHHJob('all');
    setFilterServiceTypes([]);
    setFilterValueBucket('');
    setFilterChaseCount('');
    setFilterSearch('');
  };

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
      if (filterManager) params.set('manager', filterManager);
      if (filterDateFrom) params.set('date_from', filterDateFrom);
      if (filterDateTo) params.set('date_to', filterDateTo);

      // 3-state HH job filter: 'all' = no param (backend returns everything);
      // 'yes' = only HireHop-linked; 'no' = only OP-native (no HH number).
      if (filterHasHHJob === 'yes') params.set('has_hh_job', 'true');
      else if (filterHasHHJob === 'no') params.set('has_hh_job', 'false');

      // Status pills control which pre-confirmed pipeline_status values to
      // include. No pills selected = all four (new_enquiry/quoting/paused/
      // provisional). Note: 'chasing' is no longer a stored status — cards
      // land in the Chasing column via server-derived is_chasing.
      const dbStatuses: string[] = [];
      if (filterStatuses.length === 0) {
        dbStatuses.push('new_enquiry', 'quoting', 'paused', 'provisional');
      } else {
        for (const pill of filterStatuses) {
          dbStatuses.push(...PILL_TO_DB_STATUSES[pill]);
        }
      }
      params.set('status', dbStatuses.join(','));

      // Service type pills (multi-select)
      if (filterServiceTypes.length > 0) {
        params.set('service_type', filterServiceTypes.join(','));
      }

      // Value bucket
      const valueB = VALUE_BUCKETS[filterValueBucket];
      if (valueB.min != null) params.set('value_min', String(valueB.min));
      if (valueB.max != null) params.set('value_max', String(valueB.max));

      // Chase count bucket
      const chaseB = CHASE_COUNT_BUCKETS[filterChaseCount];
      if (chaseB.min != null) params.set('chase_count_min', String(chaseB.min));
      if (chaseB.max != null) params.set('chase_count_max', String(chaseB.max));

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
  }, [filterLikelihood, filterChase, filterSearch, filterStatuses, filterManager, filterDateFrom, filterDateTo, filterHasHHJob, filterServiceTypes, filterValueBucket, filterChaseCount]);

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
    if (!job) return;

    // Dropping INTO Chasing isn't a status change — it's a chase-date set.
    // Pull the chase date forward to today; the underlying pipeline_status is
    // preserved, and the card surfaces in the Chasing column on next fetch
    // via the server-derived is_chasing flag.
    if (targetStatus === 'chasing') {
      if (job.is_chasing) return;  // already there, nothing to do
      try {
        const today = new Date().toISOString().split('T')[0];
        await api.patch(`/pipeline/${job.id}`, { next_chase_date: today });
        fetchPipeline();
      } catch (err) {
        console.error('Chase date update failed:', err);
      }
      return;
    }

    // Dropping OUT of Chasing into a real status column: the underlying
    // status may already match (the card was just visiting Chasing because
    // of an overdue chase date). In that case, push the chase date forward
    // by chase_interval_days so the card lands in the target column visibly.
    if (job.is_chasing && job.pipeline_status === targetStatus) {
      try {
        const interval = job.chase_interval_days || 5;
        const future = new Date();
        future.setDate(future.getDate() + interval);
        await api.patch(`/pipeline/${job.id}`, {
          next_chase_date: future.toISOString().split('T')[0],
        });
        fetchPipeline();
      } catch (err) {
        console.error('Chase date update failed:', err);
      }
      return;
    }

    if (job.pipeline_status === targetStatus) return;

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

  const handleTransitionConfirm = async (data: Record<string, unknown>) => {
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
  //
  // 'Chasing' is a virtual column. A job appears in it when is_chasing is
  // true (server-derived: next_chase_date <= today AND pre-confirmed status).
  // The card's underlying pipeline_status stays untouched — when the chase
  // is logged with a future date, the card silently drops back into its
  // real status column on the next fetch.

  const jobsByStatus: Record<PipelineStatus, Job[]> = {
    new_enquiry: [], quoting: [], chasing: [], paused: [],
    provisional: [], confirmed: [], lost: [], cancelled: [],
  };
  for (const job of jobs) {
    // Chasing wins over real status when due. Otherwise merge quoting into
    // new_enquiry (now "Enquiries").
    let bucket: PipelineStatus;
    if (job.is_chasing) {
      bucket = 'chasing';
    } else {
      bucket = job.pipeline_status === 'quoting' ? 'new_enquiry' : (job.pipeline_status || 'new_enquiry');
    }
    if (jobsByStatus[bucket]) {
      jobsByStatus[bucket].push(job);
    }
  }

  // Sort each column
  for (const status of COLUMN_ORDER) {
    jobsByStatus[status] = sortJobs(jobsByStatus[status], sortMode);
  }

  // ── Visible columns ───────────────────────────────────────────────────
  //
  // Pipeline only ever shows enquiry-stage columns. Status pills narrow the
  // visible set: with 'paused' selected and others off, only Paused +
  // Chasing render (Chasing always shows because overdue-chase visiting
  // cards may originate from any selected status). With no pills selected,
  // all four columns render.

  const visibleColumns = COLUMN_ORDER.filter(status => {
    if (filterStatuses.length === 0) return true;
    if (status === 'chasing') return true;  // virtual column always visible when any column is
    // Find which pill (if any) controls this column
    for (const pill of filterStatuses) {
      if (PILL_TO_COLUMNS[pill].includes(status)) return true;
    }
    return false;
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
            {/* View toggle — desktop only. Mobile always shows list view. */}
            <div className="hidden md:flex border border-gray-300 rounded-lg overflow-hidden">
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

        {/* Filters — primary row (always visible) */}
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

          {/* Status pills — multi-select. None selected = show everything. */}
          <div className="inline-flex items-center gap-1 ml-1">
            {(['enquiry', 'paused', 'provisional'] as StatusPill[]).map(pill => {
              const active = filterStatuses.includes(pill);
              const label = pill === 'enquiry' ? 'Enquiry' : pill === 'paused' ? 'Paused' : 'Provisional';
              return (
                <button
                  key={pill}
                  type="button"
                  onClick={() => toggleStatusPill(pill)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    active
                      ? 'bg-ooosh-600 text-white border-ooosh-600'
                      : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

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

          <button
            type="button"
            onClick={() => setShowAdvancedFilters(s => !s)}
            className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors ${
              showAdvancedFilters || hasActiveFilters
                ? 'bg-gray-100 text-gray-900 border-gray-400'
                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
            }`}
            title="More filters"
          >
            {showAdvancedFilters ? '− Filters' : '+ Filters'}
            {hasActiveFilters && !showAdvancedFilters && (
              <span className="ml-1 inline-flex items-center justify-center w-1.5 h-1.5 rounded-full bg-ooosh-600" />
            )}
          </button>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Clear all
            </button>
          )}
        </div>

        {/* Filters — advanced row (collapsible) */}
        {showAdvancedFilters && (
          <div className="flex items-center gap-3 flex-wrap mt-3 pt-3 border-t border-gray-100">
            {/* Manager */}
            <select
              value={filterManager}
              onChange={(e) => setFilterManager(e.target.value)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              <option value="">All managers</option>
              {managerOptions.map(m => (
                <option key={m.id} value={m.id}>
                  {m.first_name} {m.last_name}
                </option>
              ))}
            </select>

            {/* Date range */}
            <div className="flex items-center gap-1 text-xs text-gray-600">
              <span className="text-gray-500">Job dates:</span>
              <input
                type="date"
                value={filterDateFrom}
                onChange={(e) => setFilterDateFrom(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
              <span className="text-gray-400">→</span>
              <input
                type="date"
                value={filterDateTo}
                onChange={(e) => setFilterDateTo(e.target.value)}
                className="border border-gray-300 rounded px-2 py-1 text-xs focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>

            {/* HireHop link — 3-state pill: All / In HireHop / OP-only */}
            <div className="inline-flex items-center gap-1" title="Filter by whether the enquiry is linked to a HireHop job number.">
              <span className="text-xs text-gray-500 mr-1">HH:</span>
              {([
                { key: 'all', label: 'All' },
                { key: 'yes', label: 'In HireHop' },
                { key: 'no', label: 'OP-only' },
              ] as { key: HHJobFilter; label: string }[]).map(opt => {
                const active = filterHasHHJob === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setFilterHasHHJob(opt.key)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                      active
                        ? 'bg-ooosh-600 text-white border-ooosh-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {/* Service type pills */}
            <div className="inline-flex items-center gap-1">
              <span className="text-xs text-gray-500 mr-1">Type:</span>
              {(['vehicle', 'backline', 'rehearsal'] as ServiceTypePill[]).map(pill => {
                const active = filterServiceTypes.includes(pill);
                return (
                  <button
                    key={pill}
                    type="button"
                    onClick={() => toggleServiceTypePill(pill)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                      active
                        ? 'bg-ooosh-600 text-white border-ooosh-600'
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {SERVICE_TYPE_LABELS[pill]}
                  </button>
                );
              })}
            </div>

            {/* Value bucket */}
            <select
              value={filterValueBucket}
              onChange={(e) => setFilterValueBucket(e.target.value as ValueBucket)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              {(Object.keys(VALUE_BUCKETS) as ValueBucket[]).map(k => (
                <option key={k || 'all'} value={k}>{VALUE_BUCKETS[k].label}</option>
              ))}
            </select>

            {/* Chase count bucket */}
            <select
              value={filterChaseCount}
              onChange={(e) => setFilterChaseCount(e.target.value as ChaseCountBucket)}
              className="border border-gray-300 rounded px-3 py-1.5 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            >
              {(Object.keys(CHASE_COUNT_BUCKETS) as ChaseCountBucket[]).map(k => (
                <option key={k || 'all'} value={k}>{CHASE_COUNT_BUCKETS[k].label}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Board — Kanban only on desktop. Mobile always falls through to the
          list view below, which groups by urgency (Action Required / Waiting
          / Paused / Provisional / Other) and is far more usable on a phone
          than horizontally scrolling through narrow columns. */}
      {view === 'kanban' && (
        <div className="hidden md:block flex-1 overflow-x-auto p-4">
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
      )}
      {(view === 'list' || view === 'kanban') && (
        /* List view — grouped by urgency. Always shown when view='list',
            also shown as mobile fallback when view='kanban' (hidden on md+). */
        <div className={`flex-1 overflow-y-auto p-4 space-y-4 ${view === 'kanban' ? 'md:hidden' : ''}`}>
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
              const chase = job.pipeline_status === 'lost' ? { text: '', urgency: 'none' as const } : chaseDueLabel(job.next_chase_date);
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
        onClose={() => {
          setShowNewEnquiry(false);
          if (searchParams.get('newEnquiry')) {
            const next = new URLSearchParams(searchParams);
            next.delete('newEnquiry');
            setSearchParams(next, { replace: true });
          }
        }}
        onCreated={(jobId) => {
          fetchPipeline();
          if (jobId) navigate(`/jobs/${jobId}`);
        }}
      />
      <TransitionModal
        isOpen={!!transitionModal}
        targetStatus={transitionModal?.targetStatus || null}
        jobId={transitionModal?.jobId}
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
