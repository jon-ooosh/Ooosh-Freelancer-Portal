/**
 * BacklinePage — Operations > Backline
 *
 * Warehouse-facing overview of backline prep across all upcoming jobs.
 * Shows aggregate stats + per-job breakdown for going out and returning.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';

interface BacklineJob {
  id: string;
  reqId: string;
  jobName: string;
  hhJobNumber: number | null;
  jobDate?: string;
  returnDate?: string;
  client: string;
  pipelineStatus: string;
  hhStatus: number;
  backlineStatus: string;
  itemCount: number;
  prepTimeMins: number;
  deprepTimeMins: number;
  effectivelyDone: boolean;
  hasMismatch: boolean;
  mismatchDetail: string | null;
  daysOverdue?: number;
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
  remainingPrepMins?: number;
  remainingDeprepMins?: number;
}

interface UnconfirmedBucket {
  stats: BacklineStats;
  jobs: BacklineJob[];
}

interface BacklineOverview {
  goingOut: { stats: BacklineStats; jobs: BacklineJob[] };
  returning: { stats: BacklineStats; jobs: BacklineJob[] };
  overdueOut?: { stats: BacklineStats; jobs: BacklineJob[] };
  overdueReturning?: { stats: BacklineStats; jobs: BacklineJob[] };
  unconfirmed?: {
    provisional: UnconfirmedBucket | null;
    enquiry: UnconfirmedBucket | null;
  };
}

const STATUS_CONFIG: Record<string, { label: string; colour: string; bg: string; dot: string }> = {
  not_started: { label: 'Not Started', colour: 'text-gray-700', bg: 'bg-gray-100', dot: 'bg-gray-400' },
  in_progress: { label: 'Working On It', colour: 'text-amber-700', bg: 'bg-amber-100', dot: 'bg-amber-400' },
  done:        { label: 'Done', colour: 'text-green-700', bg: 'bg-green-100', dot: 'bg-green-500' },
  blocked:     { label: 'Problem', colour: 'text-red-700', bg: 'bg-red-100', dot: 'bg-red-500' },
};

const STATUS_ORDER: string[] = ['not_started', 'in_progress', 'done', 'blocked'];

// 'outstanding' = anything still on the to-do pile (not_started + in_progress + blocked).
// Default view — once a job's done, the warehouse doesn't need it cluttering the list.
type StatusFilter = 'outstanding' | 'all' | 'not_started' | 'in_progress' | 'done' | 'blocked';

const PERIOD_OPTIONS = [
  { value: 2, label: 'Today & Tomorrow' },
  { value: 7, label: 'Next 7 Days' },
  { value: 14, label: 'Next 14 Days' },
];

/** Round up to nearest 5 mins — used on per-job rows */
function formatTimeJob(mins: number): string {
  if (mins === 0) return '—';
  const rounded = Math.ceil(mins / 5) * 5;
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Round up to nearest 15 mins — used on overview/summary cards */
function formatTimeOverview(mins: number): string {
  if (mins === 0) return '—';
  const rounded = Math.ceil(mins / 15) * 15;
  if (rounded < 60) return `${rounded}m`;
  const h = Math.floor(rounded / 60);
  const m = rounded % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

export default function BacklinePage() {
  const [data, setData] = useState<BacklineOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [days, setDays] = useState(7);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('outstanding');
  const [direction, setDirection] = useState<'both' | 'out' | 'return'>('both');
  const [search, setSearch] = useState('');
  // Heads-up planning toggles — surface speculative work alongside operational
  // prep so the warehouse can flag capacity issues to the office before
  // anything's confirmed. Stats panels stay scoped to operational; unconfirmed
  // buckets render separately below the main lists.
  const [showProvisional, setShowProvisional] = useState(false);
  const [showEnquiry, setShowEnquiry] = useState(false);
  const navigate = useNavigate();

  function matchesSearch(j: BacklineJob): boolean {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    return (
      (j.jobName || '').toLowerCase().includes(q)
      || (j.client || '').toLowerCase().includes(q)
      || String(j.hhJobNumber || '').includes(q)
    );
  }

  function loadData() {
    setLoading(true);
    const params = new URLSearchParams({ days: String(days) });
    if (showProvisional) params.set('include_provisional', 'true');
    if (showEnquiry) params.set('include_enquiry', 'true');
    api.get<{ data: BacklineOverview }>(`/backline/overview?${params.toString()}`)
      .then(d => setData(d.data))
      .catch(err => console.error('Failed to load backline overview:', err))
      .finally(() => setLoading(false));
  }

  useEffect(() => { loadData(); }, [days, showProvisional, showEnquiry]);

  async function syncNow() {
    setSyncing(true);
    try {
      // Trigger full HH job sync (fetches items + re-derives requirements)
      await api.post('/hirehop/jobs/sync', {});
      // Reload backline data after sync completes
      loadData();
    } catch {
      loadData();
    } finally {
      setSyncing(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-ooosh-600" />
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-center text-gray-500">Failed to load backline data.</div>;
  }

  const { goingOut, returning, overdueOut, overdueReturning, unconfirmed } = data;

  // Apply status filter — "done" includes effectivelyDone (HH prepped/dispatched).
  // "outstanding" is the default — hides done jobs so staff see only what's left to action.
  function matchesStatusFilter(j: BacklineJob): boolean {
    if (statusFilter === 'all') return true;
    if (statusFilter === 'outstanding') return !j.effectivelyDone && j.backlineStatus !== 'done';
    if (statusFilter === 'done') return j.effectivelyDone;
    if (statusFilter === 'not_started') return j.backlineStatus === 'not_started' && !j.effectivelyDone;
    return j.backlineStatus === statusFilter;
  }
  const filteredOut = goingOut.jobs.filter(j => matchesStatusFilter(j) && matchesSearch(j));
  const filteredReturn = returning.jobs.filter(j => matchesStatusFilter(j) && matchesSearch(j));
  const filteredOverdueOut = (overdueOut?.jobs || []).filter(j => matchesStatusFilter(j) && matchesSearch(j));
  const filteredOverdueReturn = (overdueReturning?.jobs || []).filter(j => matchesStatusFilter(j) && matchesSearch(j));
  const filteredProvisional = (unconfirmed?.provisional?.jobs || []).filter(j => matchesStatusFilter(j) && matchesSearch(j));
  const filteredEnquiry = (unconfirmed?.enquiry?.jobs || []).filter(j => matchesStatusFilter(j) && matchesSearch(j));

  async function updateStatus(reqId: string, newStatus: string) {
    try {
      await api.patch(`/backline/status/${reqId}`, { status: newStatus });
      // Update local state
      setData(prev => {
        if (!prev) return prev;
        const update = (jobs: BacklineJob[]) =>
          jobs.map(j => j.reqId === reqId ? { ...j, backlineStatus: newStatus } : j);
        const updatedOut = update(prev.goingOut.jobs);
        const updatedReturn = update(prev.returning.jobs);
        const updatedOverdueOut = prev.overdueOut ? update(prev.overdueOut.jobs) : undefined;
        const updatedOverdueReturn = prev.overdueReturning ? update(prev.overdueReturning.jobs) : undefined;
        return {
          goingOut: { stats: recalcStats(updatedOut), jobs: updatedOut },
          returning: { stats: recalcStats(updatedReturn), jobs: updatedReturn },
          overdueOut: updatedOverdueOut
            ? { stats: recalcStats(updatedOverdueOut), jobs: updatedOverdueOut }
            : prev.overdueOut,
          overdueReturning: updatedOverdueReturn
            ? { stats: recalcStats(updatedOverdueReturn), jobs: updatedOverdueReturn }
            : prev.overdueReturning,
        };
      });
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  function recalcStats(jobs: BacklineJob[]): BacklineStats {
    return {
      jobCount: jobs.length,
      notStarted: jobs.filter(j => j.backlineStatus === 'not_started' && !j.effectivelyDone).length,
      inProgress: jobs.filter(j => j.backlineStatus === 'in_progress').length,
      done: jobs.filter(j => j.effectivelyDone).length,
      problem: jobs.filter(j => j.backlineStatus === 'blocked').length,
      totalItems: jobs.reduce((s, j) => s + j.itemCount, 0),
      totalPrepMins: jobs.reduce((s, j) => s + j.prepTimeMins, 0),
      totalDeprepMins: jobs.reduce((s, j) => s + j.deprepTimeMins, 0),
      remainingPrepMins: jobs.filter(j => !j.effectivelyDone).reduce((s, j) => s + j.prepTimeMins, 0),
      remainingDeprepMins: jobs.filter(j => !j.effectivelyDone).reduce((s, j) => s + j.deprepTimeMins, 0),
    };
  }

  const outDonePercent = goingOut.stats.jobCount > 0
    ? Math.round(((goingOut.stats.done || 0) / goingOut.stats.jobCount) * 100)
    : 0;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Backline</h1>
          <p className="text-sm text-gray-500 mt-0.5">Prep and de-prep overview</p>
        </div>
        <button
          onClick={syncNow}
          disabled={syncing}
          className="px-3 py-1.5 text-xs font-medium bg-ooosh-600 text-white rounded-lg hover:bg-ooosh-700 disabled:opacity-50 transition-colors flex items-center gap-1.5 flex-shrink-0"
        >
          <svg className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {syncing ? 'Syncing...' : 'Sync'}
        </button>
      </div>

      {/* ── Row 1: Search (left, grow) + Heads-up chips (right) ── */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by job name, client, or job number…"
          className="flex-1 min-w-[240px] max-w-md border border-gray-300 rounded-lg px-4 py-2 text-sm focus:border-ooosh-500 focus:outline-none focus:ring-1 focus:ring-ooosh-500"
        />
        {/* Heads-up: include speculative jobs (separate sections, headline stats unaffected) */}
        <div className="flex bg-gray-100 rounded-lg p-0.5 ml-auto">
          <button
            onClick={() => setShowProvisional(v => !v)}
            title="Show jobs awaiting deposit (Provisional). Stats stay scoped to confirmed work."
            className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
              showProvisional ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showProvisional ? 'bg-blue-400' : 'bg-gray-300'}`} />
            Provisional
          </button>
          <button
            onClick={() => setShowEnquiry(v => !v)}
            title="Show enquiries (not yet provisional). Useful for flagging capacity issues to the office."
            className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
              showEnquiry ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${showEnquiry ? 'bg-purple-400' : 'bg-gray-300'}`} />
            Enquiries
          </button>
        </div>
      </div>

      {/* ── Row 2: Period + Direction + Status, all on one line ── */}
      <div className="flex flex-wrap gap-2">
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {PERIOD_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => setDays(opt.value)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                days === opt.value
                  ? 'bg-white text-gray-900 shadow-sm'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          {([['both', 'Both'], ['out', 'Going Out'], ['return', 'Coming Back']] as const).map(([val, lbl]) => (
            <button
              key={val}
              onClick={() => setDirection(val)}
              className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                direction === val ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex bg-gray-100 rounded-lg p-0.5">
          <button
            onClick={() => setStatusFilter('outstanding')}
            className={`px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              statusFilter === 'outstanding' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
            title="Hide jobs that are already done"
          >
            Outstanding
          </button>
          <button
            onClick={() => setStatusFilter('all')}
            className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors ${
              statusFilter === 'all' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            All
          </button>
          {STATUS_ORDER.map(s => {
            const sc = STATUS_CONFIG[s];
            return (
              <button
                key={s}
                onClick={() => setStatusFilter(statusFilter === s ? 'outstanding' : (s as StatusFilter))}
                className={`px-2 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1 whitespace-nowrap ${
                  statusFilter === s ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sc.dot}`} />
                {sc.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading && (
        <div className="text-center py-2 text-xs text-gray-400">Refreshing...</div>
      )}

      {/* ── Summary Cards ── */}
      <div className={`grid grid-cols-1 ${direction === 'both' ? 'md:grid-cols-2' : ''} gap-6`}>
        {/* Going Out */}
        {direction !== 'return' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-ooosh-100 flex items-center justify-center text-lg">📦</div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-gray-900">Going Out</h2>
              <p className="text-xs text-gray-400">Backline prep needed</p>
            </div>
          </div>

          {goingOut.stats.jobCount === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No backline going out</p>
          ) : (
            <>
              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-gray-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-gray-900">{goingOut.stats.jobCount}</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Jobs</div>
                </div>
                <div className="bg-purple-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-purple-700">{goingOut.stats.totalItems}</div>
                  <div className="text-[10px] text-purple-500 uppercase tracking-wider font-medium">Items</div>
                </div>
                <div className="bg-blue-50 rounded-lg p-3 text-center">
                  <div className="text-2xl font-bold text-blue-700">{formatTimeOverview(goingOut.stats.remainingPrepMins || 0)}</div>
                  <div className="text-[10px] text-blue-500 uppercase tracking-wider font-medium">Remaining</div>
                </div>
              </div>

              {/* Progress bar */}
              <div className="mb-3">
                <div className="flex items-center justify-between text-[10px] text-gray-500 mb-1">
                  <span>{outDonePercent}% complete</span>
                  <span>{goingOut.stats.done || 0}/{goingOut.stats.jobCount} done</span>
                </div>
                <div className="h-2 bg-gray-100 rounded-full overflow-hidden flex">
                  {(goingOut.stats.done || 0) > 0 && (
                    <div className="bg-green-500 transition-all" style={{ width: `${(goingOut.stats.done! / goingOut.stats.jobCount) * 100}%` }} />
                  )}
                  {(goingOut.stats.inProgress || 0) > 0 && (
                    <div className="bg-amber-400 transition-all" style={{ width: `${(goingOut.stats.inProgress! / goingOut.stats.jobCount) * 100}%` }} />
                  )}
                  {(goingOut.stats.problem || 0) > 0 && (
                    <div className="bg-red-500 transition-all" style={{ width: `${(goingOut.stats.problem! / goingOut.stats.jobCount) * 100}%` }} />
                  )}
                </div>
              </div>

              {/* Status breakdown pills */}
              <div className="flex gap-1.5 flex-wrap">
                {(goingOut.stats.notStarted || 0) > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-700 font-medium">
                    {goingOut.stats.notStarted} not started
                  </span>
                )}
                {(goingOut.stats.inProgress || 0) > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">
                    {goingOut.stats.inProgress} working on it
                  </span>
                )}
                {(goingOut.stats.done || 0) > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">
                    {goingOut.stats.done} done
                  </span>
                )}
                {(goingOut.stats.problem || 0) > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">
                    {goingOut.stats.problem} problem
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        )}

        {/* Coming Back */}
        {direction !== 'out' && (
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center text-lg">🔙</div>
            <div className="flex-1">
              <h2 className="text-base font-semibold text-gray-900">Coming Back</h2>
              <p className="text-xs text-gray-400">Backline de-prep needed</p>
            </div>
          </div>

          {returning.stats.jobCount === 0 ? (
            <p className="text-sm text-gray-400 py-4 text-center">No backline returns</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-gray-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-gray-900">{returning.stats.jobCount}</div>
                <div className="text-[10px] text-gray-500 uppercase tracking-wider font-medium">Jobs</div>
              </div>
              <div className="bg-purple-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-purple-700">{returning.stats.totalItems}</div>
                <div className="text-[10px] text-purple-500 uppercase tracking-wider font-medium">Items</div>
              </div>
              <div className="bg-blue-50 rounded-lg p-3 text-center">
                <div className="text-2xl font-bold text-blue-700">{formatTimeOverview(returning.stats.remainingDeprepMins || 0)}</div>
                <div className="text-[10px] text-blue-500 uppercase tracking-wider font-medium">Remaining</div>
              </div>
            </div>
          )}
        </div>
        )}
      </div>

      {/* ── Overdue — Going Out (red banner above main lists) ── */}
      {direction !== 'return' && filteredOverdueOut.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Overdue — Should Have Gone Out
            <span className="ml-1 text-xs font-normal text-red-500">
              ({filteredOverdueOut.length})
            </span>
          </h3>
          <div className="bg-red-50 rounded-xl border border-red-200 divide-y divide-red-200">
            {filteredOverdueOut.map(job => (
              <JobRow key={job.id} job={job} dateField="jobDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ── Overdue — Returning ── */}
      {direction !== 'out' && filteredOverdueReturn.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            Overdue — Should Be Back
            <span className="ml-1 text-xs font-normal text-red-500">
              ({filteredOverdueReturn.length})
            </span>
          </h3>
          <div className="bg-red-50 rounded-xl border border-red-200 divide-y divide-red-200">
            {filteredOverdueReturn.map(job => (
              <JobRow key={job.id} job={job} dateField="returnDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ── Going Out — Job List ── */}
      {direction !== 'return' && filteredOut.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Going Out</h3>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {filteredOut.map(job => (
              <JobRow key={job.id} job={job} dateField="jobDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ── Returning — Job List ── */}
      {direction !== 'out' && filteredReturn.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Coming Back</h3>
          <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
            {filteredReturn.map(job => (
              <JobRow key={job.id} job={job} dateField="returnDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ── Heads-up: Provisional ── */}
      {showProvisional && direction !== 'return' && filteredProvisional.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-blue-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            Provisional — Awaiting Deposit
            <span className="ml-1 text-xs font-normal text-blue-500">
              ({filteredProvisional.length})
            </span>
            <span className="ml-2 text-[10px] font-normal text-gray-500 italic">
              Not counted in headline stats — flag to office if capacity is tight
            </span>
          </h3>
          <div className="bg-blue-50/50 rounded-xl border border-blue-200 divide-y divide-blue-100">
            {filteredProvisional.map(job => (
              <JobRow key={job.id} job={job} dateField="jobDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {/* ── Heads-up: Enquiries ── */}
      {showEnquiry && direction !== 'return' && filteredEnquiry.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-purple-700 mb-2 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-400" />
            Enquiries — Speculative
            <span className="ml-1 text-xs font-normal text-purple-500">
              ({filteredEnquiry.length})
            </span>
            <span className="ml-2 text-[10px] font-normal text-gray-500 italic">
              Not counted in headline stats — many will not confirm
            </span>
          </h3>
          <div className="bg-purple-50/40 rounded-xl border border-purple-200 divide-y divide-purple-100">
            {filteredEnquiry.map(job => (
              <JobRow key={job.id} job={job} dateField="jobDate" navigate={navigate} onStatusChange={updateStatus} />
            ))}
          </div>
        </div>
      )}

      {filteredOut.length === 0 && filteredReturn.length === 0 && filteredOverdueOut.length === 0 && filteredOverdueReturn.length === 0 && (
        <div className="text-center py-12 text-gray-400">
          <span className="text-4xl mb-3 block">🎸</span>
          <p className="text-lg font-medium">
            {statusFilter === 'outstanding'
              ? 'Nothing outstanding — all caught up'
              : statusFilter !== 'all'
              ? 'No jobs match this filter'
              : 'All quiet on the backline front'}
          </p>
          <p className="text-sm">
            {statusFilter === 'outstanding'
              ? 'Switch to "All" to see jobs that are already done'
              : statusFilter !== 'all'
              ? 'Try a different status filter'
              : 'No backline prep or de-prep needed'}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Job Row ────────────────────────────────────────────────────────────

function JobRow({ job, dateField, navigate, onStatusChange }: {
  job: BacklineJob;
  dateField: 'jobDate' | 'returnDate';
  navigate: (path: string) => void;
  onStatusChange: (reqId: string, status: string) => void;
}) {
  const date = dateField === 'jobDate' ? job.jobDate : job.returnDate;
  const sl = job.effectivelyDone && job.backlineStatus !== 'done'
    ? { ...STATUS_CONFIG.done, label: 'Done (HH)' }  // HH says prepped/dispatched
    : (STATUS_CONFIG[job.backlineStatus] || STATUS_CONFIG.not_started);
  const timeMins = dateField === 'jobDate' ? job.prepTimeMins : job.deprepTimeMins;
  const hhPreppedButNotMarked = job.effectivelyDone && job.backlineStatus !== 'done';

  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [menuAbove, setMenuAbove] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    if (!showStatusMenu) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowStatusMenu(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showStatusMenu]);

  const hhDomain = 'myhirehop.com';

  const isOverdueRow = (job.daysOverdue ?? 0) > 0;
  return (
    <div
      className={`flex items-center justify-between px-4 py-3 transition-colors ${
        isOverdueRow ? 'bg-red-50 hover:bg-red-100'
        : job.hasMismatch ? 'bg-amber-50/50 hover:bg-amber-50'
        : 'hover:bg-gray-50'
      }`}
    >
      <div
        className="flex items-center gap-3 min-w-0 flex-1 cursor-pointer"
        onClick={() => navigate(`/jobs/${job.id}`)}
      >
        {/* Coloured side indicator */}
        <div className={`w-1 h-10 rounded-full flex-shrink-0 ${job.hasMismatch ? 'bg-amber-400' : sl.dot}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-900 truncate">{job.jobName || 'Untitled'}</span>
            {job.hhJobNumber && (
              <a
                href={`https://${hhDomain}/job.php?id=${job.hhJobNumber}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 border border-blue-200 font-medium hover:bg-blue-100 transition-colors"
                title="Open in HireHop"
              >
                #{job.hhJobNumber}
              </a>
            )}
          </div>
          <div className="flex items-center gap-2 text-xs text-gray-500 flex-wrap">
            <span>{job.client}</span>
            {date && <span>· {formatDate(date)}</span>}
            {job.daysOverdue !== undefined && job.daysOverdue > 0 && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">
                {job.daysOverdue}d overdue
              </span>
            )}
            {job.itemCount > 0 && (
              <span className="text-purple-600 font-medium">{job.itemCount} items</span>
            )}
            {timeMins > 0 && !job.effectivelyDone && (
              <span className="text-blue-600 font-medium">~{formatTimeJob(timeMins)}</span>
            )}
            {hhPreppedButNotMarked && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">HH: Prepped</span>
            )}
            {job.hasMismatch && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium" title={job.mismatchDetail || 'Items changed'}>
                ⚠ Items changed
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Status dropdown */}
      <div className="relative flex-shrink-0" ref={menuRef}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (!showStatusMenu && menuRef.current) {
              const rect = menuRef.current.getBoundingClientRect();
              setMenuAbove(rect.bottom + 160 > window.innerHeight);
            }
            setShowStatusMenu(!showStatusMenu);
          }}
          className={`text-xs px-2.5 py-1 rounded font-medium ${sl.bg} ${sl.colour} hover:opacity-80 transition-opacity cursor-pointer inline-flex items-center gap-1`}
        >
          {sl.label}
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {showStatusMenu && (
          <div className={`absolute right-0 w-40 bg-white rounded-lg shadow-lg border border-gray-200 z-20 py-1 ${menuAbove ? 'bottom-full mb-1' : 'mt-1'}`}>
            {STATUS_ORDER.map(s => {
              const sc = STATUS_CONFIG[s];
              return (
                <button
                  key={s}
                  onClick={(e) => {
                    e.stopPropagation();
                    onStatusChange(job.reqId, s);
                    setShowStatusMenu(false);
                  }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 flex items-center gap-2 ${job.backlineStatus === s ? 'font-bold' : ''}`}
                >
                  <span className={`w-2 h-2 rounded-full ${sc.dot}`} />
                  {sc.label}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
