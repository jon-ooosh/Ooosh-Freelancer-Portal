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
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

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
  }, [search, statusFilter, categoryFilter, severityFilter, page]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (statusFilter !== 'open') next.set('status', statusFilter);
    if (search.trim()) next.set('search', search.trim());
    if (categoryFilter) next.set('category', categoryFilter);
    if (severityFilter) next.set('severity', severityFilter);
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [statusFilter, search, categoryFilter, severityFilter, page, setSearchParams]);

  useEffect(() => { setPage(1); }, [statusFilter, categoryFilter, severityFilter, search]);

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
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-gray-900">Problems</h1>
        <p className="text-sm text-gray-500 mt-1">
          Cross-module register · {total} {statusFilter === 'open' ? 'open' : statusFilter === 'all' ? 'total' : statusFilter}
        </p>
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
    </div>
  );
}
