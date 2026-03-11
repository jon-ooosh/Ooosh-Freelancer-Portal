import { useState, useEffect, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../services/api';

const STATUS_MAP: Record<number, string> = {
  0: 'Enquiry', 1: 'Provisional', 2: 'Booked', 3: 'Prepped',
  4: 'Part Dispatched', 5: 'Dispatched', 6: 'Returned Incomplete',
  7: 'Returned', 8: 'Requires Attention', 9: 'Cancelled',
  10: 'Not Interested', 11: 'Completed',
};

const STATUS_COLOURS: Record<number, string> = {
  0: 'bg-blue-100 text-blue-700',
  1: 'bg-amber-100 text-amber-700',
  2: 'bg-green-100 text-green-700',
  3: 'bg-purple-100 text-purple-700',
  4: 'bg-orange-100 text-orange-700',
  5: 'bg-indigo-100 text-indigo-700',
  6: 'bg-yellow-100 text-yellow-800',
  7: 'bg-teal-100 text-teal-700',
  8: 'bg-red-100 text-red-700',
  9: 'bg-gray-100 text-gray-500 line-through',
  10: 'bg-gray-100 text-gray-500',
  11: 'bg-emerald-100 text-emerald-700',
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
}

interface JobsResponse {
  data: Job[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface SyncLog {
  id: string;
  started_at: string;
  completed_at: string | null;
  status: string;
  triggered_by: string;
  result: { jobsCreated: number; jobsUpdated: number; total: number } | null;
}

// Default: confirmed and active jobs (Booked through Requires Attention)
const STATUS_FILTER_OPTIONS = [
  { label: 'Confirmed & Active', value: '2,3,4,5,6,7,8' },
  { label: 'All Active', value: '0,1,2,3,4,5,6,7,8' },
  { label: 'All', value: '' },
  { label: 'Booked', value: '2' },
  { label: 'Prepped', value: '3' },
  { label: 'Dispatched', value: '4,5' },
  { label: 'Returned', value: '6,7' },
  { label: 'Requires Attention', value: '8' },
  { label: 'Completed', value: '11' },
  { label: 'Cancelled / Lost', value: '9,10' },
];

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

function categoriseJob(job: Job): string {
  if (!job.job_date) return 'No date set';

  const today = toDateStr(new Date());
  const jobDate = job.job_date.split('T')[0];
  const jobEnd = job.job_end ? job.job_end.split('T')[0] : jobDate;

  // Currently happening (start <= today <= end)
  if (jobDate <= today && jobEnd >= today) return 'Happening Today / Out Now';

  // Already dispatched/returned but in future dates
  if (job.status >= 4 && job.status <= 7) return 'Happening Today / Out Now';

  const twoWeeks = new Date();
  twoWeeks.setDate(twoWeeks.getDate() + 14);
  const twoWeeksStr = toDateStr(twoWeeks);

  // Past jobs
  if (jobEnd < today) return 'Recently Completed';

  // Within next 2 weeks
  if (jobDate <= twoWeeksStr) return 'Next 2 Weeks';

  return 'Coming Up (2+ Weeks)';
}

const SECTION_ORDER = [
  'Happening Today / Out Now',
  'Next 2 Weeks',
  'Coming Up (2+ Weeks)',
  'Recently Completed',
  'No date set',
];

const SECTION_COLOURS: Record<string, string> = {
  'Happening Today / Out Now': 'border-l-green-500',
  'Next 2 Weeks': 'border-l-blue-500',
  'Coming Up (2+ Weeks)': 'border-l-gray-400',
  'Recently Completed': 'border-l-emerald-300',
  'No date set': 'border-l-gray-300',
};

export default function JobsPage() {
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') || '2,3,4,5,6,7,8';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadJobs();
  }, [search, statusFilter]);

  useEffect(() => {
    loadLastSync();
  }, []);

  async function loadJobs(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '200' });
      if (search) params.set('search', search);
      if (statusFilter) params.set('status', statusFilter);

      const data = await api.get<JobsResponse>(`/hirehop/jobs?${params}`);
      setJobs(data.data);
      setPagination(data.pagination);
    } catch (err) {
      console.error('Failed to load jobs:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadLastSync() {
    try {
      const data = await api.get<SyncLog | null>('/hirehop/jobs/last-sync');
      setLastSync(data);
    } catch {
      // sync_log table might not exist yet
    }
  }

  async function handleSyncNow() {
    if (syncing) return;
    setSyncing(true);
    try {
      await api.post('/hirehop/jobs/sync', {});
      await Promise.all([loadJobs(), loadLastSync()]);
    } catch (err) {
      console.error('Sync failed:', err);
    } finally {
      setSyncing(false);
    }
  }

  // Group jobs by time category
  const groupedJobs = useMemo(() => {
    const groups: Record<string, Job[]> = {};
    for (const section of SECTION_ORDER) {
      groups[section] = [];
    }
    for (const job of jobs) {
      const cat = categoriseJob(job);
      if (!groups[cat]) groups[cat] = [];
      groups[cat].push(job);
    }
    // Sort within each group by job_date ASC
    for (const section of SECTION_ORDER) {
      groups[section].sort((a, b) => {
        const da = a.job_date || '9999';
        const db = b.job_date || '9999';
        return da.localeCompare(db);
      });
    }
    return groups;
  }, [jobs]);

  function formatDateRange(start: string | null, end: string | null) {
    if (!start) return '—';
    const s = new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (!end || start === end) return s;
    const e = new Date(end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${s} – ${e}`;
  }

  function formatSyncTime(dateStr: string) {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function formatCurrency(value: number | null) {
    if (value == null) return '';
    return `£${value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
          <p className="mt-1 text-sm text-gray-500">
            {pagination.total} jobs — confirmed and active
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastSync?.completed_at && (
            <span className="text-xs text-gray-400">
              Last sync: {formatSyncTime(lastSync.completed_at)}
            </span>
          )}
          <button
            onClick={handleSyncNow}
            disabled={syncing}
            className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 transition-colors text-gray-700 disabled:opacity-50"
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      </div>

      {/* Search + Filter */}
      <div className="mt-6 flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          placeholder="Search by job name, client, venue, or job number..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-md rounded border border-gray-300 px-4 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Sync info bar */}
      {syncing && (
        <div className="mt-4 bg-ooosh-50 border border-ooosh-200 rounded-lg px-4 py-3 text-sm text-ooosh-700">
          Syncing jobs from HireHop... This may take a few minutes.
        </div>
      )}

      {/* Grouped job sections */}
      {loading ? (
        <div className="mt-8 text-center text-sm text-gray-500">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="mt-8 text-center text-sm text-gray-500">No jobs found.</div>
      ) : (
        <div className="mt-6 space-y-6">
          {SECTION_ORDER.map((section) => {
            const sectionJobs = groupedJobs[section];
            if (!sectionJobs || sectionJobs.length === 0) return null;

            return (
              <div key={section}>
                <div className="flex items-center gap-2 mb-3">
                  <h2 className="text-sm font-semibold text-gray-700">{section}</h2>
                  <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                    {sectionJobs.length}
                  </span>
                </div>
                <div className={`bg-white rounded-xl shadow-sm border border-gray-200 border-l-4 ${SECTION_COLOURS[section] || 'border-l-gray-300'} overflow-hidden`}>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Job #</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Dates</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Value</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Venue</th>
                          <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Manager</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {sectionJobs.map((job) => (
                          <tr
                            key={job.id}
                            onClick={() => navigate(`/jobs/${job.id}`)}
                            className="hover:bg-gray-50 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3 whitespace-nowrap text-sm">
                              {job.hh_job_number ? (
                                <a
                                  href={`https://myhirehop.com/job.php?id=${job.hh_job_number}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="font-mono text-ooosh-600 hover:text-ooosh-700 hover:underline"
                                >
                                  J-{job.hh_job_number}
                                </a>
                              ) : (
                                <span className="font-mono text-gray-400">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <div className="text-sm font-medium text-gray-900 truncate max-w-[200px]">
                                {job.job_name || '—'}
                              </div>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 truncate max-w-[180px]">
                              {job.client_name || job.company_name || '—'}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap">
                              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600'}`}>
                                {STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`}
                              </span>
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                              {formatDateRange(job.job_date, job.job_end)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 font-medium">
                              {formatCurrency(job.job_value)}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 truncate max-w-[150px]">
                              {job.venue_name || '—'}
                            </td>
                            <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
                              {job.manager1_name || '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="mt-4 flex justify-between items-center">
          <p className="text-sm text-gray-500">
            Page {pagination.page} of {pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => loadJobs(pagination.page - 1)}
              disabled={pagination.page <= 1}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => loadJobs(pagination.page + 1)}
              disabled={pagination.page >= pagination.totalPages}
              className="px-3 py-1 text-sm border rounded disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
