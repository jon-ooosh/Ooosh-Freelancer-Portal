/**
 * Operations > Problems — global view of open job-level issues.
 *
 * Cross-module register for things needing a human chase: vehicle damage,
 * missing items, breakdowns, client disputes. Each row click-throughs to
 * /operations/problems/:id for the full control panel. Backend at
 * /api/problems (NOT /api/issues — that's the platform bug tracker).
 */
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

type IssueStatus = 'open' | 'investigating' | 'awaiting_quote' | 'quoted' | 'actioned' | 'resolved' | 'written_off' | 'cancelled';
type IssueCategory = 'damaged' | 'missing' | 'broken' | 'dispute' | 'breakdown' | 'other';
type IssueSeverity = 'low' | 'normal' | 'urgent';

interface Issue {
  id: string;
  job_id: string;
  status: IssueStatus;
  category: IssueCategory;
  severity: IssueSeverity;
  summary: string;
  description: string | null;
  source_module: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
  hh_job_number: number | null;
  job_name: string | null;
  client_name: string | null;
  vehicle_reg: string | null;
  driver_name: string | null;
  person_name: string | null;
  client_organisation_name: string | null;
  hh_stock_item_name: string | null;
  barcode: string | null;
  assigned_to_name: string | null;
}

const STATUS_LABELS: Record<IssueStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  awaiting_quote: 'Awaiting Quote',
  quoted: 'Quoted',
  actioned: 'Actioned',
  resolved: 'Resolved',
  written_off: 'Written Off',
  cancelled: 'Cancelled',
};
const STATUS_COLOURS: Record<IssueStatus, string> = {
  open: 'bg-red-100 text-red-700',
  investigating: 'bg-amber-100 text-amber-700',
  awaiting_quote: 'bg-orange-100 text-orange-700',
  quoted: 'bg-yellow-100 text-yellow-800',
  actioned: 'bg-blue-100 text-blue-700',
  resolved: 'bg-green-100 text-green-700',
  written_off: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-gray-100 text-gray-500',
};
const CATEGORY_LABELS: Record<IssueCategory, string> = {
  damaged: 'Damaged', missing: 'Missing', broken: 'Broken',
  dispute: 'Dispute', breakdown: 'Breakdown', other: 'Other',
};
const CATEGORY_ICONS: Record<IssueCategory, string> = {
  damaged: '🔨', missing: '❓', broken: '⚙️', dispute: '⚖️', breakdown: '🚨', other: '⚠️',
};

function daysAgo(s: string): number {
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000);
}

export default function ProblemsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState(searchParams.get('status') || 'open');
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') || '');
  const [severityFilter, setSeverityFilter] = useState(searchParams.get('severity') || '');
  const [sourceFilter, setSourceFilter] = useState(searchParams.get('source') || '');
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
      if (sourceFilter) params.set('source', sourceFilter);
      const res = await api.get<{ data: Issue[]; pagination: { totalPages: number; total: number } }>(
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

  return (
    <div>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Problems</h1>
          <p className="text-sm text-gray-500 mt-1">
            Cross-module register · {total} {statusFilter === 'open' ? 'open' : statusFilter === 'all' ? 'total' : statusFilter}
          </p>
        </div>
        <p className="text-xs text-gray-400">
          Log a problem from any Job Detail page → Overview tab.
        </p>
      </div>

      {/* Filters */}
      <div className="space-y-3 mb-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search summary, vehicle reg, barcode, job, client…"
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
          {(['', 'damaged', 'missing', 'broken', 'dispute', 'breakdown', 'other'] as const).map(k => (
            <button
              key={k || 'all-cat'}
              onClick={() => setCategoryFilter(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                categoryFilter === k ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k ? CATEGORY_LABELS[k as IssueCategory] : 'All'}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-2">Severity:</span>
          {(['', 'urgent', 'normal', 'low'] as const).map(k => (
            <button
              key={k || 'all-sev'}
              onClick={() => setSeverityFilter(k)}
              className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                severityFilter === k
                  ? (k === 'urgent' ? 'bg-red-600 text-white border-red-600' : 'bg-ooosh-600 text-white border-ooosh-600')
                  : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {k === 'urgent' ? '⚠ Urgent' : k === 'normal' ? 'Normal' : k === 'low' ? 'Low' : 'All'}
            </button>
          ))}
          <span className="text-xs text-gray-500 ml-2">Source:</span>
          {(['', 'manual', 'vehicle', 'backline', 'transport', 'client', 'driver'] as const).map(k => (
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
            const subjectParts: string[] = [];
            if (p.vehicle_reg) subjectParts.push(`🚐 ${p.vehicle_reg}`);
            if (p.hh_stock_item_name) subjectParts.push(`🎸 ${p.hh_stock_item_name}${p.barcode ? ` (${p.barcode})` : ''}`);
            if (p.driver_name) subjectParts.push(`🧑 ${p.driver_name}`);
            if (p.person_name && !p.driver_name) subjectParts.push(`👤 ${p.person_name}`);
            if (p.client_organisation_name) subjectParts.push(`🏢 ${p.client_organisation_name}`);
            return (
              <Link
                key={p.id}
                to={`/operations/problems/${p.id}`}
                className={`block bg-white rounded-lg border p-4 transition-all hover:shadow-sm ${
                  isUrgent ? 'border-red-300 bg-red-50/30 hover:bg-red-50' : 'border-gray-200 hover:border-ooosh-300'
                }`}
              >
                <div className="flex items-start gap-3 flex-wrap">
                  <div className="flex-shrink-0 text-xl">{CATEGORY_ICONS[p.category]}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[p.status]}`}>
                        {STATUS_LABELS[p.status]}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-700 uppercase">
                        {CATEGORY_LABELS[p.category]}
                      </span>
                      {isUrgent && (
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">
                          ⚠ Urgent
                        </span>
                      )}
                      <span className="text-xs text-gray-500">
                        {ageDays === 0 ? 'today' : `${ageDays}d open`}
                      </span>
                      {p.assigned_to_name && (
                        <span className="text-xs text-blue-600">→ {p.assigned_to_name}</span>
                      )}
                    </div>
                    <h3 className="font-medium text-gray-900">{p.summary}</h3>
                    {subjectParts.length > 0 && (
                      <div className="text-xs text-gray-500 mt-0.5">{subjectParts.join(' · ')}</div>
                    )}
                    {p.description && (
                      <p className="text-sm text-gray-600 mt-1 whitespace-pre-wrap line-clamp-2">{p.description}</p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500 flex-wrap">
                      <span className="text-ooosh-600">
                        {p.hh_job_number ? `J-${p.hh_job_number}` : 'Job'}
                      </span>
                      {p.job_name && <span>· {p.job_name}</span>}
                      {p.client_name && <span>· {p.client_name}</span>}
                      {p.source_module && p.source_module !== 'manual' && (
                        <span className="px-1.5 py-0.5 bg-gray-100 rounded text-gray-600">{p.source_module}</span>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
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
