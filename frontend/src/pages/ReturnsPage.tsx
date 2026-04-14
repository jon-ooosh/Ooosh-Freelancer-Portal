import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
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

// Close-out item status → dot colour
const DOT_COLOUR: Record<string, string> = {
  done: 'bg-green-500',
  in_progress: 'bg-amber-400',
  blocked: 'bg-red-500',
  not_started: 'bg-gray-300',
};

// Close-out type → short label for filter pills
const CLOSEOUT_TYPE_LABELS: Record<string, string> = {
  vehicle: 'Check-In',
  backline: 'De-Prep',
  invoice: 'Invoice',
  payment_reconcile: 'Payment',
  excess_resolve: 'Excess',
  freelancer_followup: 'Freelancer',
  client_followup: 'Client',
  damage_review: 'Damage',
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

interface CloseoutItem {
  type: string;
  label: string;
  icon: string;
  status: string;
  custom_label: string | null;
}

interface CloseoutProgress {
  items: CloseoutItem[];
  total: number;
  done: number;
  blocked: number;
  in_progress: number;
}

function formatDateRange(start: string | null, end: string | null): string {
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (start && end && start !== end) return `${fmt(start)} – ${fmt(end)}`;
  if (start) return fmt(start);
  return '';
}

function daysAgo(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

type FilterType = 'all' | 'invoice' | 'damage_review' | 'excess_resolve' | 'freelancer_followup' | 'payment_reconcile';
type SortType = 'return_date' | 'days_out' | 'outstanding';

export default function ReturnsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [closeoutData, setCloseoutData] = useState<Record<string, CloseoutProgress>>({});
  const [showCompleted, setShowCompleted] = useState(false);
  const [filter, setFilter] = useState<FilterType>('all');
  const [sortBy, setSortBy] = useState<SortType>('return_date');

  useEffect(() => {
    loadJobs();
  }, []);

  useEffect(() => {
    if (jobs.length === 0) return;
    const jobIds = jobs.map(j => j.id);
    api.post<{ data: Record<string, CloseoutProgress> }>('/requirements/closeout-progress', { job_ids: jobIds })
      .then(res => setCloseoutData(res.data))
      .catch(() => {});
  }, [jobs]);

  async function loadJobs() {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '500', status: '6,7,8,11' });
      const data = await api.get<{ data: Job[] }>(`/hirehop/jobs?${params}`);
      setJobs(data.data);
    } catch (err) {
      console.error('Failed to load returns:', err);
    } finally {
      setLoading(false);
    }
  }

  const { checkingIn, completed } = useMemo(() => {
    let filtered = search
      ? jobs.filter(j =>
          (j.job_name || '').toLowerCase().includes(search.toLowerCase()) ||
          (j.client_name || '').toLowerCase().includes(search.toLowerCase()) ||
          (j.company_name || '').toLowerCase().includes(search.toLowerCase()) ||
          String(j.hh_job_number).includes(search)
        )
      : jobs;

    const ci: Job[] = [];
    const comp: Job[] = [];

    for (const job of filtered) {
      if (job.status === 11) {
        comp.push(job);
      } else if ([6, 7, 8].includes(job.status)) {
        ci.push(job);
      }
    }

    // Apply close-out filter
    const filteredCi = filter === 'all'
      ? ci
      : ci.filter(j => {
          const co = closeoutData[j.id];
          if (!co) return false;
          return co.items.some(item => item.type === filter && item.status !== 'done');
        });

    // Sort
    filteredCi.sort((a, b) => {
      if (sortBy === 'return_date') {
        const da = a.return_date ? new Date(a.return_date).getTime() : 0;
        const db = b.return_date ? new Date(b.return_date).getTime() : 0;
        return db - da;
      }
      if (sortBy === 'days_out') {
        const da = a.return_date ? daysAgo(a.return_date) : 0;
        const db = b.return_date ? daysAgo(b.return_date) : 0;
        return db - da; // most overdue first
      }
      if (sortBy === 'outstanding') {
        const coA = closeoutData[a.id];
        const coB = closeoutData[b.id];
        const outA = coA ? coA.total - coA.done : 0;
        const outB = coB ? coB.total - coB.done : 0;
        return outB - outA; // most outstanding first
      }
      return 0;
    });

    comp.sort((a, b) => {
      const da = a.return_date ? new Date(a.return_date).getTime() : 0;
      const db = b.return_date ? new Date(b.return_date).getTime() : 0;
      return db - da;
    });

    return { checkingIn: filteredCi, completed: comp };
  }, [jobs, search, closeoutData, filter, sortBy]);

  // Count jobs per filter
  const filterCounts = useMemo(() => {
    const counts: Record<FilterType, number> = {
      all: 0, invoice: 0, damage_review: 0, excess_resolve: 0,
      freelancer_followup: 0, payment_reconcile: 0,
    };
    for (const job of jobs) {
      if (job.status === 11) continue; // skip completed
      if (![6, 7, 8].includes(job.status)) continue;
      counts.all++;
      const co = closeoutData[job.id];
      if (!co) continue;
      for (const item of co.items) {
        if (item.status !== 'done' && item.type in counts) {
          counts[item.type as FilterType]++;
        }
      }
    }
    return counts;
  }, [jobs, closeoutData]);

  function CloseoutDots({ jobId }: { jobId: string }) {
    const co = closeoutData[jobId];
    if (!co || co.items.length === 0) return <span className="text-xs text-gray-400 italic">No close-out data</span>;

    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        {co.items.map((item, i) => (
          <span
            key={`${item.type}-${i}`}
            className="inline-flex items-center gap-1"
            title={`${item.custom_label || item.label}: ${item.status.replace('_', ' ')}`}
          >
            <span className={`w-2 h-2 rounded-full ${DOT_COLOUR[item.status] || DOT_COLOUR.not_started}`} />
            <span className={`text-[10px] ${item.status === 'done' ? 'text-gray-400' : item.status === 'blocked' ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
              {CLOSEOUT_TYPE_LABELS[item.type] || item.label}
            </span>
          </span>
        ))}
      </div>
    );
  }

  function JobRow({ job }: { job: Job }) {
    const returnDays = job.return_date ? daysAgo(job.return_date) : null;
    const co = closeoutData[job.id];
    const isOverdue = returnDays !== null && returnDays > 7 && job.status !== 11;
    const hasIssues = co && co.blocked > 0;

    return (
      <Link
        to={`/jobs/${job.id}`}
        state={{ from: '/jobs/returns' }}
        className={`block bg-white rounded-lg border p-4 hover:shadow-sm transition-all ${
          job.status === 8 ? 'border-red-300 bg-red-50/30' :
          hasIssues ? 'border-amber-200' :
          'border-gray-200 hover:border-ooosh-300'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
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
              {returnDays !== null && returnDays > 0 && job.status !== 11 && (
                <span className={`text-xs ${isOverdue ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                  {isOverdue ? `${returnDays}d overdue` : `Returned ${returnDays}d ago`}
                </span>
              )}
              {co && co.total > 0 && (
                <span className={`text-xs font-medium ${co.done === co.total ? 'text-green-600' : 'text-gray-500'}`}>
                  {co.done}/{co.total} done
                </span>
              )}
            </div>
            <h3 className="font-medium text-gray-900 truncate">{job.job_name || 'Untitled Job'}</h3>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              <span>{job.client_name || job.company_name || 'No client'}</span>
              {job.job_date && (
                <span className="text-gray-400">{formatDateRange(job.job_date, job.job_end)}</span>
              )}
              {job.job_value != null && job.job_value > 0 && (
                <span className="text-gray-400">&pound;{job.job_value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
              )}
            </div>
            <div className="mt-2">
              <CloseoutDots jobId={job.id} />
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

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading returns...</div>;
  }

  const FILTER_PILLS: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'invoice', label: 'Needs Invoice' },
    { key: 'payment_reconcile', label: 'Payment Due' },
    { key: 'excess_resolve', label: 'Excess Pending' },
    { key: 'damage_review', label: 'Damage Open' },
    { key: 'freelancer_followup', label: 'Freelancer' },
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Returns</h1>
          <p className="text-sm text-gray-500 mt-1">
            {checkingIn.length} active return{checkingIn.length !== 1 ? 's' : ''} &middot; {completed.length} completed
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortType)}
            className="text-xs border border-gray-300 rounded-lg px-2 py-1.5 text-gray-600 focus:border-ooosh-500 focus:ring-1 focus:ring-ooosh-500"
          >
            <option value="return_date">Sort: Return Date</option>
            <option value="days_out">Sort: Days Overdue</option>
            <option value="outstanding">Sort: Most Outstanding</option>
          </select>
        </div>
      </div>

      {/* Search */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by job name, client, or number..."
          className="w-full max-w-md border border-gray-300 rounded-lg px-4 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2 mb-6">
        {FILTER_PILLS.map(pill => {
          const count = filterCounts[pill.key];
          const isActive = filter === pill.key;
          return (
            <button
              key={pill.key}
              onClick={() => setFilter(pill.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-ooosh-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {pill.label}
              {pill.key !== 'all' && count > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  isActive ? 'bg-ooosh-500 text-white' : 'bg-gray-200 text-gray-700'
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Active Returns Section */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-amber-500 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-900">Active Returns</h2>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{checkingIn.length}</span>
        </div>

        {checkingIn.length === 0 ? (
          <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            {filter !== 'all' ? 'No jobs matching this filter' : 'Nothing to check in right now'}
          </div>
        ) : (
          <div className="space-y-3">
            {checkingIn.map(job => <JobRow key={job.id} job={job} />)}
          </div>
        )}
      </div>

      {/* Completed Section */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-emerald-500 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-900">Completed</h2>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{completed.length}</span>
          {completed.length > 0 && (
            <button
              onClick={() => setShowCompleted(!showCompleted)}
              className="text-xs text-ooosh-600 hover:text-ooosh-700 ml-2"
            >
              {showCompleted ? 'Hide' : 'Show'}
            </button>
          )}
        </div>

        {showCompleted && completed.length > 0 && (
          <div className="space-y-3">
            {completed.slice(0, 50).map(job => <JobRow key={job.id} job={job} />)}
            {completed.length > 50 && (
              <p className="text-sm text-gray-400 text-center py-2">Showing first 50 of {completed.length}</p>
            )}
          </div>
        )}

        {!showCompleted && completed.length > 0 && (
          <div className="text-center py-4 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            {completed.length} completed jobs &mdash; click Show to view
          </div>
        )}
      </div>
    </div>
  );
}
