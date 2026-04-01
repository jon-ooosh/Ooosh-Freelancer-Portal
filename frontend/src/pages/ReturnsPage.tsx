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

interface ReqProgress {
  total: number;
  done: number;
  blocked: number;
}

function formatDateRange(start: string | null, end: string | null): string {
  const fmt = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  if (start && end) return `${fmt(start)} - ${fmt(end)}`;
  if (start) return fmt(start);
  return '';
}

function daysAgo(dateStr: string): number {
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
}

export default function ReturnsPage() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [reqProgress, setReqProgress] = useState<Record<string, ReqProgress>>({});
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    loadJobs();
  }, []);

  // Load requirement progress for all displayed jobs
  useEffect(() => {
    if (jobs.length === 0) return;
    const jobIds = jobs.map(j => j.id);
    api.post<{ data: Record<string, ReqProgress> }>('/requirements/bulk', { job_ids: jobIds })
      .then(res => setReqProgress(res.data))
      .catch(() => {});
  }, [jobs]);

  async function loadJobs() {
    setLoading(true);
    try {
      // Fetch returned + completed jobs
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
    const filtered = search
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

    // Sort checking-in by return date (most recent first)
    ci.sort((a, b) => {
      const da = a.return_date ? new Date(a.return_date).getTime() : 0;
      const db = b.return_date ? new Date(b.return_date).getTime() : 0;
      return db - da;
    });

    // Sort completed by most recent first
    comp.sort((a, b) => {
      const da = a.return_date ? new Date(a.return_date).getTime() : 0;
      const db = b.return_date ? new Date(b.return_date).getTime() : 0;
      return db - da;
    });

    return { checkingIn: ci, completed: comp };
  }, [jobs, search]);

  function ProgressBar({ jobId }: { jobId: string }) {
    const p = reqProgress[jobId];
    if (!p || p.total === 0) return null;
    const pct = Math.round((p.done / p.total) * 100);
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 bg-gray-200 rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${p.blocked > 0 ? 'bg-red-400' : pct === 100 ? 'bg-green-500' : 'bg-ooosh-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="text-[10px] text-gray-500 shrink-0">{p.done}/{p.total}</span>
      </div>
    );
  }

  function JobRow({ job }: { job: Job }) {
    const returnDays = job.return_date ? daysAgo(job.return_date) : null;

    return (
      <Link
        to={`/jobs/${job.id}`}
        className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-ooosh-300 hover:shadow-sm transition-all"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              {job.hh_job_number ? (
                <span className="font-mono text-sm text-gray-500">J-{job.hh_job_number}</span>
              ) : (
                <span className="text-xs text-gray-400">NEW</span>
              )}
              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOURS[job.status] || 'bg-gray-100 text-gray-600'}`}>
                {STATUS_MAP[job.status] || job.status_name || `Status ${job.status}`}
              </span>
              {returnDays !== null && returnDays > 0 && job.status !== 11 && (
                <span className={`text-xs ${returnDays > 7 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                  Returned {returnDays}d ago
                </span>
              )}
            </div>
            <h3 className="font-medium text-gray-900 truncate">{job.job_name || 'Untitled Job'}</h3>
            <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
              <span>{job.client_name || job.company_name || 'No client'}</span>
              {job.job_date && (
                <span className="text-gray-400">{formatDateRange(job.job_date, job.job_end)}</span>
              )}
            </div>
            <div className="mt-2">
              <ProgressBar jobId={job.id} />
            </div>
          </div>
          {job.manager1_name && (
            <span className="text-xs text-gray-400 shrink-0">{job.manager1_name}</span>
          )}
        </div>
      </Link>
    );
  }

  if (loading) {
    return <div className="text-center py-12 text-gray-500">Loading returns...</div>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Returns</h1>
          <p className="text-sm text-gray-500 mt-1">
            {checkingIn.length} checking in - {completed.length} completed
          </p>
        </div>
      </div>

      {/* Search */}
      <div className="mb-6">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by job name, client, or job number..."
          className="w-full max-w-md border border-gray-300 rounded-lg px-4 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
      </div>

      {/* Checking In Section */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-1 h-6 bg-amber-500 rounded-full" />
          <h2 className="text-lg font-semibold text-gray-900">Checking In</h2>
          <span className="text-sm text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{checkingIn.length}</span>
        </div>

        {checkingIn.length === 0 ? (
          <div className="text-center py-8 text-gray-400 bg-gray-50 rounded-lg border border-dashed border-gray-200">
            Nothing to check in right now
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
            {completed.length} completed jobs - click Show to view
          </div>
        )}
      </div>
    </div>
  );
}
