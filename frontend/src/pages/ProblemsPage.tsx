/**
 * Operations > Problems — global view of open job-level issues.
 *
 * Cross-module register for things that need a human to chase: vehicle
 * damage, missing items, breakdowns, client disputes. Per-job issues
 * surface here, on Job Detail, and as a NeedsAttention bucket on the
 * dashboard. Backend at /api/problems (NOT /api/issues — that's the
 * platform bug tracker).
 */
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

type ProblemStatus = 'not_started' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
type ProblemCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'other';
type ProblemSeverity = 'normal' | 'urgent';

interface Problem {
  id: string;
  job_id: string;
  status: ProblemStatus;
  issue_category: ProblemCategory;
  severity: ProblemSeverity;
  summary: string;
  notes: string | null;
  source_module: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  hh_job_number?: number;
  job_name?: string | null;
  client_name?: string | null;
  company_name?: string | null;
  pipeline_status?: string | null;
}

const STATUS_LABELS: Record<ProblemStatus, string> = {
  not_started: 'Open',
  in_progress: 'Working on it',
  done: 'Resolved',
  blocked: 'Awaiting / Blocked',
  cancelled: 'Cancelled',
};
const STATUS_COLOURS: Record<ProblemStatus, string> = {
  not_started: 'bg-red-100 text-red-700',
  in_progress: 'bg-amber-100 text-amber-700',
  done: 'bg-green-100 text-green-700',
  blocked: 'bg-orange-100 text-orange-700',
  cancelled: 'bg-gray-100 text-gray-500',
};
const CATEGORY_LABELS: Record<ProblemCategory, string> = {
  damaged: 'Damaged',
  missing: 'Missing',
  broken: 'Broken',
  dispute: 'Dispute',
  other: 'Other',
};
const CATEGORY_ICONS: Record<ProblemCategory, string> = {
  damaged: '🔨', missing: '❓', broken: '⚙️', dispute: '⚖️', other: '⚠️',
};

function daysAgo(s: string): number {
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
}

export default function ProblemsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'open');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [severityFilter, setSeverityFilter] = useState(searchParams.get('severity') || '');
  const [sourceFilter, setSourceFilter] = useState(searchParams.get('source') || '');
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [showLogModal, setShowLogModal] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('status', statusFilter);
      params.set('page', String(page));
      params.set('limit', '50');
      if (search.trim()) params.set('search', search.trim());
      if (categoryFilter) params.set('category', categoryFilter);
      if (severityFilter) params.set('severity', severityFilter);
      if (sourceFilter) params.set('source', sourceFilter);
      const res = await api.get<{ data: Problem[]; pagination: { totalPages: number; total: number } }>(
        `/problems?${params.toString()}`
      );
      setItems(res.data);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
    } catch (err) {
      console.error('Failed to load problems:', err);
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter, categoryFilter, severityFilter, sourceFilter, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (statusFilter !== 'open') next.set('status', statusFilter);
    if (search.trim()) next.set('search', search.trim());
    if (categoryFilter) next.set('category', categoryFilter);
    if (severityFilter) next.set('severity', severityFilter);
    if (sourceFilter) next.set('source', sourceFilter);
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [statusFilter, search, categoryFilter, severityFilter, sourceFilter, page, setSearchParams]);

  useEffect(() => { setPage(1); }, [statusFilter, categoryFilter, severityFilter, sourceFilter, search]);

  async function changeStatus(id: string, newStatus: ProblemStatus) {
    try {
      await api.patch(`/problems/${id}`, { status: newStatus });
      setItems(prev => prev.map(p => p.id === id ? { ...p, status: newStatus } : p));
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Problems</h1>
          <p className="text-sm text-gray-500 mt-1">
            Cross-module register · {total} {statusFilter === 'open' ? 'open' : statusFilter === 'all' ? 'total' : statusFilter}
          </p>
        </div>
        <button
          onClick={() => setShowLogModal(true)}
          className="px-3 py-1.5 text-sm font-medium bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 transition-colors"
        >
          + Log Problem
        </button>
      </div>

      {/* Filters */}
      <div className="space-y-3 mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search summary, notes, job name, client…"
            className="flex-1 max-w-md border border-gray-300 rounded-lg px-4 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="rounded border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="all">All</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-gray-500">Category:</span>
          {(['', 'damaged', 'missing', 'broken', 'dispute', 'other'] as const).map(k => (
            <button
              key={k || 'all'}
              onClick={() => setCategoryFilter(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                categoryFilter === k ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k ? CATEGORY_LABELS[k as ProblemCategory] : 'All'}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-2">Severity:</span>
          {(['', 'normal', 'urgent'] as const).map(k => (
            <button
              key={k || 'all-sev'}
              onClick={() => setSeverityFilter(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                severityFilter === k
                  ? (k === 'urgent' ? 'bg-red-600 text-white border-red-600' : 'bg-ooosh-600 text-white border-ooosh-600')
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k ? (k === 'urgent' ? '⚠ Urgent' : 'Normal') : 'All'}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-2">Source:</span>
          {(['', 'manual', 'vehicle', 'backline', 'transport'] as const).map(k => (
            <button
              key={k || 'all-src'}
              onClick={() => setSourceFilter(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                sourceFilter === k ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k === '' ? 'All' : k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : items.length === 0 ? (
        <div className="text-center py-12 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No problems match these filters. {statusFilter === 'open' && '🎉'}
        </div>
      ) : (
        <div className="space-y-3">
          {items.map(p => {
            const ageDays = daysAgo(p.created_at);
            const isUrgent = p.severity === 'urgent';
            return (
              <div
                key={p.id}
                className={`bg-white rounded-lg border p-4 transition-all ${
                  isUrgent ? 'border-red-300 bg-red-50/30' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-shrink-0 text-xl">{CATEGORY_ICONS[p.issue_category]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase">
                        {CATEGORY_LABELS[p.issue_category]}
                      </span>
                      {isUrgent && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">
                          ⚠ Urgent
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        {ageDays === 0 ? 'today' : `${ageDays}d open`}
                      </span>
                    </div>
                    <h3 className="font-medium text-gray-900">{p.summary}</h3>
                    {p.notes && (
                      <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap">{p.notes}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 flex-wrap">
                      <Link
                        to={`/jobs/${p.job_id}`}
                        className="text-ooosh-600 hover:text-ooosh-700 hover:underline"
                      >
                        {p.hh_job_number ? `J-${p.hh_job_number}` : 'Job'}
                      </Link>
                      {p.job_name && <span>· {p.job_name}</span>}
                      {(p.client_name || p.company_name) && <span>· {p.client_name || p.company_name}</span>}
                      {p.source_module && p.source_module !== 'manual' && (
                        <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-600">{p.source_module}</span>
                      )}
                    </div>
                  </div>
                  {p.status !== 'done' && p.status !== 'cancelled' && (
                    <select
                      value={p.status}
                      onChange={e => changeStatus(p.id, e.target.value as ProblemStatus)}
                      onClick={e => e.stopPropagation()}
                      className="text-xs border border-gray-300 rounded px-2 py-1 flex-shrink-0"
                    >
                      <option value="not_started">Open</option>
                      <option value="in_progress">Working on it</option>
                      <option value="blocked">Awaiting / Blocked</option>
                      <option value="done">Resolved</option>
                      <option value="cancelled">Cancel</option>
                    </select>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-sm text-gray-500">Page {page} of {totalPages} · {total} total</p>
          <div className="flex gap-2">
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Next</button>
          </div>
        </div>
      )}

      {showLogModal && (
        <LogProblemModal
          onClose={() => setShowLogModal(false)}
          onCreated={() => { setShowLogModal(false); load(); }}
        />
      )}
    </div>
  );
}

// ── Log Problem modal — pick a job, then log ────────────────────────────

interface JobOption {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  client_name: string | null;
  company_name: string | null;
}

function LogProblemModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [jobSearch, setJobSearch] = useState('');
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [selectedJob, setSelectedJob] = useState<JobOption | null>(null);
  const [searching, setSearching] = useState(false);
  const [category, setCategory] = useState<ProblemCategory>('damaged');
  const [summary, setSummary] = useState('');
  const [notes, setNotes] = useState('');
  const [severity, setSeverity] = useState<ProblemSeverity>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Debounced job search — server-side via the existing /hirehop/jobs endpoint.
  useEffect(() => {
    if (selectedJob) return;
    if (!jobSearch.trim() || jobSearch.trim().length < 2) {
      setJobs([]); return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ search: jobSearch.trim(), limit: '15' });
      api.get<{ data: JobOption[] }>(`/hirehop/jobs?${params}`)
        .then(res => setJobs(res.data))
        .catch(() => setJobs([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [jobSearch, selectedJob]);

  async function submit() {
    if (!selectedJob || !summary.trim()) {
      setError('Pick a job and add a summary');
      return;
    }
    setSubmitting(true); setError('');
    try {
      await api.post('/problems', {
        job_id: selectedJob.id,
        category,
        summary: summary.trim(),
        notes: notes.trim() || null,
        severity,
        source_module: 'manual',
      });
      onCreated();
    } catch (err) {
      console.error('Failed to log problem:', err);
      setError('Failed to log problem');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-900">Log Problem</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <div className="p-5 space-y-4">
          {/* Job picker */}
          {selectedJob ? (
            <div className="flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
              <div>
                <div className="font-mono text-xs text-blue-600">J-{selectedJob.hh_job_number}</div>
                <div className="text-sm text-gray-900">{selectedJob.job_name || 'Untitled'}</div>
                <div className="text-xs text-gray-500">{selectedJob.client_name || selectedJob.company_name}</div>
              </div>
              <button
                onClick={() => { setSelectedJob(null); setJobSearch(''); }}
                className="text-xs text-gray-500 hover:text-gray-700 underline"
              >
                Change
              </button>
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Job</label>
              <input
                type="text"
                value={jobSearch}
                onChange={e => setJobSearch(e.target.value)}
                placeholder="Type 2+ chars — job name, client, or number…"
                className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
                autoFocus
              />
              {searching && <div className="text-xs text-gray-400 mt-1">Searching…</div>}
              {jobs.length > 0 && (
                <div className="mt-1 border border-gray-200 rounded max-h-48 overflow-y-auto">
                  {jobs.map(j => (
                    <button
                      key={j.id}
                      onClick={() => setSelectedJob(j)}
                      className="w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 border-b border-gray-100 last:border-0"
                    >
                      <span className="font-mono text-xs text-gray-500">J-{j.hh_job_number}</span>{' '}
                      {j.job_name || 'Untitled'}
                      <span className="text-xs text-gray-400"> · {j.client_name || j.company_name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Category */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
            <div className="flex flex-wrap gap-2">
              {(['damaged', 'missing', 'broken', 'dispute', 'other'] as ProblemCategory[]).map(c => (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    category === c ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300'
                  }`}
                >
                  {CATEGORY_ICONS[c]} {CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Summary */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Summary</label>
            <input
              type="text"
              value={summary}
              onChange={e => setSummary(e.target.value)}
              placeholder="Short summary (e.g. Scratched bumper RX22SXL)"
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
            />
          </div>

          {/* Notes */}
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">Detail</label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional — quote refs, who's chasing, any notes"
              rows={3}
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm"
            />
          </div>

          {/* Severity */}
          <label className="text-xs text-gray-600 flex items-center gap-2">
            <input
              type="checkbox"
              checked={severity === 'urgent'}
              onChange={e => setSeverity(e.target.checked ? 'urgent' : 'normal')}
            />
            ⚠ Mark as urgent
          </label>

          {error && <div className="text-xs text-red-600">{error}</div>}
        </div>
        <div className="px-5 py-3 border-t border-gray-200 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={!selectedJob || !summary.trim() || submitting}
            className="px-3 py-1.5 text-sm bg-ooosh-600 text-white rounded hover:bg-ooosh-700 disabled:opacity-50"
          >
            {submitting ? 'Logging…' : 'Log problem'}
          </button>
        </div>
      </div>
    </div>
  );
}
