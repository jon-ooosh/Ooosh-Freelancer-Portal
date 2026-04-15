import { useState, useEffect } from 'react';
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

interface Props {
  entityType: 'organisation' | 'person';
  entityId: string;
}

export default function HireHistoryTab({ entityType, entityId }: Props) {
  const [jobs, setJobs] = useState<HireHistoryJob[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  useEffect(() => {
    loadHistory(1);
  }, [entityId]);

  async function loadHistory(p: number) {
    setLoading(true);
    try {
      const endpoint = entityType === 'organisation'
        ? `/organisations/${entityId}/hire-history`
        : `/people/${entityId}/hire-history`;
      const data = await api.get<{
        data: HireHistoryJob[];
        stats: Stats;
        pagination: { page: number; totalPages: number };
      }>(`${endpoint}?page=${p}&limit=50`);
      setJobs(data.data);
      setStats(data.stats);
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

  if (loading && jobs.length === 0) {
    return <div className="text-center py-8 text-gray-500 text-sm">Loading hire history...</div>;
  }

  const totalJobs = parseInt(stats?.total_jobs || '0');
  const retroGreat = parseInt(stats?.retro_great || '0');
  const retroOk = parseInt(stats?.retro_ok || '0');
  const retroIssues = parseInt(stats?.retro_issues || '0');
  const totalRetros = retroGreat + retroOk + retroIssues;

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
                ? `\u00A3${parseFloat(stats.total_value).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
                : '\u2014'}
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

      {/* Job list */}
      {totalJobs === 0 ? (
        <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
          No hire history yet
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
              {jobs.map((job) => {
                const statusDisplay = getStatusDisplay(job);
                const retro = job.retro_rating ? RETRO_COLOURS[job.retro_rating] : null;
                const role = job.link_role || job.role || '';
                return (
                  <tr key={`${job.id}-${role}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3">
                      <Link to={`/jobs/${job.id}`} className="text-sm font-medium text-ooosh-600 hover:text-ooosh-700 hover:underline">
                        {job.hh_job_number ? `J-${job.hh_job_number}` : 'NEW'}
                      </Link>
                      <div className="text-sm text-gray-900 truncate max-w-[200px]">{job.job_name || 'Untitled'}</div>
                      {job.link_type === 'crew' && (
                        <span className="text-[10px] text-indigo-600 font-medium">Crew</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 capitalize whitespace-nowrap">{role.replace('_', ' ')}</td>
                    <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                      {formatDate(job.job_date)}
                      {job.job_end && job.job_end !== job.job_date && ` \u2013 ${formatDate(job.job_end)}`}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusDisplay.colour}`}>
                        {statusDisplay.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-right text-gray-600 whitespace-nowrap">
                      {job.job_value != null && job.job_value > 0
                        ? `\u00A3${job.job_value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`
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
                      ) : (
                        <span className="text-gray-300 text-center block">&mdash;</span>
                      )}
                    </td>
                  </tr>
                );
              })}
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
