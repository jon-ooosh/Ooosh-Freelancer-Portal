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
  pipeline_status: string | null;
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

// Default: confirmed and active jobs (Booked through Requires Attention, excluding Returned)
const STATUS_FILTER_OPTIONS = [
  { label: 'Confirmed & Active', value: '2,3,4,5,8' },
  { label: 'Including Returned', value: '2,3,4,5,6,7,8' },
  { label: 'All Statuses', value: '' },
  { label: 'Booked', value: '2' },
  { label: 'Prepped', value: '3' },
  { label: 'Dispatched', value: '4,5' },
  { label: 'Returned', value: '6,7' },
  { label: 'Requires Attention', value: '8' },
  { label: 'Completed', value: '11' },
  { label: 'Cancelled / Lost', value: '9,10' },
];

type TimeFilter = 'all' | 'out_now' | 'next_2_weeks' | 'over_2_weeks';

const TIME_FILTER_OPTIONS: { label: string; value: TimeFilter }[] = [
  { label: 'All Time Periods', value: 'all' },
  { label: 'Out Now', value: 'out_now' },
  { label: 'Next 2 Weeks', value: 'next_2_weeks' },
  { label: 'Over 2 Weeks Away', value: 'over_2_weeks' },
];

function toDateStr(d: Date): string {
  return d.toISOString().split('T')[0];
}

// Return window: jobs could return from midday the day before the official return_date/job_end.
// This captures the reality that a 2-day hire for 1st-2nd May is due back 9am 3rd May,
// but the client could return it any time on the 2nd.
function isInReturnWindow(job: Job, todayStr: string): boolean {
  // Use return_date if available, otherwise job_end
  const returnDateStr = (job.return_date || job.job_end || '').split('T')[0];
  if (!returnDateStr) return false;

  const today = new Date(todayStr + 'T00:00:00');

  // Yesterday (midday onwards = could return from yesterday)
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = toDateStr(yesterday);

  // In return window if: return_date is today, or return_date is tomorrow (meaning today is the "day before")
  // Or: the job_end was yesterday (they're expected back today)
  const jobEndStr = (job.job_end || '').split('T')[0];

  // Return window covers: job_end yesterday through return_date today
  if (returnDateStr === todayStr) return true;
  if (jobEndStr === yesterdayStr || jobEndStr === todayStr) return true;

  // Also: return_date is tomorrow means today is the last day of hire, could come back from midday
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = toDateStr(tomorrow);
  if (returnDateStr === tomorrowStr) return true;

  return false;
}

function isGoingOutToday(job: Job, todayStr: string): boolean {
  const jobDate = (job.job_date || '').split('T')[0];
  const outDate = (job.out_date || '').split('T')[0];
  return jobDate === todayStr || outDate === todayStr;
}

function isCurrentlyOut(job: Job, todayStr: string): boolean {
  // HH status 4-6 = actively dispatched
  if (job.status >= 4 && job.status <= 6) return true;

  const jobDate = (job.job_date || '').split('T')[0];
  const jobEnd = (job.job_end || job.job_date || '').split('T')[0];
  if (!jobDate) return false;

  // Date range includes today
  return jobDate < todayStr && jobEnd >= todayStr;
}

type HappeningCategory = 'going_out' | 'returning' | 'currently_out';

interface HappeningJob {
  job: Job;
  categories: HappeningCategory[];
}

type Section = 'Next 2 Weeks' | 'Coming Up (2+ Weeks)' | 'Recently Completed' | 'No date set';

const SECTION_ORDER: Section[] = [
  'Next 2 Weeks',
  'Coming Up (2+ Weeks)',
  'Recently Completed',
  'No date set',
];

const SECTION_COLOURS: Record<string, string> = {
  'Next 2 Weeks': 'border-l-blue-500',
  'Coming Up (2+ Weeks)': 'border-l-gray-400',
  'Recently Completed': 'border-l-emerald-300',
  'No date set': 'border-l-gray-300',
};

// --- Requirements progress (from API) ---

interface ReqProgress {
  total: number;
  done: number;
  blocked: number;
}

function RequirementsProgress({ progress }: { progress: ReqProgress | undefined }) {
  if (!progress || progress.total === 0) return null;
  const { total, done, blocked } = progress;
  const pct = Math.round((done / total) * 100);
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-16 h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${blocked > 0 ? 'bg-red-500' : pct === 100 ? 'bg-green-500' : 'bg-amber-400'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs ${blocked > 0 ? 'text-red-600 font-medium' : done === total ? 'text-green-600' : 'text-gray-400'}`}>
        {blocked > 0 ? `${blocked} blocked` : `${done}/${total}`}
      </span>
    </div>
  );
}

export default function JobsPage() {
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status') || '2,3,4,5,8';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, total: 0, totalPages: 0 });
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<SyncLog | null>(null);
  const [reqProgress, setReqProgress] = useState<Record<string, ReqProgress>>({});
  const navigate = useNavigate();

  useEffect(() => {
    loadJobs();
  }, [search, statusFilter]);

  useEffect(() => {
    loadLastSync();
  }, []);

  // Load requirements progress when jobs change
  useEffect(() => {
    if (jobs.length === 0) return;
    const jobIds = jobs.map(j => j.id);
    api.post<{ data: Record<string, ReqProgress> }>('/requirements/bulk', { job_ids: jobIds })
      .then(res => setReqProgress(res.data))
      .catch(() => { /* requirements table may not exist yet */ });
  }, [jobs]);

  async function loadJobs(page = 1) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: '500' });
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

  // Split jobs into "Happening Today" and regular sections
  const { happeningToday, groupedJobs, filteredCount } = useMemo(() => {
    const todayStr = toDateStr(new Date());
    const twoWeeks = new Date();
    twoWeeks.setDate(twoWeeks.getDate() + 14);
    const twoWeeksStr = toDateStr(twoWeeks);

    const happening: HappeningJob[] = [];
    const happeningIds = new Set<string>();
    const groups: Record<Section, Job[]> = {
      'Next 2 Weeks': [],
      'Coming Up (2+ Weeks)': [],
      'Recently Completed': [],
      'No date set': [],
    };

    // First pass: identify "Happening Today" jobs
    for (const job of jobs) {
      const categories: HappeningCategory[] = [];

      if (isGoingOutToday(job, todayStr)) categories.push('going_out');
      if (isCurrentlyOut(job, todayStr)) categories.push('currently_out');
      if (isInReturnWindow(job, todayStr)) categories.push('returning');

      if (categories.length > 0) {
        happening.push({ job, categories });
        happeningIds.add(job.id);
      }
    }

    // Second pass: categorise remaining jobs
    for (const job of jobs) {
      if (happeningIds.has(job.id)) continue; // already in Happening Today

      if (!job.job_date) {
        groups['No date set'].push(job);
        continue;
      }

      const jobDate = job.job_date.split('T')[0];
      const jobEnd = (job.job_end || job.job_date).split('T')[0];

      if (jobEnd < todayStr) {
        groups['Recently Completed'].push(job);
      } else if (jobDate <= twoWeeksStr) {
        groups['Next 2 Weeks'].push(job);
      } else {
        groups['Coming Up (2+ Weeks)'].push(job);
      }
    }

    // Sort within groups
    for (const section of SECTION_ORDER) {
      groups[section].sort((a, b) => {
        const da = a.job_date || '9999';
        const db = b.job_date || '9999';
        return da.localeCompare(db);
      });
    }

    // Sort happening: going_out first, then currently_out, then returning
    happening.sort((a, b) => {
      const priority = (h: HappeningJob) => {
        if (h.categories.includes('going_out')) return 0;
        if (h.categories.includes('currently_out')) return 1;
        return 2;
      };
      return priority(a) - priority(b);
    });

    // Apply time filter
    let count = happening.length;
    const filteredGroups = { ...groups };
    for (const section of SECTION_ORDER) {
      if (timeFilter === 'out_now') {
        // Only show happening today
        filteredGroups[section] = [];
      } else if (timeFilter === 'next_2_weeks') {
        if (section !== 'Next 2 Weeks') filteredGroups[section] = [];
        else count += filteredGroups[section].length;
      } else if (timeFilter === 'over_2_weeks') {
        if (section !== 'Coming Up (2+ Weeks)') filteredGroups[section] = [];
        else count += filteredGroups[section].length;
      } else {
        count += filteredGroups[section].length;
      }
    }

    return { happeningToday: happening, groupedJobs: filteredGroups, filteredCount: count };
  }, [jobs, timeFilter]);

  function formatDateRange(start: string | null, end: string | null) {
    if (!start) return '\u2014';
    const s = new Date(start).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    if (!end || start === end) return s;
    const e = new Date(end).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return `${s} \u2013 ${e}`;
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
    return `\u00A3${value.toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  function happeningLabel(categories: HappeningCategory[]): { text: string; colour: string } {
    if (categories.includes('going_out')) return { text: 'Going Out', colour: 'bg-orange-100 text-orange-700' };
    if (categories.includes('returning')) return { text: 'Returning', colour: 'bg-teal-100 text-teal-700' };
    return { text: 'Out Now', colour: 'bg-indigo-100 text-indigo-700' };
  }

  function renderJobRow(job: Job, showRequirements = false, happeningBadge?: { text: string; colour: string }) {
    const progress = showRequirements ? reqProgress[job.id] : undefined;
    return (
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
            <span className="font-mono text-gray-400">{'\u2014'}</span>
          )}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="text-sm font-medium text-gray-900 truncate max-w-[200px]">
            {job.job_name || '\u2014'}
          </div>
          {showRequirements && progress && (
            <div className="mt-0.5">
              <RequirementsProgress progress={progress} />
            </div>
          )}
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 truncate max-w-[180px]">
          {job.client_name || job.company_name || '\u2014'}
        </td>
        <td className="px-4 py-3 whitespace-nowrap">
          <div className="flex flex-col gap-1">
            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600'}`}>
              {STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`}
            </span>
            {happeningBadge && (
              <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${happeningBadge.colour}`}>
                {happeningBadge.text}
              </span>
            )}
          </div>
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
          {formatDateRange(job.job_date, job.job_end)}
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-600 font-medium">
          {formatCurrency(job.job_value)}
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500 truncate max-w-[150px]">
          {job.venue_name || '\u2014'}
        </td>
        <td className="px-4 py-3 whitespace-nowrap text-sm text-gray-500">
          {job.manager1_name || '\u2014'}
        </td>
      </tr>
    );
  }

  function renderTableHeader() {
    return (
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
    );
  }

  const goingOut = happeningToday.filter(h => h.categories.includes('going_out'));
  const returning = happeningToday.filter(h => h.categories.includes('returning') && !h.categories.includes('going_out'));
  const currentlyOut = happeningToday.filter(h => !h.categories.includes('going_out') && !h.categories.includes('returning'));

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Jobs</h1>
          <p className="mt-1 text-sm text-gray-500">
            {pagination.total} jobs{timeFilter !== 'all' ? ` \u2014 showing ${filteredCount}` : ' \u2014 confirmed and active'}
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

      {/* Search + Filters */}
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
        <select
          value={timeFilter}
          onChange={(e) => setTimeFilter(e.target.value as TimeFilter)}
          className="rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        >
          {TIME_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Sync info bar */}
      {syncing && (
        <div className="mt-4 bg-ooosh-50 border border-ooosh-200 rounded-lg px-4 py-3 text-sm text-ooosh-700">
          Syncing jobs from HireHop... This may take a few minutes.
        </div>
      )}

      {loading ? (
        <div className="mt-8 text-center text-sm text-gray-500">Loading...</div>
      ) : jobs.length === 0 ? (
        <div className="mt-8 text-center text-sm text-gray-500">No jobs found.</div>
      ) : (
        <div className="mt-6 space-y-6">
          {/* ═══════ TODAY'S ACTIVITY (Going Out + Returning) ═══════ */}
          {(goingOut.length > 0 || returning.length > 0) && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Today&apos;s Activity</h2>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                  {goingOut.length + returning.length}
                </span>
              </div>

              <div className="bg-white rounded-xl shadow-md border border-green-200 border-l-4 border-l-green-500 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    {renderTableHeader()}
                    <tbody className="bg-white divide-y divide-gray-100">
                      {/* Going Out */}
                      {goingOut.length > 0 && (
                        <>
                          <tr>
                            <td colSpan={8} className="px-4 py-2 bg-orange-50">
                              <span className="text-xs font-semibold text-orange-700 uppercase tracking-wide">
                                Going Out ({goingOut.length})
                              </span>
                            </td>
                          </tr>
                          {goingOut.map((h: HappeningJob) =>
                            renderJobRow(h.job, true, happeningLabel(h.categories))
                          )}
                        </>
                      )}

                      {/* Returning */}
                      {returning.length > 0 && (
                        <>
                          <tr>
                            <td colSpan={8} className="px-4 py-2 bg-teal-50">
                              <span className="text-xs font-semibold text-teal-700 uppercase tracking-wide">
                                Returning ({returning.length})
                              </span>
                            </td>
                          </tr>
                          {returning.map((h: HappeningJob) =>
                            renderJobRow(h.job, true, happeningLabel(h.categories))
                          )}
                        </>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ═══════ OUT NOW (separate group) ═══════ */}
          {currentlyOut.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-2 h-2 rounded-full bg-indigo-500" />
                <h2 className="text-sm font-bold text-gray-900 uppercase tracking-wide">Out Now</h2>
                <span className="text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                  {currentlyOut.length}
                </span>
              </div>

              <div className="bg-white rounded-xl shadow-md border border-indigo-200 border-l-4 border-l-indigo-500 overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-gray-200">
                    {renderTableHeader()}
                    <tbody className="bg-white divide-y divide-gray-100">
                      {currentlyOut.map((h: HappeningJob) =>
                        renderJobRow(h.job, true, happeningLabel(h.categories))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ═══════ REGULAR SECTIONS ═══════ */}
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
                      {renderTableHeader()}
                      <tbody className="bg-white divide-y divide-gray-200">
                        {sectionJobs.map((job) => renderJobRow(job, true))}
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
