import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { OperationsData, BacklineOverview, ReturnsOverview } from '../components/dashboard/types';
import TodaySchedule from '../components/dashboard/TodaySchedule';
import NeedsAttention from '../components/dashboard/NeedsAttention';
import ComingUpTimeline from '../components/dashboard/ComingUpTimeline';
import OperationsWidgets from '../components/dashboard/OperationsWidgets';
import PipelineSnapshot from '../components/dashboard/PipelineSnapshot';
import ReturnsOverviewWidget from '../components/dashboard/ReturnsOverviewWidget';

function getDateStr() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

function formatLastRefresh(d: Date): string {
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Collapsed state persistence
function getCollapsed(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem('dashboard_collapsed') || '{}');
  } catch { return {}; }
}
function setCollapsedStorage(v: Record<string, boolean>) {
  localStorage.setItem('dashboard_collapsed', JSON.stringify(v));
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<OperationsData | null>(null);
  const [backline, setBackline] = useState<BacklineOverview | null>(null);
  const [returnsOverview, setReturnsOverview] = useState<ReturnsOverview | null>(null);
  const [cancellationsOverview, setCancellationsOverview] = useState<{
    counts: { total_cancelled: number; pending_refunds: number; total_refund_due: number; total_fees_retained: number };
    outstanding: Array<{ type: string; outstanding: number }>;
    recent: Array<{ id: string; hh_job_number: number | null; job_name: string | null; cancelled_at: string; cancellation_fee: string; cancellation_refund: string; cancellation_reason: string }>;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [, setTick] = useState(0); // force re-render for "X min ago"
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(getCollapsed);
  const loadedDateRef = useRef<string>(new Date().toDateString());

  const loadData = useCallback(async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const [opsData, blData, retData, cancelData] = await Promise.all([
        api.get<OperationsData>('/dashboard/operations'),
        api.get<{ data: BacklineOverview }>('/backline/overview').catch(() => null),
        api.get<ReturnsOverview>('/dashboard/returns-overview').catch(() => null),
        api.get<typeof cancellationsOverview>('/dashboard/cancellations-overview').catch(() => null),
      ]);
      setData(opsData);
      if (blData) setBackline(blData.data);
      if (retData) setReturnsOverview(retData);
      if (cancelData) setCancellationsOverview(cancelData);
      setLastRefresh(new Date());
      loadedDateRef.current = new Date().toDateString();
    } catch (err) {
      console.error('Dashboard load failed:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => { loadData(); }, [loadData]);

  // Auto-refresh: check every minute — if the date has changed (i.e. it's past midnight / 7am),
  // or if data is stale (loaded on a different day), refresh automatically
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1); // update "X min ago" display
      const now = new Date();
      const currentDateStr = now.toDateString();
      // If we loaded data on a different day, auto-refresh
      if (loadedDateRef.current !== currentDateStr) {
        loadData();
      }
    }, 60_000); // every minute
    return () => clearInterval(interval);
  }, [loadData]);

  // Also auto-refresh if tab becomes visible after being hidden (user switches back)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const now = new Date();
        // Refresh if data is from a different day OR more than 5 minutes old
        if (
          loadedDateRef.current !== now.toDateString() ||
          (lastRefresh && now.getTime() - lastRefresh.getTime() > 5 * 60_000)
        ) {
          loadData();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [loadData, lastRefresh]);

  const toggleCollapse = (key: string) => {
    setCollapsed(prev => {
      const next = { ...prev, [key]: !prev[key] };
      setCollapsedStorage(next);
      return next;
    });
  };

  if (loading) return <div className="text-center py-12 text-gray-500">Loading Command Centre...</div>;
  if (!data) return <div className="text-center py-12 text-gray-500">Failed to load dashboard.</div>;

  const sc = data.stat_cards;
  const todayKey = new Date().toISOString().split('T')[0];
  const tomorrowKey = new Date(Date.now() + 86400000).toISOString().split('T')[0];
  const todayPrep = data.prep_estimates?.[todayKey];
  const tomorrowPrep = data.prep_estimates?.[tomorrowKey];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Command Centre</h1>
          <p className="mt-1 text-sm text-gray-500">
            Good {getGreeting()}, {user?.first_name}. {getDateStr()}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastRefresh && (
            <span className="text-[11px] text-gray-400">
              Updated {formatLastRefresh(lastRefresh)}
            </span>
          )}
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="text-xs text-gray-500 hover:text-gray-700 border border-gray-200 px-2 py-1 rounded hover:bg-gray-50 disabled:opacity-50 transition-colors"
            title="Refresh dashboard"
          >
            <svg className={`w-3.5 h-3.5 inline mr-1 ${refreshing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
          <Link to="/pipeline?newEnquiry=1" className="text-xs bg-ooosh-600 text-white px-3 py-1.5 rounded-lg hover:bg-ooosh-700 transition-colors font-medium">
            + New Enquiry
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="On Hire" value={sc.on_hire_count} color="bg-green-500" textColor="text-green-700" href="/jobs?status=4,5" />
        <StatCard label="Going Out" value={sc.going_out_count} color="bg-blue-500" textColor="text-blue-700" href="/jobs?status=2,3" />
        <StatCard label="Coming Back" value={sc.coming_back_count} color="bg-teal-500" textColor="text-teal-700" href="/jobs/returns" />
        <StatCard
          label="Overdue Returns"
          value={sc.overdue_count}
          color="bg-red-500"
          textColor="text-red-700"
          href="/jobs/returns"
          alert={parseInt(sc.overdue_count) > 0}
        />
        <StatCard
          label="Chases Due"
          value={sc.chases_due_count}
          color="bg-amber-500"
          textColor="text-amber-700"
          href="/pipeline?chase=overdue"
          alert={parseInt(sc.chases_due_count) > 0}
        />
        <StatCard label="Open Enquiries" value={sc.open_enquiries_count} color="bg-purple-500" textColor="text-purple-700" href="/pipeline" />
      </div>

      {/* Today's Schedule */}
      <Section id="schedule" collapsed={collapsed} toggle={toggleCollapse}>
        <TodaySchedule
          goingOut={data.today.going_out}
          returning={data.today.returning}
          vehicleAssignments={data.today.vehicle_assignments}
          tomorrowGoingOut={data.tomorrow.going_out_count}
          tomorrowReturning={data.tomorrow.returning_count}
        />
      </Section>

      {/* Needs Attention */}
      <NeedsAttention
        overdueReturns={data.needs_attention.overdue_returns}
        chasesDue={data.needs_attention.chases_due}
        referralCount={data.needs_attention.referral_count}
        referrals={data.needs_attention.referrals}
        excessCount={data.needs_attention.excess_count}
        excessTotal={data.needs_attention.excess_total}
        excessItems={data.needs_attention.excess_items}
        fleetAlerts={{
          mot: parseInt(data.fleet.mot_due_soon) || 0,
          insurance: parseInt(data.fleet.insurance_due_soon) || 0,
          tax: parseInt(data.fleet.tax_due_soon) || 0,
        }}
      />

      {/* Returns & Close-Out */}
      {returnsOverview && (returnsOverview.counts.active_returns > 0 || returnsOverview.counts.overdue > 0) && (
        <Section id="returns" collapsed={collapsed} toggle={toggleCollapse}>
          <ReturnsOverviewWidget data={returnsOverview} />
        </Section>
      )}

      {/* Cancellations */}
      {cancellationsOverview && (cancellationsOverview.counts.pending_refunds > 0 || cancellationsOverview.outstanding.length > 0) && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900">Cancellations</h3>
            <Link to="/jobs/lost-cancelled" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium">
              View all &rarr;
            </Link>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            <div className="bg-red-50 rounded-lg p-2.5 text-center">
              <p className="text-lg font-bold text-red-700">{cancellationsOverview.counts.total_cancelled}</p>
              <p className="text-xs text-red-600">Cancelled</p>
            </div>
            {cancellationsOverview.counts.pending_refunds > 0 && (
              <div className="bg-amber-50 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold text-amber-700">{cancellationsOverview.counts.pending_refunds}</p>
                <p className="text-xs text-amber-600">Refunds pending</p>
              </div>
            )}
            {cancellationsOverview.counts.total_refund_due > 0 && (
              <div className="bg-amber-50 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold text-amber-700">
                  {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(cancellationsOverview.counts.total_refund_due)}
                </p>
                <p className="text-xs text-amber-600">Refund total</p>
              </div>
            )}
            {cancellationsOverview.counts.total_fees_retained > 0 && (
              <div className="bg-green-50 rounded-lg p-2.5 text-center">
                <p className="text-lg font-bold text-green-700">
                  {new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(cancellationsOverview.counts.total_fees_retained)}
                </p>
                <p className="text-xs text-green-600">Fees retained</p>
              </div>
            )}
          </div>
          {cancellationsOverview.outstanding.length > 0 && (
            <div className="text-xs text-gray-600">
              <span className="font-medium">Outstanding:</span>{' '}
              {cancellationsOverview.outstanding.map(o => {
                const labels: Record<string, string> = {
                  invoice: 'Invoices', payment_reconcile: 'Refunds', client_followup: 'Client follow-ups', excess_resolve: 'Excess'
                };
                return `${o.outstanding} ${labels[o.type] || o.type}`;
              }).join(', ')}
            </div>
          )}
        </div>
      )}

      {/* Operations */}
      <Section id="operations" collapsed={collapsed} toggle={toggleCollapse}>
        <OperationsWidgets
          transportOps={data.transport_ops}
          fleet={data.fleet}
          backline={backline}
          todayPrep={todayPrep}
          tomorrowPrep={tomorrowPrep}
        />
      </Section>

      {/* Who's In */}
      <WhosInPlaceholder />

      {/* Coming Up */}
      <Section id="coming_up" collapsed={collapsed} toggle={toggleCollapse}>
        <ComingUpTimeline events={data.upcoming_events} />
      </Section>

      {/* Pipeline & Sales */}
      <Section id="pipeline" collapsed={collapsed} toggle={toggleCollapse}>
        <PipelineSnapshot
          byStatus={data.pipeline.by_status}
          activeValue={data.pipeline.active_value}
        />
      </Section>

      {/* Quick Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Quick Actions</span>
          <Link to="/pipeline?newEnquiry=1" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium flex items-center gap-1">
            <span className="w-4 h-4 rounded bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-[10px] font-bold">+</span>
            New Enquiry
          </Link>
          <Link to="/people" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium flex items-center gap-1">
            <span className="w-4 h-4 rounded bg-blue-100 text-blue-700 flex items-center justify-center text-[10px] font-bold">+</span>
            Person
          </Link>
          <Link to="/organisations" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium flex items-center gap-1">
            <span className="w-4 h-4 rounded bg-purple-100 text-purple-700 flex items-center justify-center text-[10px] font-bold">+</span>
            Organisation
          </Link>
          <Link to="/venues" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium flex items-center gap-1">
            <span className="w-4 h-4 rounded bg-teal-100 text-teal-700 flex items-center justify-center text-[10px] font-bold">+</span>
            Venue
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────────── */

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function StatCard({ label, value, color, textColor, href, alert }: {
  label: string;
  value: string;
  color: string;
  textColor: string;
  href?: string;
  alert?: boolean;
}) {
  const inner = (
    <div className={`bg-white rounded-xl shadow-sm border ${alert ? 'border-red-200' : 'border-gray-200'} p-4 ${href ? 'hover:border-gray-300 transition-colors' : ''}`}>
      <div className="flex items-center gap-3">
        <div className={`w-2 h-8 rounded-full ${color}`} />
        <div>
          <div className={`text-2xl font-bold ${alert ? 'text-red-600' : 'text-gray-900'}`}>{value}</div>
          <div className={`text-xs ${alert ? textColor : 'text-gray-500'}`}>{label}</div>
        </div>
      </div>
    </div>
  );
  if (href) return <Link to={href}>{inner}</Link>;
  return inner;
}

function Section({ id, collapsed, toggle, children }: {
  id: string;
  collapsed: Record<string, boolean>;
  toggle: (key: string) => void;
  children: React.ReactNode;
}) {
  const isCollapsed = collapsed[id] || false;
  return (
    <div>
      {isCollapsed ? (
        <button
          onClick={() => toggle(id)}
          className="w-full flex items-center gap-2 py-2 group"
        >
          <svg className="w-3 h-3 text-gray-400 -rotate-90" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
          </svg>
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider group-hover:text-gray-500 transition-colors">{id.replace(/_/g, ' ')}</span>
          <div className="flex-1 border-t border-gray-100" />
        </button>
      ) : (
        <div className="relative">
          <button
            onClick={() => toggle(id)}
            className="absolute -left-2 top-5 z-10 w-5 h-5 flex items-center justify-center text-gray-300 hover:text-gray-500 transition-colors"
            title={`Collapse ${id.replace(/_/g, ' ')}`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
          {children}
        </div>
      )}
    </div>
  );
}

function WhosInPlaceholder() {
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Who's In</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        <div className="p-5 opacity-60">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
            Today — {today}
            <span className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-normal normal-case">Coming Soon</span>
          </h3>
          <p className="text-xs text-gray-400">
            Staff calendar coming soon — will show who's working today, who's on leave, and who's available for last-minute jobs.
          </p>
        </div>
        <div className="p-5 opacity-60">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Tomorrow</h3>
          <p className="text-xs text-gray-400">
            Tomorrow's staffing will show here once the staff calendar is set up.
          </p>
        </div>
      </div>
    </div>
  );
}
