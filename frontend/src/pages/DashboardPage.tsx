import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { useAuthStore } from '../hooks/useAuthStore';
import type { OperationsData, BacklineOverview, RecentActivity, TeamMember } from '../components/dashboard/types';
import { formatTimeAgo } from '../components/dashboard/helpers';
import TodaySchedule from '../components/dashboard/TodaySchedule';
import NeedsAttention from '../components/dashboard/NeedsAttention';
import ComingUpTimeline from '../components/dashboard/ComingUpTimeline';
import OperationsWidgets from '../components/dashboard/OperationsWidgets';
import PipelineSnapshot from '../components/dashboard/PipelineSnapshot';

const TODAY_STR = new Date().toLocaleDateString('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const [data, setData] = useState<OperationsData | null>(null);
  const [backline, setBackline] = useState<BacklineOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get<OperationsData>('/dashboard/operations').then(setData).catch(console.error),
      api.get<{ data: BacklineOverview }>('/backline/overview')
        .then(d => setBackline(d.data))
        .catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="text-center py-12 text-gray-500">Loading Command Centre...</div>;
  if (!data) return <div className="text-center py-12 text-gray-500">Failed to load dashboard.</div>;

  const sc = data.stat_cards;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Command Centre</h1>
          <p className="mt-1 text-sm text-gray-500">
            Good {getGreeting()}, {user?.first_name}. {TODAY_STR}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/pipeline/new" className="text-xs bg-ooosh-600 text-white px-3 py-1.5 rounded-lg hover:bg-ooosh-700 transition-colors font-medium">
            + New Enquiry
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="On Hire" value={sc.on_hire_count} color="bg-green-500" textColor="text-green-700" href="/jobs" />
        <StatCard label="Going Out" value={sc.going_out_count} color="bg-blue-500" textColor="text-blue-700" href="/jobs" />
        <StatCard label="Coming Back" value={sc.coming_back_count} color="bg-teal-500" textColor="text-teal-700" href="/jobs" />
        <StatCard
          label="Overdue"
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
          href="/pipeline"
          alert={parseInt(sc.chases_due_count) > 0}
        />
        <StatCard label="Open Enquiries" value={sc.open_enquiries_count} color="bg-purple-500" textColor="text-purple-700" href="/pipeline" />
      </div>

      {/* Today's Schedule */}
      <TodaySchedule
        goingOut={data.today.going_out}
        returning={data.today.returning}
        vehicleAssignments={data.today.vehicle_assignments}
        tomorrowGoingOut={data.tomorrow.going_out_count}
        tomorrowReturning={data.tomorrow.returning_count}
      />

      {/* Needs Attention */}
      <NeedsAttention
        overdueReturns={data.needs_attention.overdue_returns}
        chasesDue={data.needs_attention.chases_due}
        referralCount={data.needs_attention.referral_count}
        referrals={data.needs_attention.referrals}
        excessCount={data.needs_attention.excess_count}
        excessTotal={data.needs_attention.excess_total}
        excessItems={data.needs_attention.excess_items}
      />

      {/* Coming Up */}
      <ComingUpTimeline events={data.upcoming_events} />

      {/* Operations */}
      <OperationsWidgets
        transportOps={data.transport_ops}
        fleet={data.fleet}
        backline={backline}
      />

      {/* Pipeline & Sales */}
      <PipelineSnapshot
        byStatus={data.pipeline.by_status}
        activeValue={data.pipeline.active_value}
      />

      {/* Team & Activity */}
      <TeamAndActivity
        teamActivity={data.team_activity}
        recentActivity={data.recent_activity}
      />

      {/* Quick Actions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Quick Actions</span>
          <Link to="/pipeline/new" className="text-xs text-ooosh-600 hover:text-ooosh-700 font-medium flex items-center gap-1">
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

function TeamAndActivity({ teamActivity, recentActivity }: {
  teamActivity: TeamMember[];
  recentActivity: RecentActivity[];
}) {
  const TYPE_COLORS: Record<string, string> = {
    note: 'bg-blue-100 text-blue-700',
    call: 'bg-green-100 text-green-700',
    email: 'bg-purple-100 text-purple-700',
    meeting: 'bg-amber-100 text-amber-700',
  };
  const TYPE_ICONS: Record<string, string> = { note: 'N', call: 'C', email: 'E', meeting: 'M' };

  const entityLink = (item: RecentActivity) => {
    const id = item.person_id || item.organisation_id || item.venue_id;
    return id ? `/${item.entity_type}/${id}` : '#';
  };

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-200">
      <div className="px-5 py-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">Team & Activity</h2>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-gray-100">
        {/* Team This Week */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Team This Week</h3>
          {teamActivity.length === 0 ? (
            <p className="text-sm text-gray-400">No activity yet this week</p>
          ) : (
            <div className="space-y-3">
              {teamActivity.map((member) => (
                <div key={member.user_id} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full bg-ooosh-100 text-ooosh-700 flex items-center justify-center text-xs font-bold flex-shrink-0">
                    {member.name[0]?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900">{member.name}</div>
                    <div className="text-xs text-gray-500">
                      {parseInt(member.interaction_count) > 0
                        ? `${member.interaction_count} interaction${parseInt(member.interaction_count) !== 1 ? 's' : ''}`
                        : 'No activity'}
                    </div>
                  </div>
                  {parseInt(member.interaction_count) > 0 && (
                    <div className="w-12 h-1.5 bg-gray-100 rounded-full overflow-hidden flex-shrink-0">
                      <div
                        className="h-full bg-ooosh-400 rounded-full"
                        style={{ width: `${Math.min((parseInt(member.interaction_count) / Math.max(...teamActivity.map(m => parseInt(m.interaction_count)))) * 100, 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent Activity */}
        <div className="p-5">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Recent Activity</h3>
          {recentActivity.length === 0 ? (
            <p className="text-sm text-gray-400">No activity yet.</p>
          ) : (
            <div className="space-y-2">
              {recentActivity.slice(0, 8).map((item) => (
                <Link
                  key={item.id}
                  to={entityLink(item)}
                  className="flex items-start gap-2 hover:bg-gray-50 -mx-1 px-1 py-1 rounded transition-colors"
                >
                  <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0 mt-0.5 ${TYPE_COLORS[item.type] || 'bg-gray-100 text-gray-600'}`}>
                    {TYPE_ICONS[item.type] || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] text-gray-500">
                      <span className="font-medium text-gray-700">{item.created_by_name}</span>
                      {' '}{item.type}
                      {item.entity_name && <> on <span className="text-ooosh-600">{item.entity_name}</span></>}
                    </div>
                    <p className="text-xs text-gray-600 truncate">{item.content}</p>
                  </div>
                  <span className="text-[10px] text-gray-400 flex-shrink-0">{formatTimeAgo(item.created_at)}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
