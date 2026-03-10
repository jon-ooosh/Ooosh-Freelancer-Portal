import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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

// ── Column order ───────────────────────────────────────────────────────────

const COLUMN_ORDER: PipelineStatus[] = [
  'new_enquiry', 'quoting', 'chasing', 'paused', 'provisional', 'confirmed', 'lost',
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

// ── Pipeline Card ──────────────────────────────────────────────────────────

function PipelineCard({
  job,
  onDragStart,
  onClick,
}: {
  job: Job;
  onDragStart: (e: React.DragEvent, job: Job) => void;
  onClick: (job: Job) => void;
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
        <span className="text-xs font-mono text-gray-500">
          {job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW'}
        </span>
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

      {/* Row 5: Likelihood + chase count */}
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
      </div>

      {/* Row 6: Chase due + manager */}
      <div className="flex items-center justify-between">
        {chase.text ? (
          <span className={`text-xs font-medium ${
            chase.urgency === 'overdue' ? 'text-red-600' :
            chase.urgency === 'today' ? 'text-amber-600' : 'text-gray-400'
          }`}>
            {chase.text}
          </span>
        ) : <span />}
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

// ── New Enquiry Modal ──────────────────────────────────────────────────────

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

  if (!isOpen) return null;

  const handleSave = async () => {
    if (!clientName || !details || !jobDate || !jobEnd) {
      setError('Client, description, and dates are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.post('/pipeline/enquiry', {
        client_name: clientName,
        details,
        job_date: jobDate,
        job_end: jobEnd,
        job_name: jobName || undefined,
        job_value: jobValue ? parseFloat(jobValue) : undefined,
        likelihood,
        enquiry_source: enquirySource || undefined,
        notes: notes || undefined,
      });
      // Reset form
      setClientName(''); setDetails(''); setJobDate(''); setJobEnd('');
      setJobName(''); setJobValue(''); setLikelihood('warm');
      setEnquirySource(''); setNotes(''); setShowOptional(false);
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
          {/* Required fields */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Client *</label>
            <input
              type="text"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Client or company name"
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
            />
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
                onChange={(e) => setJobDate(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">End date *</label>
              <input
                type="date"
                value={jobEnd}
                onChange={(e) => setJobEnd(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
              />
            </div>
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
            {saving ? 'Creating...' : 'Create Enquiry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Pipeline Page ─────────────────────────────────────────────────────

export default function PipelinePage() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'kanban' | 'list'>('kanban');

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

  // Drag state
  const dragJobRef = useRef<Job | null>(null);

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
    // Make the drag image slightly transparent
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

    // Statuses that need a modal prompt
    if (['paused', 'confirmed', 'lost'].includes(targetStatus)) {
      setTransitionModal({ jobId: job.id, targetStatus });
      return;
    }

    // Direct transition for other statuses
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
    navigate(`/jobs/${job.id}`);
  };

  // ── Group jobs by status ───────────────────────────────────────────────

  const jobsByStatus: Record<PipelineStatus, Job[]> = {
    new_enquiry: [], quoting: [], chasing: [], paused: [],
    provisional: [], confirmed: [], lost: [],
  };
  for (const job of jobs) {
    const status = job.pipeline_status || 'new_enquiry';
    if (jobsByStatus[status]) {
      jobsByStatus[status].push(job);
    }
  }

  // Sort each column: overdue first, then by next_chase_date, then by created_at
  for (const status of COLUMN_ORDER) {
    jobsByStatus[status].sort((a, b) => {
      const aDate = a.next_chase_date ? new Date(a.next_chase_date).getTime() : Infinity;
      const bDate = b.next_chase_date ? new Date(b.next_chase_date).getTime() : Infinity;
      if (aDate !== bDate) return aDate - bDate;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
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
                {jobs.map((job) => {
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
                        <div className="text-xs text-gray-400 font-mono">
                          {job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW'}
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
                        <div className="text-xs">
                          {chase.text && (
                            <span className={`font-medium ${
                              chase.urgency === 'overdue' ? 'text-red-600' :
                              chase.urgency === 'today' ? 'text-amber-600' : 'text-gray-500'
                            }`}>
                              {chase.text}
                            </span>
                          )}
                          {job.chase_count > 0 && (
                            <span className="text-gray-400 ml-2">x{job.chase_count}</span>
                          )}
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
    </div>
  );
}
