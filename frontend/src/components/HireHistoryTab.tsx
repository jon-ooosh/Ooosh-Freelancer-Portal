import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';

const STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  5: 'Dispatched', 6: 'Returned Incomplete', 7: 'Returned',
  8: 'Requires Attention', 9: 'Cancelled', 10: 'Not Interested', 11: 'Completed',
};

const PIPELINE_LABELS: Record<string, { label: string; colour: string }> = {
  new_enquiry: { label: 'Enquiry', colour: 'bg-blue-100 text-blue-700' },
  chasing: { label: 'Chasing', colour: 'bg-amber-100 text-amber-700' },
  provisional: { label: 'Provisional', colour: 'bg-red-100 text-red-700' },
  paused: { label: 'Paused', colour: 'bg-gray-100 text-gray-600' },
  confirmed: { label: 'Confirmed', colour: 'bg-green-100 text-green-700' },
  lost: { label: 'Lost', colour: 'bg-gray-100 text-gray-500' },
  prepped: { label: 'Prepped', colour: 'bg-purple-100 text-purple-700' },
  dispatched: { label: 'Dispatched', colour: 'bg-indigo-100 text-indigo-700' },
  returned: { label: 'Returned', colour: 'bg-teal-100 text-teal-700' },
  returned_incomplete: { label: 'Checking In', colour: 'bg-yellow-100 text-yellow-800' },
  completed: { label: 'Completed', colour: 'bg-emerald-100 text-emerald-700' },
};

const RETRO_COLOURS: Record<string, { bg: string; text: string; label: string }> = {
  great: { bg: 'bg-green-100', text: 'text-green-700', label: 'Great' },
  ok: { bg: 'bg-amber-100', text: 'text-amber-700', label: 'OK' },
  issues: { bg: 'bg-red-100', text: 'text-red-700', label: 'Issues' },
};

const SORT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'date:desc', label: 'Start date (newest first)' },
  { value: 'date:asc', label: 'Start date (oldest first)' },
  { value: 'job_number:desc', label: 'Job number (highest first)' },
  { value: 'job_number:asc', label: 'Job number (lowest first)' },
  { value: 'value:desc', label: 'Value (highest first)' },
  { value: 'value:asc', label: 'Value (lowest first)' },
  { value: 'status:asc', label: 'Status (A–Z)' },
];

const OUTCOME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'All outcomes' },
  { value: 'open', label: 'Open (enquiry / provisional)' },
  { value: 'confirmed', label: 'Confirmed / on-hire' },
  { value: 'returned', label: 'Returned / completed' },
  { value: 'lost', label: 'Lost / cancelled' },
];

interface HireHistoryJob {
  id: string;
  hh_job_number: number | null;
  job_name: string | null;
  pipeline_status: string | null;
  status: number;
  job_date: string | null;
  job_end: string | null;
  return_date: string | null;
  job_value: number | null;
  client_name: string | null;
  company_name: string | null;
  role?: string;
  link_role?: string;
  link_org_name?: string;
  link_type?: string;
  lost_reason?: string | null;
  lost_detail?: string | null;
  retro_rating: string | null;
  retro_notes: string | null;
  retro_follow_up?: string | null;
}

interface Stats {
  total_jobs: string;
  completed_jobs: string;
  confirmed_jobs: string;
  lost_jobs: string;
  total_value: string;
  retro_great?: string;
  retro_ok?: string;
  retro_issues?: string;
}

interface Facets {
  roles: string[];
  years: number[];
}

interface Props {
  entityType: 'organisation' | 'person';
  entityId: string;
}

export default function HireHistoryTab({ entityType, entityId }: Props) {
  const [jobs, setJobs] = useState<HireHistoryJob[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [facets, setFacets] = useState<Facets>({ roles: [], years: [] });
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [sort, setSort] = useState<string>('date:desc');
  const [role, setRole] = useState<string>('');
  const [outcome, setOutcome] = useState<string>('');
  const [year, setYear] = useState<string>('');
  const [groupByYear, setGroupByYear] = useState(false);

  // Reset filters when switching entities
  useEffect(() => {
    setPage(1);
    setSort('date:desc');
    setRole('');
    setOutcome('');
    setYear('');
    setGroupByYear(false);
  }, [entityId, entityType]);

  useEffect(() => {
    loadHistory(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, entityType, sort, role, outcome, year]);

  async function loadHistory(p: number) {
    setLoading(true);
    try {
      const [sortKey, dir] = sort.split(':');
      const params = new URLSearchParams({
        page: String(p),
        limit: '50',
        sort: sortKey,
        dir: dir,
      });
      if (role) params.set('role', role);
      if (outcome) params.set('outcome', outcome);
      if (year) params.set('year', year);

      const endpoint = entityType === 'organisation'
        ? `/organisations/${entityId}/hire-history`
        : `/people/${entityId}/hire-history`;
      const data = await api.get<{
        data: HireHistoryJob[];
        stats: Stats;
        facets?: Facets;
        pagination: { page: number; totalPages: number };
      }>(`${endpoint}?${params.toString()}`);
      setJobs(data.data);
      setStats(data.stats);
      setFacets(data.facets || { roles: [], years: [] });
      setPage(data.pagination.page);
      setTotalPages(data.pagination.totalPages);
    } catch (err) {
      console.error('Failed to load hire history:', err);
    } finally {
      setLoading(false);
    }
  }

  function formatDate(d: string | null): string {
    if (!d) return '';
    return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function getStatusDisplay(job: HireHistoryJob): { label: string; colour: string } {
    if (job.pipeline_status && PIPELINE_LABELS[job.pipeline_status]) {
      return PIPELINE_LABELS[job.pipeline_status];
    }
    return { label: STATUS_MAP[job.status] || `Status ${job.status}`, colour: 'bg-gray-100 text-gray-600' };
  }

  function csvEscape(v: unknown): string {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  function exportCsv() {
    const header = ['Job Number', 'Job Name', 'Role', 'Start Date', 'End Date', 'Status', 'Value', 'Retro', 'Lost Reason'];
    const rows = jobs.map(j => {
      const status = getStatusDisplay(j).label;
      const role = j.link_role || j.role || '';
      const retro = j.retro_rating ? RETRO_COLOURS[j.retro_rating]?.label || j.retro_rating : '';
      return [
        j.hh_job_number ? `J-${j.hh_job_number}` : 'NEW',
        j.job_name || '',
        role,
        j.job_date ? new Date(j.job_date).toISOString().slice(0, 10) : '',
        j.job_end ? new Date(j.job_end).toISOString().slice(0, 10) : '',
        status,
        j.job_value != null ? j.job_value.toFixed(2) : '',
        retro,
        j.lost_reason || '',
      ].map(csvEscape).join(',');
    });
    const csv = [header.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hire-history-${entityType}-${entityId.slice(0, 8)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Group by year for the optional grouped view
  const groupedJobs = useMemo(() => {
    if (!groupByYear) return null;
    const groups = new Map<string, HireHistoryJob[]>();
    for (const job of jobs) {
      const yr = job.job_date ? new Date(job.job_date).getFullYear().toString() : 'No date';
      const arr = groups.get(yr) || [];
      arr.push(job);
      groups.set(yr, arr);
    }
    // Sort year keys in reverse, "No date" last
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'No date') return 1;
      if (b === 'No date') return -1;
      return parseInt(b, 10) - parseInt(a, 10);
    });
    return keys.map(k => [k, groups.get(k)!] as const);
  }, [jobs, groupByYear]);

  if (loading && jobs.length === 0) {
    return <div className="text-center py-8 text-gray-500 text-sm">Loading hire history...</div>;
  }

  const totalJobs = parseInt(stats?.total_jobs || '0');
  const retroGreat = parseInt(stats?.retro_great || '0');
  const retroOk = parseInt(stats?.retro_ok || '0');
  const retroIssues = parseInt(stats?.retro_issues || '0');
  const totalRetros = retroGreat + retroOk + retroIssues;
  const filtersActive = !!(role || outcome || year);

  function renderRow(job: HireHistoryJob) {
    const statusDisplay = getStatusDisplay(job);
    const retro = job.retro_rating ? RETRO_COLOURS[job.retro_rating] : null;
    const rowRole = job.link_role || job.role || '';
    return (
      <tr key={`${job.id}-${rowRole}`} className="hover:bg-gray-50 transition-colors">
        <td className="px-4 py-3">
          <Link to={`/jobs/${job.id}`} className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700 hover:underline">
            {job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW'}
          </Link>
          <div className="text-sm text-gray-900 truncate max-w-[200px]">{job.job_name || 'Untitled'}</div>
          {job.link_type === 'crew' && (
            <span className="text-[10px] text-indigo-600 font-medium">Crew</span>
          )}
        </td>
        <td className="px-4 py-3 text-xs text-gray-500 capitalize whitespace-nowrap">{rowRole.replace('_', ' ')}</td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {formatDate(job.job_date)}
          {job.job_end && job.job_end !== job.job_date && ` – ${formatDate(job.job_end)}`}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusDisplay.colour}`}>
            {statusDisplay.label}
          </span>
        </td>
        <td className="px-4 py-3 text-sm text-right text-gray-600 whitespace-nowrap">
          {job.job_value != null && job.job_value > 0
            ? `£${job.job_value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`
            : ''}
        </td>
        <td className="px-4 py-3">
          {retro ? (
            <div>
              <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-medium ${retro.bg} ${retro.text}`}>
                {retro.label}
              </span>
              {job.retro_notes && (
                <div className="text-[10px] text-gray-500 mt-0.5 max-w-[200px] truncate" title={job.retro_notes}>
                  {job.retro_notes}
                </div>
              )}
              {job.retro_follow_up && (
                <div className="text-[10px] text-amber-600 mt-0.5 max-w-[200px] truncate" title={job.retro_follow_up}>
                  Follow-up: {job.retro_follow_up}
                </div>
              )}
            </div>
          ) : job.lost_reason ? (
            <div>
              <span className="inline-flex px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600">
                Lost: {job.lost_reason}
              </span>
              {job.lost_detail && (
                <div className="text-[10px] text-gray-400 italic mt-0.5 max-w-[200px]" title={job.lost_detail}>
                  {job.lost_detail}
                </div>
              )}
            </div>
          ) : (
            <span className="text-gray-300 text-center block">&mdash;</span>
          )}
        </td>
      </tr>
    );
  }

  return (
    <div className="space-y-4">
      {/* Stats summary */}
      {stats && totalJobs > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-2xl font-bold text-gray-900">{stats.total_jobs}</div>
            <div className="text-xs text-gray-500">Total Jobs</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.confirmed_jobs}</div>
            <div className="text-xs text-gray-500">Confirmed</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            <div className="text-2xl font-bold text-gray-900">
              {parseFloat(stats.total_value) > 0
                ? `£${parseFloat(stats.total_value).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
                : '—'}
            </div>
            <div className="text-xs text-gray-500">Total Value</div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-3 text-center">
            {totalRetros > 0 ? (
              <div className="flex items-center justify-center gap-1">
                {retroGreat > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-100 text-green-700">{retroGreat}</span>}
                {retroOk > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700">{retroOk}</span>}
                {retroIssues > 0 && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-100 text-red-700">{retroIssues}</span>}
              </div>
            ) : (
              <div className="text-2xl font-bold text-gray-300">&mdash;</div>
            )}
            <div className="text-xs text-gray-500 mt-0.5">Retros</div>
          </div>
        </div>
      )}

      {/* Filter / sort bar */}
      {totalJobs > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 p-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] uppercase font-medium text-gray-500 mb-1">Sort by</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value)}
              className="text-sm border-gray-300 rounded px-2 py-1.5"
            >
              {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase font-medium text-gray-500 mb-1">Outcome</label>
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              className="text-sm border-gray-300 rounded px-2 py-1.5"
            >
              {OUTCOME_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {facets.roles.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase font-medium text-gray-500 mb-1">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="text-sm border-gray-300 rounded px-2 py-1.5 capitalize"
              >
                <option value="">All roles</option>
                {facets.roles.map(r => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
              </select>
            </div>
          )}
          {facets.years.length > 0 && (
            <div>
              <label className="block text-[10px] uppercase font-medium text-gray-500 mb-1">Year</label>
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="text-sm border-gray-300 rounded px-2 py-1.5"
              >
                <option value="">All years</option>
                {facets.years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
          )}
          <label className="flex items-center gap-1.5 text-xs text-gray-700 mb-1">
            <input
              type="checkbox"
              checked={groupByYear}
              onChange={(e) => setGroupByYear(e.target.checked)}
              className="rounded"
            />
            Group by year
          </label>
          <div className="flex-1" />
          {filtersActive && (
            <button
              onClick={() => { setRole(''); setOutcome(''); setYear(''); }}
              className="text-xs text-gray-500 hover:text-gray-700 underline"
            >
              Clear filters
            </button>
          )}
          <button
            onClick={exportCsv}
            disabled={jobs.length === 0}
            className="text-xs px-3 py-1.5 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
            title="Export current page as CSV"
          >
            Export CSV
          </button>
        </div>
      )}

      {/* Job list */}
      {totalJobs === 0 ? (
        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No hire history yet
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No jobs match the current filters
        </div>
      ) : groupedJobs ? (
        <div className="space-y-4">
          {groupedJobs.map(([yr, ys]) => (
            <div key={yr} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
              <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">{yr}</span>
                <span className="text-xs text-gray-500">{ys.length} {ys.length === 1 ? 'job' : 'jobs'}</span>
              </div>
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dates</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Retro</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {ys.map(renderRow)}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Job</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Dates</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Value</th>
                <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Retro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {jobs.map(renderRow)}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-between items-center text-sm text-gray-500">
          <span>Page {page} of {totalPages}</span>
          <div className="flex gap-2">
            <button
              onClick={() => loadHistory(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-50 hover:bg-gray-50"
            >
              Previous
            </button>
            <button
              onClick={() => loadHistory(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1 border border-gray-300 rounded text-xs disabled:opacity-50 hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
