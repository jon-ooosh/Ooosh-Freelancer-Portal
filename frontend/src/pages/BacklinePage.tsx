/**
 * BacklinePage — Operations > Backline
 *
 * Warehouse-facing overview of backline prep across all upcoming jobs.
 * Shows aggregate stats + per-job breakdown for going out and returning.
 */

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

interface BacklineJob {
  id: string;
  jobName: string;
  hhJobNumber: number | null;
  jobDate?: string;
  returnDate?: string;
  client: string;
  status: string;
  backlineStatus: string;
  itemCount: number;
  prepTimeMins?: number;
  deprepTimeMins?: number;
}

interface BacklineStats {
  jobCount: number;
  notStarted?: number;
  inProgress?: number;
  done?: number;
  problem?: number;
  totalItems: number;
  totalPrepMins?: number;
  totalDeprepMins?: number;
}

interface BacklineOverview {
  goingOut: { stats: BacklineStats; jobs: BacklineJob[] };
  returning: { stats: BacklineStats; jobs: BacklineJob[] };
}

const STATUS_LABELS: Record<string, { label: string; colour: string; bg: string }> = {
  not_started: { label: 'Not Started', colour: 'text-gray-700', bg: 'bg-gray-100' },
  in_progress: { label: 'Working On It', colour: 'text-amber-700', bg: 'bg-amber-100' },
  done:        { label: 'Done', colour: 'text-green-700', bg: 'bg-green-100' },
  blocked:     { label: 'Problem', colour: 'text-red-700', bg: 'bg-red-100' },
};

function formatTime(mins: number): string {
  if (mins === 0) return '0m';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function BacklinePage() {
  const [data, setData] = useState<BacklineOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    api.get<{ data: BacklineOverview }>('/backline/overview')
      .then(d => setData(d.data))
      .catch(err => console.error('Failed to load backline overview:', err))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-center text-gray-500">Failed to load backline data.</div>;
  }

  const { goingOut, returning } = data;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Backline</h1>
        <p className="text-sm text-gray-500 mt-1">Prep and de-prep overview for the next 7 days</p>
      </div>

      {/* ── Summary Cards ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Going Out */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-ooosh-100 flex items-center justify-center">
              <span className="text-xl">📦</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Going Out</h2>
              <p className="text-xs text-gray-500">Jobs with backline leaving next 7 days</p>
            </div>
          </div>
          {goingOut.stats.jobCount === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No backline jobs going out this week</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 mb-4">
                <StatCard label="Jobs" value={goingOut.stats.jobCount} />
                <StatCard label="Items" value={goingOut.stats.totalItems} subtitle={`~${goingOut.stats.totalItems} items`} />
                <StatCard label="Est. Prep" value={formatTime(goingOut.stats.totalPrepMins || 0)} />
              </div>
              <div className="flex gap-2 flex-wrap mb-4">
                {(goingOut.stats.notStarted || 0) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
                    {goingOut.stats.notStarted} not started
                  </span>
                )}
                {(goingOut.stats.inProgress || 0) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                    {goingOut.stats.inProgress} in progress
                  </span>
                )}
                {(goingOut.stats.done || 0) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                    {goingOut.stats.done} done
                  </span>
                )}
                {(goingOut.stats.problem || 0) > 0 && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                    {goingOut.stats.problem} problem
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Returning */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
              <span className="text-xl">🔙</span>
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Coming Back</h2>
              <p className="text-xs text-gray-500">Jobs with backline returning next 7 days</p>
            </div>
          </div>
          {returning.stats.jobCount === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No backline returns this week</p>
          ) : (
            <div className="grid grid-cols-3 gap-3 mb-4">
              <StatCard label="Jobs" value={returning.stats.jobCount} />
              <StatCard label="Items" value={returning.stats.totalItems} subtitle={`~${returning.stats.totalItems} items`} />
              <StatCard label="Est. De-Prep" value={formatTime(returning.stats.totalDeprepMins || 0)} />
            </div>
          )}
        </div>
      </div>

      {/* ── Going Out — Job List ── */}
      {goingOut.jobs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Going Out — Next 7 Days</h3>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {goingOut.jobs.map(job => (
              <JobRow key={job.id} job={job} dateField="jobDate" navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {/* ── Returning — Job List ── */}
      {returning.jobs.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-3">Coming Back — Next 7 Days</h3>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {returning.jobs.map(job => (
              <JobRow key={job.id} job={job} dateField="returnDate" navigate={navigate} />
            ))}
          </div>
        </div>
      )}

      {goingOut.stats.jobCount === 0 && returning.stats.jobCount === 0 && (
        <div className="text-center py-12 text-gray-400">
          <span className="text-4xl mb-3 block">🎸</span>
          <p className="text-lg font-medium">All quiet on the backline front</p>
          <p className="text-sm">No backline prep or de-prep needed in the next 7 days</p>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, subtitle }: { label: string; value: string | number; subtitle?: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <div className="text-2xl font-bold text-gray-900">{value}</div>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">{label}</div>
      {subtitle && <div className="text-[10px] text-gray-400">{subtitle}</div>}
    </div>
  );
}

function JobRow({ job, dateField, navigate }: { job: BacklineJob; dateField: 'jobDate' | 'returnDate'; navigate: (path: string) => void }) {
  const date = dateField === 'jobDate' ? job.jobDate : job.returnDate;
  const sl = STATUS_LABELS[job.backlineStatus] || STATUS_LABELS.not_started;
  const timeMins = dateField === 'jobDate' ? (job.prepTimeMins || 0) : (job.deprepTimeMins || 0);

  return (
    <div
      onClick={() => navigate(`/jobs/${job.id}`)}
      className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 cursor-pointer transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="text-lg flex-shrink-0">🎸</div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 truncate">{job.jobName || 'Untitled'}</span>
            {job.hhJobNumber && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-500 border border-blue-200 font-medium">
                #{job.hhJobNumber}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500">
            <span>{job.client}</span>
            {date && <span>· {formatDate(date)}</span>}
            {job.itemCount > 0 && <span>· {job.itemCount} items</span>}
            {timeMins > 0 && <span>· ~{formatTime(timeMins)}</span>}
          </div>
        </div>
      </div>
      <span className={`text-xs px-2.5 py-1 rounded font-medium ${sl.bg} ${sl.colour} flex-shrink-0`}>
        {sl.label}
      </span>
    </div>
  );
}
