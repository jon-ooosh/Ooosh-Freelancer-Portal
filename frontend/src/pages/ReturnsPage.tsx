/**
 * Returns & Completed — the place where things go to get finished up,
 * then live as a record for future queries.
 *
 * Replaces the previous bare-bones Returns page. Server-side everything:
 * search, status filter, type filter, date range, overdue toggle,
 * pagination with jump-to-page. Per-job retro snippet + days-since-return
 * red after 5 days. Post-hire progress shown as a bar (matches the Jobs
 * page) instead of dots — drilling into a job still shows per-item detail.
 */
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

const STATUS_MAP: Record<number, string> = {
  6: 'Returned Incomplete', 7: 'Returned', 8: 'Requires Attention', 11: 'Completed',
};

const STATUS_COLOURS: Record<number, string> = {
  6: 'bg-yellow-100 text-yellow-800',
  7: 'bg-teal-100 text-teal-700',
  8: 'bg-red-100 text-red-700',
  11: 'bg-emerald-100 text-emerald-700',
};

const RATING_COLOURS: Record<string, string> = {
  great: 'bg-green-100 text-green-700',
  ok: 'bg-amber-100 text-amber-700',
  issues: 'bg-red-100 text-red-700',
};

const RATING_LABEL: Record<string, string> = {
  great: 'Great',
  ok: 'OK',
  issues: 'Issues',
};

interface Job {
  id: string;
  hh_job_number: number;
  job_name: string | null;
  status: number;
  status_name: string | null;
  client_name: string | null;
  company_name: string | null;
  venue_name: string | null;
  job_date: string | null;
  job_end: string | null;
  out_date: string | null;
  return_date: string | null;
  manager1_name: string | null;
  job_value: number | null;
  pipeline_status: string | null;
}

interface ReqProgress { total: number; done: number; blocked: number }
interface RetroSnippet { rating: string; notes: string; created_at: string }

type StatusFilter = 'all' | 'returned' | 'completed';
type TypeFilter = 'vehicle' | 'backline' | 'rehearsal';

const STATUS_PILLS: { key: StatusFilter; label: string; statusCsv: string }[] = [
  { key: 'all',       label: 'All',                     statusCsv: '6,7,8,11' },
  { key: 'returned',  label: 'Returned (needs completing)', statusCsv: '6,7,8' },
  { key: 'completed', label: 'Completed',                   statusCsv: '11' },
];

function daysAgo(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDateRange(start: string | null, end: string | null): string {
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (start && end && start !== end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  return '';
}

function ProgressBar({ progress }: { progress: ReqProgress | undefined }) {
  if (!progress || progress.total === 0) {
    return <span className="text-[10px] text-gray-400 italic">No close-out</span>;
  }
  const { total, done, blocked } = progress;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${blocked > 0 ? 'bg-red-500' : pct === 100 ? 'bg-green-500' : 'bg-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs ${blocked > 0 ? 'text-red-600 font-medium' : done === total ? 'text-green-600' : 'text-gray-500'}`}>
        {blocked > 0 ? `${blocked} blocked` : `${done}/${total}`}
      </span>
    </div>
  );
}

export default function ReturnsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialOverdue = searchParams.get('overdue') === '1';
  const initialStatus = (searchParams.get('status_filter') as StatusFilter) || 'all';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialStatus);
  const [typeFilter, setTypeFilter] = useState<TypeFilter[]>([]);
  const [dateFrom, setDateFrom] = useState(searchParams.get('date_from') || '');
  const [dateTo, setDateTo] = useState(searchParams.get('date_to') || '');
  const [overdueOnly, setOverdueOnly] = useState(initialOverdue);
  const [hasIssuesOnly, setHasIssuesOnly] = useState(searchParams.get('has_issues') === '1');
  const [page, setPage] = useState(parseInt(searchParams.get('page') || '1', 10));
  const [limit] = useState(50);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [pageInput, setPageInput] = useState('');

  const [reqProgress, setReqProgress] = useState<Record<string, ReqProgress>>({});
  const [retros, setRetros] = useState<Record<string, RetroSnippet>>({});

  const loadJobs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      const statusCsv = STATUS_PILLS.find(p => p.key === statusFilter)?.statusCsv || '6,7,8,11';
      params.set('status', statusCsv);
      params.set('page', String(page));
      params.set('limit', String(limit));
      params.set('date_field', 'return_date');
      if (search.trim()) params.set('search', search.trim());
      if (typeFilter.length > 0) params.set('service_type', typeFilter.join(','));
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
      if (hasIssuesOnly) params.set('has_issues', '1');

      const res = await api.get<{ data: Job[]; pagination: { totalPages: number; total: number } }>(
        `/hirehop/jobs?${params.toString()}`
      );
      let rows = res.data;
      // Overdue is computed client-side (return_date < today). Cheaper than
      // adding more SQL — we already paginate server-side.
      if (overdueOnly) {
        const today = new Date().toISOString().split('T')[0];
        rows = rows.filter(j => {
          const ret = (j.return_date || j.job_end || '').split('T')[0];
          return ret && ret < today && j.status !== 11;
        });
      }
      setJobs(rows);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
    } catch (err) {
      console.error('Failed to load returns:', err);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, typeFilter, dateFrom, dateTo, overdueOnly, hasIssuesOnly, page, limit, search]);

  useEffect(() => { loadJobs(); }, [loadJobs]);

  // Sync filter state into URL so links survive a refresh / share.
  useEffect(() => {
    const next = new URLSearchParams();
    if (statusFilter !== 'all') next.set('status_filter', statusFilter);
    if (search.trim()) next.set('search', search.trim());
    if (dateFrom) next.set('date_from', dateFrom);
    if (dateTo) next.set('date_to', dateTo);
    if (overdueOnly) next.set('overdue', '1');
    if (hasIssuesOnly) next.set('has_issues', '1');
    if (page > 1) next.set('page', String(page));
    setSearchParams(next, { replace: true });
  }, [statusFilter, search, dateFrom, dateTo, overdueOnly, hasIssuesOnly, page, setSearchParams]);

  // Load post-hire progress + retros after jobs change.
  useEffect(() => {
    if (jobs.length === 0) {
      setReqProgress({}); setRetros({});
      return;
    }
    const ids = jobs.map(j => j.id);
    api.post<{ data: Record<string, ReqProgress> }>('/requirements/bulk', { job_ids: ids, phase: 'post_hire' })
      .then(res => setReqProgress(res.data))
      .catch(() => {});
    api.post<{ data: Record<string, RetroSnippet> }>('/hirehop/jobs/retros-bulk', { job_ids: ids })
      .then(res => setRetros(res.data))
      .catch(() => {});
  }, [jobs]);

  // Reset page when filters change so the user sees results from the start.
  useEffect(() => { setPage(1); }, [statusFilter, search, typeFilter, dateFrom, dateTo, overdueOnly, hasIssuesOnly]);

  const stats = useMemo(() => {
    const active = jobs.filter(j => [6, 7, 8].includes(j.status)).length;
    const completed = jobs.filter(j => j.status === 11).length;
    return { active, completed };
  }, [jobs]);

  function clearFilters() {
    setSearch(''); setTypeFilter([]); setDateFrom(''); setDateTo('');
    setOverdueOnly(false); setHasIssuesOnly(false); setStatusFilter('all'); setPage(1);
  }

  function jumpToPage() {
    const n = parseInt(pageInput, 10);
    if (Number.isFinite(n) && n >= 1 && n <= totalPages) {
      setPage(n); setPageInput('');
    }
  }

  function JobRow({ job }: { job: Job }) {
    const returnDays = job.return_date ? daysAgo(job.return_date) : null;
    const isOverdue = returnDays !== null && returnDays > 5 && job.status !== 11;
    const retro = retros[job.id];
    const progress = reqProgress[job.id];

    return (
      <Link
        to={`/jobs/${job.id}`}
        state={{ from: '/jobs/returns' }}
        className={`block bg-white rounded-lg border p-4 hover:shadow-sm transition-all ${
          job.status === 8 ? 'border-red-300 bg-red-50/30'
          : isOverdue ? 'border-red-200 bg-red-50/20'
          : 'border-gray-200 hover:border-ooosh-300'
        }`}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              {job.hh_job_number ? (
                <span className="font-mono text-sm text-gray-500">J-{job.hh_job_number}</span>
              ) : (
                <span className="text-xs text-gray-400">NEW</span>
              )}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600'}`}>
                {STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`}
              </span>
              {returnDays !== null && returnDays >= 0 && job.status !== 11 && (
                <span className={`text-xs ${isOverdue ? 'text-red-700 font-semibold' : 'text-gray-500'}`}>
                  {isOverdue ? `⚠ ${returnDays}d since return` : `Returned ${returnDays}d ago`}
                </span>
              )}
              {retro && (
                <span
                  className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${RATING_COLOURS[retro.rating] || 'bg-gray-100 text-gray-600'}`}
                  title={retro.notes || RATING_LABEL[retro.rating] || retro.rating}
                >
                  {RATING_LABEL[retro.rating] || retro.rating}
                </span>
              )}
            </div>
            <h3 className="font-medium text-gray-900 truncate">{job.job_name || 'Untitled Job'}</h3>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
              <span>{job.client_name || job.company_name || 'No client'}</span>
              {job.job_date && (
                <span className="text-gray-400">{formatDateRange(job.job_date, job.job_end)}</span>
              )}
              {job.job_value != null && job.job_value > 0 && (
                <span className="text-gray-400">£{job.job_value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              )}
            </div>
            {retro && retro.notes && (
              <div className="mt-1.5 text-xs text-gray-600 italic truncate" title={retro.notes}>
                “{retro.notes.length > 90 ? retro.notes.slice(0, 90) + '…' : retro.notes}”
              </div>
            )}
            <div className="mt-2">
              <ProgressBar progress={progress} />
            </div>
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            {job.manager1_name && (
              <span className="text-xs text-gray-400">{job.manager1_name}</span>
            )}
          </div>
        </div>
      </Link>
    );
  }

  const TYPE_OPTIONS: { key: TypeFilter; label: string }[] = [
    { key: 'vehicle',   label: 'Vehicles' },
    { key: 'backline',  label: 'Backline' },
    { key: 'rehearsal', label: 'Rehearsals' },
  ];

  const hasFilters = search.trim() !== '' || typeFilter.length > 0 || dateFrom !== '' || dateTo !== '' || overdueOnly || hasIssuesOnly || statusFilter !== 'all';

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Returns &amp; Completed</h1>
          <p className="text-sm text-gray-500 mt-1">
            {total} total
            {jobs.length !== total && ` · showing ${jobs.length} on this page`}
            {' '}· {stats.active} active · {stats.completed} completed (this page)
          </p>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="space-y-3 mb-4">
        {/* Search + status */}
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by job name, client, or job number…"
            className="flex-1 max-w-md border border-gray-300 rounded-lg px-4 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
          />
          <div className="flex gap-1 bg-gray-100 rounded-lg p-0.5">
            {STATUS_PILLS.map(p => (
              <button
                key={p.key}
                onClick={() => setStatusFilter(p.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  statusFilter === p.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* Type pills + date range + overdue toggle */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="inline-flex items-center gap-1">
            <span className="text-xs text-gray-500 mr-1">Type:</span>
            {TYPE_OPTIONS.map(opt => {
              const active = typeFilter.includes(opt.key);
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTypeFilter(prev =>
                    prev.includes(opt.key) ? prev.filter(p => p !== opt.key) : [...prev, opt.key]
                  )}
                  className={`px-2.5 py-1 text-xs font-medium rounded-full border transition-colors ${
                    active ? 'bg-ooosh-600 text-white border-ooosh-600' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="inline-flex items-center gap-1.5">
            <span className="text-xs text-gray-500">Returned:</span>
            <input
              type="date"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
              title="From (return_date >= …)"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-xs"
              title="To (return_date <= …)"
            />
          </div>

          <label
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border cursor-pointer transition-colors ${
              overdueOnly
                ? 'border-red-300 bg-red-50 text-red-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
            title="Only show returned jobs more than 5 days past return date"
          >
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={e => setOverdueOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            ⚠ Overdue only
          </label>

          <label
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full border cursor-pointer transition-colors ${
              hasIssuesOnly
                ? 'border-purple-300 bg-purple-50 text-purple-700'
                : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
            }`}
            title="Only show jobs with at least one open problem in the issues register"
          >
            <input
              type="checkbox"
              checked={hasIssuesOnly}
              onChange={e => setHasIssuesOnly(e.target.checked)}
              className="rounded border-gray-300"
            />
            ⚠ Has issues
          </label>

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {/* ── Jobs list ── */}
      {loading ? (
        <div className="text-center py-12 text-gray-500">Loading…</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No jobs match these filters.
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map(job => <JobRow key={job.id} job={job} />)}
        </div>
      )}

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-gray-500">
            Page {page} of {totalPages} · {total} total
          </p>
          <div className="flex items-center gap-2">
            <button onClick={() => setPage(1)} disabled={page <= 1}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50">⏮</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Prev</button>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50">Next</button>
            <button onClick={() => setPage(totalPages)} disabled={page >= totalPages}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50">⏭</button>
            <span className="text-xs text-gray-400 ml-2">Jump to:</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={e => setPageInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') jumpToPage(); }}
              placeholder={String(page)}
              className="w-16 border border-gray-300 rounded px-2 py-1 text-sm"
            />
            <button
              onClick={jumpToPage}
              disabled={!pageInput}
              className="px-2.5 py-1 text-sm border rounded disabled:opacity-50"
            >Go</button>
          </div>
        </div>
      )}
    </div>
  );
}
